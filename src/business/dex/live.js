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
const HOUSE_ENVS = ["W0_SEED", "W1_SEED", "W2_SEED", "W3_SEED", "W4_SEED", "W5_SEED", "W6_SEED", "W7_SEED"];

function assertWs(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw coded("W1 dex websocket is not a URL", "HOST");
  }
  if (url.username || url.password || url.port || url.protocol !== "wss:" || url.hostname !== "testnet.xrpl-labs.com") {
    throw coded("W1 dex refuses that websocket", "HOST");
  }
  if (url.pathname !== "/" && url.pathname !== "") throw coded("W1 dex refuses that websocket", "HOST");
  return WS;
}

function assertFile(file) {
  const resolved = path.resolve(String(file || ""));
  if (!file || !path.isAbsolute(resolved)) throw coded("W1 account file must be an absolute path", "ISOLATED");
  if (resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`) || resolved.startsWith("/workspace/aether-foundry/")) {
    throw coded("refusing an account file inside the checkout", "ISOLATED");
  }
  return resolved;
}

function readPrivateW1(file) {
  const resolved = assertFile(file);
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ENOENT") throw coded("W1 account file is missing", "AUTH");
    throw coded("W1 account file cannot be read", "AUTH");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw coded("W1 account file must be mode 0600", "AUTH");
    }
    const body = JSON.parse(fs.readFileSync(fd, "utf8"));
    const xrpl = require("xrpl");
    if (!body || body.account !== bounds.ACCOUNT || body.account === anchors.WALLETS.W0.address) {
      throw coded("W1 regular-key file must name the W1 account", "WALLET");
    }
    if (body.regular_key === bounds.ACCOUNT || body.regular_key === anchors.WALLETS.W0.address || !xrpl.isValidClassicAddress(body.regular_key || "")) {
      throw coded("refusing a master key as the W1 signer", "MASTER_KEY");
    }
    if (typeof body.seed !== "string" || body.seed.length < 8) throw coded("W1 regular-key file is missing its seed", "WALLET");
    return { account: body.account, regular_key: body.regular_key, seed: body.seed };
  } finally {
    fs.closeSync(fd);
  }
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
  const ws = assertWs(source.FOUNDRY_W1_DEX_WS);
  const read = options.readAccount || ((file) => readPrivateW1(file));
  const open = options.openWallet || ((seed) => require("xrpl").Wallet.fromSeed(seed));
  const connect = options.connect || (async (url) => {
    const xrpl = require("xrpl");
    const client = new xrpl.Client(url);
    await client.connect();
    return client;
  });
  const client = await connect(ws);
  let wallet = null;
  try {
    const info = await client.request({ command: "server_info" });
    const network = info && info.result && info.result.info && info.result.info.network_id;
    if (Number(network) !== 1) throw coded("socket did not prove xrpl network id 1", "MAINNET");
  } catch (error) {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
    throw error;
  }
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
      ledger: { request: (body) => client.request(body) },
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
  };
}

module.exports = {
  WS,
  health,
  preflight,
  readPrivateW1,
  connectLive,
  liveExpected,
};
