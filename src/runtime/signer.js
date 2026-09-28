#!/usr/bin/env node
"use strict";

/**
 * Loopback agent signer. RegularKeys on XRPL Testnet and the W7 hook account
 * on Xahau Testnet. Bind is 127.0.0.1. The desk and GitHub Actions never call this.
 *
 *   FOUNDRY_AGENT_SIGN=yes npm run signer
 *   npm run signer:dry
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const daemon = require("./daemon");
const metrics = require("./metrics");
const policy = require("./policy");

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8787;
const HELP = `Usage: node src/runtime/signer.js [--self-test-dry]

Listens on 127.0.0.1:8787 unless FOUNDRY_SIGNER_BIND / FOUNDRY_SIGNER_PORT are set.
Requires FOUNDRY_AGENT_SIGN=yes and FOUNDRY_SIGNER_TOKEN. Refuses CI and GITHUB_ACTIONS.
--self-test-dry prints an unsigned autofill and does not read a key.`;

function richAccount() {
  return {
    balance: "80000000",
    ownerCount: 0,
    reserveBase: "1000000",
    reserveInc: "200000",
  };
}

function assertBind(host) {
  const value = String(host == null || host === "" ? DEFAULT_BIND : host).trim().toLowerCase();
  if (value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  throw policy.coded("refusing non-loopback signer bind", "BIND");
}

function assertPort(raw) {
  const port = Number(raw == null || raw === "" ? DEFAULT_PORT : raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw policy.coded("refusing signer port", "BIND");
  }
  return port;
}

function assertBearer(header, token) {
  const expected = String(token || "");
  if (expected.length < 16) throw policy.coded("refusing empty signer token", "TOKEN");
  const match = String(header || "").match(/^Bearer\s+(\S+)\s*$/);
  if (!match) throw policy.coded("refusing missing bearer token", "TOKEN");
  const got = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    throw policy.coded("refusing signer token", "TOKEN");
  }
}

function rpcFor(wallet, env) {
  const source = env || {};
  if (wallet.network === "xahau_testnet") {
    return {
      http: source.XAHAU_HTTP || anchors.XAHAU_HTTP,
      ws: source.XAHAU_WS || anchors.XAHAU_WS,
    };
  }
  return {
    http: source.XRPL_HTTP || anchors.XRPL_HTTP,
    ws: source.XRPL_WS || anchors.XRPL_WS,
  };
}

function loadDirector(root) {
  const file = path.join(root, "lab", "director-state.json");
  if (!fs.existsSync(file)) return { watched: { batch: { atomic_enabled: false } } };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed.watched) parsed.watched = {};
    if (!parsed.watched.batch) parsed.watched.batch = { atomic_enabled: false };
    return parsed;
  } catch {
    return { watched: { batch: { atomic_enabled: false } } };
  }
}

function walletsReady(env) {
  const ready = [];
  for (const id of ["W1", "W2", "W3", "W4", "W5", "W6", "W7"]) {
    const name = policy.AGENT_ACCOUNTS[id].key_env;
    if (env && env[name]) ready.push(id);
  }
  return ready;
}

function statusFor(code) {
  if (code === "TOKEN") return 401;
  if (code === "CI" || code === "AGENT_SIGN" || code === "W0" || code === "BATCH" || code === "EPOCH_SCAR" || code === "MAINNET" || code === "MASTER" || code === "DESK") {
    return 403;
  }
  if (code === "RPC") return 503;
  return 400;
}

function archiveAction(intent, tx) {
  const memos = grants.decodeMemos(tx);
  if (intent === "heartbeat" || intent === "aether-heartbeat" || memos.purpose === "aether-heartbeat") return "heartbeat";
  if (intent === "grant_pay" || intent === "aether-grant" || memos.purpose === "aether-grant") return "grant_paid";
  if (intent === "x402_outbound" || intent === "x402_buy") return "x402_outbound";
  if (intent === "walk_in_remint") return "walk_in_remint";
  return "agent-sign";
}

function activatedRoot(root) {
  if (root && fs.existsSync(path.join(root, "machines", "governance-board", "activated.json"))) return root;
  return anchors.repoRoot();
}

function assertRegularKey(walletId, classic, root) {
  if (walletId === "W7") {
    if (classic !== anchors.WALLETS.W7.address) {
      throw policy.coded("W7 key is not the hook account", "SIGNER");
    }
    return;
  }
  const activated = anchors.loadActivated(activatedRoot(root));
  const row = (activated.regular_keys || []).find((item) => item.id === walletId);
  if (!row || classic !== row.regular_key) {
    throw policy.coded(`${walletId} key is not the regular key in activated.json`, "SIGNER");
  }
  if (row.account !== anchors.WALLETS[walletId].address) {
    throw policy.coded(`${walletId} activated account drifted`, "SIGNER");
  }
}

function publicArchive(root, row, secrets) {
  if (!row || row.result !== "tesSUCCESS") {
    throw policy.coded("refusing to archive without tesSUCCESS", "RECORD");
  }
  const hash = String(row.hash || "").toUpperCase();
  if (!anchors.HASH_RE.test(hash)) throw policy.coded("refusing to archive without a ledger hash", "RECORD");
  const clean = {
    ts: row.ts,
    source: "agent-signer",
    action: row.action,
    wallet: row.wallet,
    account: row.account,
    hash,
    ledger_index: row.ledger_index == null ? null : row.ledger_index,
    result: "tesSUCCESS",
    network_id: row.network_id,
    transaction_type: row.transaction_type,
    amount_drops: row.amount_drops || "0",
  };
  if (row.intent && !anchors.SECRET_KEY_RE.test("intent")) clean.intent = row.intent;
  policy.assertNoSeedFields(clean);
  const text = JSON.stringify(clean);
  for (const secret of secrets || []) {
    if (secret && text.includes(secret)) throw policy.coded("refusing to archive a secret", "SEED");
  }
  policy.assertPrintSafe(text);
  const file = path.join(root, "lab", "ledger-log.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text}\n`);
  return clean;
}

async function rpcPost(httpUrl, wallet, method, params) {
  policy.assertAgentRpc(httpUrl, wallet);
  const response = await fetch(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params: [params || {}] }),
  });
  const body = await response.json();
  const result = body && body.result;
  if (!response.ok || !result || result.error || result.status === "error") {
    throw policy.coded(`RPC ${method} failed`, "RPC");
  }
  return result;
}

function reserveDrops(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (/^[0-9]+$/.test(text) && BigInt(text) >= 100000n) return text;
  const xrpl = require("xrpl");
  return xrpl.xrpToDrops(text);
}

function accountFrom(infoResult, serverInfo) {
  const data = infoResult && infoResult.account_data;
  if (!data || data.Balance == null) throw policy.coded("account_info omitted Balance", "RPC");
  const ledger = serverInfo && serverInfo.info && serverInfo.info.validated_ledger;
  const reserveBase = reserveDrops(ledger && (ledger.reserve_base_xrp != null ? ledger.reserve_base_xrp : ledger.reserve_base));
  const reserveInc = reserveDrops(ledger && (ledger.reserve_inc_xrp != null ? ledger.reserve_inc_xrp : ledger.reserve_inc));
  if (reserveBase == null || reserveInc == null) throw policy.coded("RPC omitted reserves", "RPC");
  return {
    balance: String(data.Balance),
    ownerCount: Number(data.OwnerCount || 0),
    reserveBase,
    reserveInc,
  };
}

async function proveHttp(httpUrl, wallet) {
  const info = await rpcPost(httpUrl, wallet, "server_info", {});
  const networkId = info.info && info.info.network_id;
  if (networkId == null || networkId === "") throw policy.coded("RPC did not prove network id", "RPC");
  policy.assertAltnet({
    networkId,
    kind: wallet && wallet.network === "xahau_testnet" ? "xahau" : undefined,
  });
  const expect = wallet && wallet.network === "xahau_testnet" ? anchors.XAHAU_NETWORK_ID : anchors.XRPL_NETWORK_ID;
  if (Number(networkId) !== expect) throw policy.coded(`refusing network id ${networkId}`, "MAINNET");
  return { networkId: Number(networkId), info };
}

async function fetchAccount(httpUrl, wallet) {
  const proved = await proveHttp(httpUrl, wallet);
  const info = await rpcPost(httpUrl, wallet, "account_info", {
    account: wallet.address,
    ledger_index: "validated",
  });
  return { networkId: proved.networkId, account: accountFrom(info, proved.info), info: proved.info };
}

async function health(ctx) {
  const options = ctx || {};
  const env = options.env || {};
  const signing = env.FOUNDRY_AGENT_SIGN === "yes" && !policy.envIsCi(env);
  let networkId = options.networkId;
  if (networkId == null && options.proveNetwork) networkId = await options.proveNetwork();
  if (networkId == null && options.skipRpc !== true) {
    const probe = policy.agentWallet("W1");
    const proved = await proveHttp(rpcFor(probe, env).http, probe);
    networkId = proved.networkId;
  }
  if (networkId == null) throw policy.coded("RPC did not prove network id", "RPC");
  policy.assertAltnet({ networkId });
  const body = {
    network_id: Number(networkId),
    wallets_ready: walletsReady(env),
    signing,
  };
  policy.assertNoSeedFields(body);
  return { status: 200, body };
}

function requestFields(body, ctx, dry) {
  const options = ctx || {};
  const env = options.env || {};
  const root = options.root || anchors.repoRoot();
  const wallet = policy.agentWallet(body.wallet);
  const urls = rpcFor(wallet, env);
  const state = options.state || loadDirector(root);
  return {
    env,
    wallet: body.wallet,
    tx: body.tx,
    intent: body.intent,
    url: options.skipRpc ? undefined : urls.http,
    networkId: options.networkId,
    account: options.account,
    requireAccount: options.account != null || options.requireAccount === true,
    feeDrops: options.feeDrops,
    history: options.history || policy.readJsonl(path.join(root, "lab", "ledger-log.jsonl"), options.io),
    motions: options.motions || (options.skipMotions ? [] : policy.loadMotions(root, options.io)),
    now: options.now || new Date(),
    state,
    index: options.index,
    has402: options.has402,
    dry,
    urls,
    root,
  };
}

function finishSuccess(body, prepared, submitted, fields, seed, env, options) {
  const result = (submitted && submitted.result) || submitted || {};
  const meta = result.meta || result.metaData || {};
  const outcome = meta.TransactionResult || result.engine_result || result.result;
  const hash = result.hash || (submitted && submitted.hash);
  if (outcome !== "tesSUCCESS" || !hash) {
    throw policy.coded(`result ${outcome || "missing"}`, "SUBMIT");
  }
  const row = {
    ts: (options.now || new Date()).toISOString(),
    action: archiveAction(body.intent, prepared),
    intent: typeof body.intent === "string" ? body.intent : "agent-sign",
    wallet: fields.wallet,
    account: prepared.Account,
    hash: String(hash).toUpperCase(),
    ledger_index: result.ledger_index == null ? (submitted.ledger_index == null ? null : submitted.ledger_index) : result.ledger_index,
    result: "tesSUCCESS",
    network_id: fields.networkId == null ? null : Number(fields.networkId),
    transaction_type: prepared.TransactionType,
    amount_drops: policy.xrpOut(prepared).toString(),
  };
  try {
    publicArchive(fields.root, row, [seed, env.FOUNDRY_SIGNER_TOKEN]);
    if (options.metrics !== false) {
      try {
        metrics.refresh(fields.root, { now: options.now });
      } catch (error) {
        if (error && error.code === "SEED") throw error;
      }
    }
  } catch (error) {
    if (error && error.code === "SEED") throw error;
  }
  return {
    status: 200,
    body: {
      hash: row.hash,
      ledger_index: row.ledger_index,
      result: "tesSUCCESS",
    },
  };
}

async function autofillLive(tx, wallet, env) {
  const urls = rpcFor(wallet, env);
  policy.assertAgentRpc(urls.ws, wallet);
  const xrpl = require("xrpl");
  const client = new xrpl.Client(urls.ws);
  await client.connect();
  try {
    const info = await client.request({ command: "server_info" });
    const networkId = info.result && info.result.info && info.result.info.network_id;
    if (networkId == null || networkId === "") throw policy.coded("RPC did not prove network id", "RPC");
    policy.assertAltnet({
      networkId,
      kind: wallet.network === "xahau_testnet" ? "xahau" : undefined,
    });
    const prepared = await client.autofill(tx);
    if (Number(prepared.NetworkID) === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
    return { prepared, networkId: Number(networkId) };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function submitLive(tx, wallet, env, ctx, loadSeed) {
  const urls = rpcFor(wallet, env);
  policy.assertAgentRpc(urls.ws, wallet);
  const xrpl = require("xrpl");
  const client = new xrpl.Client(urls.ws);
  await client.connect();
  let seed = "";
  try {
    const info = await client.request({ command: "server_info" });
    const networkId = info.result && info.result.info && info.result.info.network_id;
    if (networkId == null || networkId === "") throw policy.coded("RPC did not prove network id", "RPC");
    policy.assertAltnet({
      networkId,
      kind: wallet.network === "xahau_testnet" ? "xahau" : undefined,
    });
    const expectId = wallet.network === "xahau_testnet" ? anchors.XAHAU_NETWORK_ID : anchors.XRPL_NETWORK_ID;
    if (Number(networkId) !== expectId) throw policy.coded(`refusing network id ${networkId}`, "MAINNET");
    const accountRpc = await client.request({
      command: "account_info",
      account: wallet.address,
      ledger_index: "validated",
    });
    const account = accountFrom(accountRpc.result, info.result);
    const filled = await client.autofill(tx);
    if (Number(filled.NetworkID) === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
    policy.assertAgentRequest(Object.assign({}, ctx.fields, {
      tx: filled,
      networkId: Number(networkId),
      account,
      requireAccount: true,
      feeDrops: filled.Fee,
      url: urls.ws,
    }));
    seed = loadSeed(wallet.key_env);
    if (!seed) throw policy.coded(`${wallet.key_env} is not loaded. Refusing to sign.`, "NO_SEED");
    let key;
    try {
      key = xrpl.Wallet.fromSeed(seed);
    } catch {
      throw policy.coded(`${wallet.key_env} is not a usable seed`, "NO_SEED");
    }
    assertRegularKey(wallet.id, key.classicAddress || key.address, ctx.root);
    const signed = key.sign(filled);
    const submitted = await client.submitAndWait(signed.tx_blob);
    return { submitted, networkId: Number(networkId), prepared: filled, seed };
  } catch (error) {
    if (error && error.code && error.message && !String(error.message).includes(seed || "\0")) throw error;
    throw policy.coded(
      policy.redact(error && error.message ? error.message : "submit failed", [seed, env.FOUNDRY_SIGNER_TOKEN]),
      (error && error.code) || "SUBMIT"
    );
  } finally {
    seed = "";
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function evaluate(body, ctx) {
  const options = ctx || {};
  const env = options.env || {};
  policy.assertAgentGate(env);
  if (!options.skipAuth) assertBearer(options.authorization, env.FOUNDRY_SIGNER_TOKEN);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw policy.coded("refusing empty body", "ARGS");
  policy.assertNoSeedFields(body);
  const dry = options.dry === true || body.dry_run === true;
  const pre = Object.assign({}, options);
  if (!pre.skipRpc && body.wallet && body.wallet !== "W0") {
    const early = policy.agentWallet(body.wallet);
    const urls = rpcFor(early, env);
    if (pre.networkId == null || pre.account == null) {
      const fetched = await fetchAccount(urls.http, early);
      if (pre.networkId == null) pre.networkId = fetched.networkId;
      if (pre.account == null) pre.account = fetched.account;
    }
  }
  const fields = requestFields(body, pre, dry);
  const checked = policy.assertAgentRequest(fields);
  let prepared = checked.tx;
  if (options.autofill) prepared = await options.autofill(prepared, checked.wallet);
  else if (!options.skipRpc) {
    const filled = await autofillLive(prepared, checked.wallet, env);
    prepared = filled.prepared;
    fields.networkId = filled.networkId;
  }
  if (prepared !== checked.tx) {
    policy.assertAgentRequest(Object.assign({}, fields, { tx: prepared, feeDrops: prepared.Fee || fields.feeDrops }));
  }
  if (dry) {
    return {
      status: 200,
      body: {
        dry_run: true,
        key_loaded: false,
        signed: false,
        submitted: false,
        tx: prepared,
        wallet: checked.wallet.id,
        network_id: fields.networkId == null ? null : Number(fields.networkId),
      },
    };
  }
  const loadSeed = options.loadSeed || ((name) => daemon.readSeed(name, env, options.io, policy.AGENT_KEY_ENVS));
  if (!options.submit) {
    const live = await submitLive(prepared, checked.wallet, env, { fields, root: fields.root }, loadSeed);
    prepared = live.prepared;
    fields.networkId = live.networkId;
    const submitted = live.submitted;
    const seed = live.seed;
    return finishSuccess(body, prepared, submitted, fields, seed, env, options);
  }
  const seed = loadSeed(checked.wallet.key_env);
  if (!seed) throw policy.coded(`${checked.wallet.key_env} is not loaded. Refusing to sign.`, "NO_SEED");
  let key;
  try {
    if (options.openWallet) key = options.openWallet(seed);
    else {
      const xrpl = require("xrpl");
      key = xrpl.Wallet.fromSeed(seed);
    }
  } catch (error) {
    if (error && error.code) throw error;
    throw policy.coded(`${checked.wallet.key_env} is not a usable seed`, "NO_SEED");
  }
  const classic = key.classicAddress || key.address;
  assertRegularKey(checked.wallet.id, classic, fields.root);
  let submitted;
  try {
    submitted = await options.submit(prepared, { classicAddress: classic, sign: (tx) => key.sign(tx) });
  } catch (error) {
    throw policy.coded(policy.redact(error && error.message ? error.message : "submit failed", [seed, env.FOUNDRY_SIGNER_TOKEN]), (error && error.code) || "SUBMIT");
  }
  fields.wallet = checked.wallet.id;
  return finishSuccess(body, prepared, submitted, fields, seed, env, options);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        reject(policy.coded("body too large", "ARGS"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(policy.coded("body is not JSON", "ARGS"));
      }
    });
    req.on("error", () => reject(policy.coded("body unreadable", "ARGS")));
  });
}

async function handleNodeRequest(req, ctx) {
  const options = ctx || {};
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") return health(options);
  if (req.method === "POST" && (url.pathname === "/sign" || url.pathname === "/dry-run")) {
    const body = await readBody(req);
    return evaluate(body, Object.assign({}, options, {
      dry: url.pathname === "/dry-run" || body.dry_run === true,
      authorization: req.headers && (req.headers.authorization || req.headers.Authorization),
    }));
  }
  return { status: 404, body: { error: "not found", code: "PATH" } };
}

function startServer(ctx) {
  const options = ctx || {};
  const env = options.env || process.env;
  policy.assertAgentGate(env);
  assertBearer(`Bearer ${env.FOUNDRY_SIGNER_TOKEN}`, env.FOUNDRY_SIGNER_TOKEN);
  const host = assertBind(options.host || env.FOUNDRY_SIGNER_BIND || DEFAULT_BIND);
  const port = assertPort(options.port || env.FOUNDRY_SIGNER_PORT || DEFAULT_PORT);
  const server = http.createServer(async (req, res) => {
    try {
      const outcome = await handleNodeRequest(req, options);
      const text = JSON.stringify(outcome.body);
      policy.assertPrintSafe(text);
      const token = env.FOUNDRY_SIGNER_TOKEN;
      if (token && text.includes(token)) throw policy.coded("refusing to echo the signer token", "TOKEN");
      res.writeHead(outcome.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(text);
    } catch (error) {
      const code = error && error.code ? error.code : "FATAL";
      const message = policy.redact(error && error.message ? error.message : "signer failed", [env.FOUNDRY_SIGNER_TOKEN]);
      res.writeHead(statusFor(code), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message, code }));
    }
  });
  server.listen(port, host);
  return server;
}

async function selfTestDry(deps) {
  const options = deps || {};
  let loads = 0;
  const env = Object.assign({ FOUNDRY_AGENT_SIGN: "yes" }, options.env || {});
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  const outcome = await evaluate({
    wallet: "W5",
    intent: "self-test",
    dry_run: true,
    tx: {
      TransactionType: "Payment",
      Account: anchors.WALLETS.W5.address,
      Destination: anchors.WALLETS.W3.address,
      Amount: "1",
    },
  }, {
    env,
    dry: true,
    skipAuth: true,
    skipRpc: true,
    skipMotions: true,
    metrics: false,
    networkId: 1,
    account: options.account || richAccount(),
    history: [],
    motions: [],
    state: { watched: { batch: { atomic_enabled: false }, walk_in_offer: { status: "open", offer_count: 1 } } },
    now: options.now || new Date("2026-09-28T20:00:00.000Z"),
    loadSeed: () => {
      loads += 1;
      throw policy.coded("dry-run loaded a key", "SEED");
    },
    autofill: async (tx) => Object.assign({}, tx, { Fee: "12", Sequence: 1 }),
  });
  if (loads !== 0 || !outcome.body || outcome.body.key_loaded !== false) {
    throw policy.coded("dry-run loaded a key", "SEED");
  }
  policy.assertNoSeedFields(outcome.body);
  return outcome.body;
}

async function main(argv, deps) {
  const args = Array.isArray(argv) ? argv : [];
  const options = deps || {};
  if (args.includes("--help") || args.includes("-h")) {
    const write = options.stdout || ((text) => console.log(text));
    write(HELP);
    return 0;
  }
  if (args.includes("--self-test-dry")) {
    const body = await selfTestDry(options);
    const text = JSON.stringify(body);
    policy.assertPrintSafe(text);
    const write = options.stdout || ((line) => console.log(line));
    write(text);
    return 0;
  }
  if (args.length) throw policy.coded(`unknown arg ${args[0]}`, "ARGS");
  const env = options.env || process.env;
  if (options.listen === false) {
    policy.assertAgentGate(env);
    assertBearer(`Bearer ${env.FOUNDRY_SIGNER_TOKEN}`, env.FOUNDRY_SIGNER_TOKEN);
    assertBind(env.FOUNDRY_SIGNER_BIND || DEFAULT_BIND);
    return 0;
  }
  startServer(Object.assign({ env }, options));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      if (process.argv.includes("--self-test-dry") || process.argv.includes("--help") || process.argv.includes("-h")) {
        process.exit(code);
      }
    })
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      console.error(`${code}: ${policy.redact(error && error.message, [process.env.FOUNDRY_SIGNER_TOKEN])}`);
      process.exit(1);
    });
}

module.exports = {
  HELP,
  DEFAULT_BIND,
  DEFAULT_PORT,
  assertBind,
  assertPort,
  assertBearer,
  assertRegularKey,
  evaluate,
  health,
  handleNodeRequest,
  startServer,
  selfTestDry,
  publicArchive,
  archiveAction,
  main,
  richAccount,
  walletsReady,
};
