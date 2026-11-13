"use strict";

/**
 * Default-off W1 Testnet adapter.
 * It can read the designated 0600 account file and open the XRPL Labs
 * socket only after the local gates pass. Tests inject readAccount,
 * openWallet, and connect. This module does not call those defaults
 * unless an operator activates it.
 */

const fs = require("fs");
const path = require("path");
const { coded } = require("../../missions/ledger");
const { assertNoHouseSeeds } = require("../../missions/runtime-guard");
const anchors = require("../../director/anchors");
const bounds = require("./bounds");
const signer = require("./signer");

const ROOT = path.resolve(__dirname, "../../..");
const WS = "wss://testnet.xrpl-labs.com";
const CONNECTION_TIMEOUT_MS = 20000;
const HOUSE_ENVS = ["W0_SEED", "W1_SEED", "W2_SEED", "W3_SEED", "W4_SEED", "W5_SEED", "W6_SEED", "W7_SEED"];
const NOT_FOUND_ERRORS = new Set(["txnNotFound", "entryNotFound", "actNotFound", "lgrNotFound"]);

function rippledCode(error) {
  const data = error && error.data;
  if (!data || typeof data !== "object") return null;
  const code = data.error || data.error_code;
  return typeof code === "string" ? code : null;
}

function notFoundResponse(error) {
  const code = rippledCode(error);
  if (!code || !NOT_FOUND_ERRORS.has(code)) return null;
  return { result: Object.assign({ status: "error" }, error.data, { error: code }) };
}

async function settledRequest(request, body) {
  try {
    return await request(body);
  } catch (error) {
    const found = notFoundResponse(error);
    if (found) return found;
    throw error;
  }
}

const ALLOWED_HOSTS = {
  "testnet.xrpl-labs.com": new Set([""]),
  "s.altnet.rippletest.net": new Set(["", "443", "51233"]),
  "clio.altnet.rippletest.net": new Set(["", "443", "51233"]),
};

function assertWs(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw coded("W1 dex websocket is not a URL", "HOST");
  }
  const ports = ALLOWED_HOSTS[url.hostname];
  if (url.username || url.password || url.protocol !== "wss:" || !ports || !ports.has(url.port)) {
    throw coded("W1 dex refuses that websocket", "HOST");
  }
  if (url.pathname !== "/" && url.pathname !== "") throw coded("W1 dex refuses that websocket", "HOST");
  return url.href.replace(/\/$/, "");
}

function websocketList(value) {
  const parts = String(value || WS).split(",").map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw coded("W1 dex websocket is not a URL", "HOST");
  return parts.map((item) => assertWs(item));
}

function assertFile(file) {
  const resolved = path.resolve(String(file || ""));
  if (!file || !path.isAbsolute(resolved)) throw coded("W1 account file must be an absolute path", "ISOLATED");
  if (resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`) || resolved.startsWith("/workspace/aether-foundry/")) {
    throw coded("refusing an account file inside the checkout", "ISOLATED");
  }
  return resolved;
}

function readRoleAccount(file, account) {
  const w1 = account === bounds.ACCOUNT;
  const resolved = assertFile(file);
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ENOENT") throw coded(w1 ? "W1 account file is missing" : "role account file is missing", "AUTH");
    throw coded(w1 ? "W1 account file cannot be read" : "role account file cannot be read", "AUTH");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw coded(w1 ? "W1 account file must be mode 0600" : "role account file must be mode 0600", "AUTH");
    }
    const body = JSON.parse(fs.readFileSync(fd, "utf8"));
    const xrpl = require("xrpl");
    if (!body || body.account !== account || body.account === anchors.WALLETS.W0.address) {
      throw coded(w1 ? "W1 regular-key file must name the W1 account" : "role key file must name its account", "WALLET");
    }
    if (body.regular_key === account || body.regular_key === anchors.WALLETS.W0.address || !xrpl.isValidClassicAddress(body.regular_key || "")) {
      throw coded(w1 ? "refusing a master key as the W1 signer" : "refusing a master key", "MASTER_KEY");
    }
    if (typeof body.seed !== "string" || body.seed.length < 8) throw coded(w1 ? "W1 regular-key file is missing its seed" : "role key file is missing its seed", "WALLET");
    return { account: body.account, regular_key: body.regular_key, seed: body.seed };
  } finally {
    fs.closeSync(fd);
  }
}

function readPrivateW1(file) {
  return readRoleAccount(file, bounds.ACCOUNT);
}

function health(env) {
  const source = env || {};
  let accountFile = "unset";
  if (source.FOUNDRY_W1_DEX_ACCOUNT_FILE) {
    try {
      const stat = fs.lstatSync(assertFile(source.FOUNDRY_W1_DEX_ACCOUNT_FILE));
      if (stat.isSymbolicLink()) accountFile = "symlink";
      else if (stat.isFile() && (stat.mode & 0o777) === 0o600) accountFile = "present";
      else accountFile = "refused";
    } catch {
      accountFile = "missing";
    }
  }
  const armed = source.FOUNDRY_W1_DEX_LIVE === "yes" && bounds.verifiedEnv(source) != null;
  return {
    role: "w1-dex",
    dormant: !armed,
    activated: armed,
    live_proof: false,
    account: bounds.ACCOUNT,
    issuer: bounds.ISSUER,
    ws: source.FOUNDRY_W1_DEX_WS || null,
    account_file: accountFile,
    bankroll_drops: bounds.BANKROLL_DROPS.toString(),
    max_locked_enforced: false,
    max_aeth: bounds.MAX_AETH,
    max_fee_drops: bounds.MAX_FEE_DROPS.toString(),
    owner_reserve: "validated_ledger.reserve_inc_xrp",
    axelar_drops: "0",
  };
}

async function preflight(env, deps) {
  const source = env || {};
  const options = deps || {};
  if (source.FOUNDRY_W1_DEX_LIVE !== "yes" || !bounds.verifiedEnv(source)) {
    return { address_match: false, dormant: true, live_proof: false, connected: false };
  }
  assertNoHouseSeeds(source);
  const read = options.readAccount || ((file) => readPrivateW1(file));
  const loaded = await read(source.FOUNDRY_W1_DEX_ACCOUNT_FILE);
  return {
    address_match: loaded.account === bounds.ACCOUNT && loaded.regular_key && loaded.regular_key !== bounds.ACCOUNT,
    derived: false,
    dormant: false,
    live_proof: false,
    connected: false,
    account: bounds.ACCOUNT,
  };
}

async function connectLive(env, deps) {
  const source = env || {};
  const options = deps || {};
  if (!bounds.verifiedEnv(source) || source.FOUNDRY_W1_DEX_LIVE !== "yes") {
    throw coded("W1 dex live gate is off", "DORMANT");
  }
  assertNoHouseSeeds(source);
  for (const name of HOUSE_ENVS) {
    if (source[name]) throw coded(`refusing house environment ${name}`, "HOUSE_SEED");
  }
  if (source.seed || source.secret || source.privateKey) throw coded("refusing a caller seed", "SECRET");
  const sockets = websocketList(source.FOUNDRY_W1_DEX_WS);
  const read = options.readAccount || ((file) => readPrivateW1(file));
  const open = options.openWallet || ((seed) => require("xrpl").Wallet.fromSeed(seed));
  const connect = options.connect || (async (url) => {
    const xrpl = require("xrpl");
    const client = new xrpl.Client(url, { connectionTimeout: CONNECTION_TIMEOUT_MS });
    if (typeof client.on === "function") client.on("error", () => {});
    await client.connect();
    return client;
  });
  let client = null;
  let lastError = null;
  for (const ws of sockets) {
    let opened = null;
    try {
      opened = await connect(ws);
      const info = await opened.request({ command: "server_info" });
      const network = info && info.result && info.result.info && info.result.info.network_id;
      if (Number(network) !== 1) throw coded("socket did not prove xrpl network id 1", "MAINNET");
      client = opened;
      break;
    } catch (error) {
      if (opened && opened !== client) {
        try {
          await opened.disconnect();
        } catch {
          /* already closed */
        }
      }
      if (error.code === "MAINNET" || error.code === "HOST") throw error;
      lastError = error;
      client = null;
    }
  }
  if (!client) throw lastError || coded("W1 dex websocket did not connect", "HOST");
  let wallet = null;
  async function openKey() {
    if (wallet) return;
    try {
      const account = await client.request({ command: "account_info", account: bounds.ACCOUNT, ledger_index: "validated" });
      const data = account && account.result && account.result.account_data;
      if (!account || account.result.validated !== true || !data || data.Account !== bounds.ACCOUNT) {
        throw coded("validated W1 account is missing", "LEDGER");
      }
      const onLedger = data.RegularKey;
      if (typeof onLedger !== "string" || onLedger === bounds.ACCOUNT || onLedger === anchors.WALLETS.W0.address) {
        throw coded("W1 validated account has no regular key", "REGULAR_KEY");
      }
      const loaded = await read(source.FOUNDRY_W1_DEX_ACCOUNT_FILE);
      if (!loaded || loaded.regular_key !== onLedger) {
        throw coded("file regular key does not match AccountRoot.RegularKey", "REGULAR_KEY");
      }
      const opened = await open(loaded.seed);
      const classic = opened && (opened.classicAddress || opened.address);
      if (classic === bounds.ACCOUNT || classic === anchors.WALLETS.W0.address) {
        throw coded("refusing to sign W1 with its master key", "MASTER_KEY");
      }
      if (classic !== onLedger) throw coded("derived key does not match AccountRoot.RegularKey", "REGULAR_KEY");
      wallet = opened;
    } catch (error) {
      try {
        await client.disconnect();
      } catch {
        /* already closed */
      }
      throw error;
    }
  }
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await client.disconnect();
  }
  return {
    close,
    openKey,
    clients: {
      mode: "live",
      bound: "w1-dex",
      sign: (tx) => signer.sign(tx, liveExpected(tx), () => {
        const signed = wallet.sign(tx);
        return { tx_blob: signed.tx_blob, hash: signed.hash };
      }),
      submit: (blob) => client.submit(blob),
      ledger: { request: (body) => settledRequest((payload) => client.request(payload), body) },
    },
  };
}

function liveExpected(tx) {
  return {
    type: tx.TransactionType,
    account: bounds.ACCOUNT,
    sequence: tx.Sequence,
    last: tx.LastLedgerSequence,
    fee: tx.Fee,
    taker_pays: tx.TakerPays,
    taker_gets: tx.TakerGets,
    offer_sequence: tx.OfferSequence,
    flags: tx.Flags,
    amount: tx.Amount,
    amount2: tx.Amount2,
    lp: tx.LPTokenIn,
    send_max: tx.SendMax,
    deliver: tx.Amount && typeof tx.Amount === "object" ? tx.Amount.value : undefined,
    limit: tx.LimitAmount && tx.LimitAmount.value,
  };
}

async function connectRole(env, role, deps) {
  const source = env || {};
  const options = deps || {};
  if (role !== "W3" && role !== "W4" && role !== "W5") throw coded("dex role is not live", "WALLET");
  const account = anchors.WALLETS[role].address;
  if (account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  if (role === "W5") {
    if (source.FOUNDRY_W5_ORACLE_LIVE !== "yes" || source.FOUNDRY_DEX_EXECUTE !== "yes" || source.FOUNDRY_W5_ORACLE_ACTIVATE !== "ACTIVATE-W5-RLUSD-ORACLE") {
      throw coded("W5 oracle live gate is off", "DORMANT");
    }
    if (source.FOUNDRY_DEX_NETWORK !== "xrpl:1") throw coded("socket did not prove xrpl network id 1", "MAINNET");
    if (source.FOUNDRY_DEX_AXELAR_DROPS !== "0") throw coded("Axelar budget is not zero", "BRIDGE");
  } else if (!bounds.verifiedEnv(source) || bounds.verifiedEnv(source).role !== role || source[bounds.liveEnvName(role)] !== "yes") {
    throw coded("dex role live gate is off", "DORMANT");
  }
  assertNoHouseSeeds(source);
  for (const name of HOUSE_ENVS) {
    if (source[name]) throw coded(`refusing house environment ${name}`, "HOUSE_SEED");
  }
  if (source.seed || source.secret || source.privateKey) throw coded("refusing a caller seed", "SECRET");
  const sockets = websocketList(source.FOUNDRY_W1_DEX_WS);
  const read = options.readAccount || ((file) => readRoleAccount(file, account));
  const open = options.openWallet || ((seed) => require("xrpl").Wallet.fromSeed(seed));
  const connect = options.connect || (async (url) => {
    const xrpl = require("xrpl");
    const client = new xrpl.Client(url, { connectionTimeout: CONNECTION_TIMEOUT_MS });
    if (typeof client.on === "function") client.on("error", () => {});
    await client.connect();
    return client;
  });
  let client = null;
  let lastError = null;
  for (const ws of sockets) {
    let opened = null;
    try {
      opened = await connect(ws);
      const info = await opened.request({ command: "server_info" });
      const network = info && info.result && info.result.info && info.result.info.network_id;
      if (Number(network) !== 1) throw coded("socket did not prove xrpl network id 1", "MAINNET");
      client = opened;
      break;
    } catch (error) {
      if (opened && opened !== client) {
        try {
          await opened.disconnect();
        } catch {
          /* already closed */
        }
      }
      if (error.code === "MAINNET" || error.code === "HOST") throw error;
      lastError = error;
      client = null;
    }
  }
  if (!client) throw lastError || coded("dex websocket did not connect", "HOST");
  let wallet = null;
  async function openKey() {
    if (wallet) return;
    const loaded = await read(source[bounds.keyEnvName(role)]);
    if (!loaded || loaded.account !== account) throw coded("role key file must name its account", "WALLET");
    const opened = await open(loaded.seed);
    const classic = opened && (opened.classicAddress || opened.address);
    if (classic === account || classic === anchors.WALLETS.W0.address) throw coded("refusing a master key", "MASTER_KEY");
    if (classic !== loaded.regular_key) throw coded("derived key does not match the role file", "REGULAR_KEY");
    wallet = opened;
  }
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await client.disconnect();
  }
  return {
    close,
    openKey,
    clients: {
      mode: "live",
      bound: `${role.toLowerCase()}-dex`,
      sign: (tx) => {
        if (!wallet) throw coded("role key is not open", "AUTH");
        const signed = wallet.sign(tx);
        return { tx_blob: signed.tx_blob, hash: signed.hash };
      },
      submit: (blob) => client.submit(blob),
      ledger: { request: (body) => settledRequest((payload) => client.request(payload), body) },
    },
  };
}

module.exports = {
  WS,
  CONNECTION_TIMEOUT_MS,
  websocketList,
  health,
  preflight,
  readPrivateW1,
  readRoleAccount,
  connectLive,
  connectRole,
  liveExpected,
  settledRequest,
  notFoundResponse,
  NOT_FOUND_ERRORS,
};
