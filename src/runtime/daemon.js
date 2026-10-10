#!/usr/bin/env node
"use strict";

/**
 * Foundry Box daemon. Dry-run is the default. Live requires FOUNDRY_DAEMON_LIVE=yes
 * and refuses CI / GITHUB_ACTIONS. Seeds are read only on the live submit path.
 *
 *   npm run runtime:dry
 *   FOUNDRY_DAEMON_LIVE=yes npm run runtime:live
 */

const fs = require("fs");
const path = require("path");
const hosts = require("../xrpl-hosts");
const anchors = require("../director/anchors");
const schema = require("../director/schema");
const wake = require("../director/wake");
const policy = require("./policy");
const remint = require("./actions/remint");
const grant = require("./actions/grant");
const heartbeat = require("./actions/heartbeat");
const outbound = require("./actions/outbound");
const snapshot = require("./actions/snapshot");

const HELP = `Usage: node src/runtime/daemon.js [--dry-run] [--live] [--once]

--dry-run is the default. It prints unsigned tx JSON and does not read a seed.
--live requires FOUNDRY_DAEMON_LIVE=yes and refuses CI / GITHUB_ACTIONS.
--once runs a single pass. Without it, the process loops every 60s.
Exit 0 quiet, 2 alert, 1 fatal.`;

const PUBLIC_KEYS = [
  "action",
  "allow",
  "code",
  "message",
  "signed",
  "submitted",
  "tx",
  "key_env",
  "signs",
  "write",
  "preserves",
  "destination",
  "reason",
  "payTo",
  "hash",
  "resourceUrl",
  "settlement",
];

function parseArgs(argv) {
  const out = { dryRun: true, live: false, once: false, help: false };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw policy.coded("pass only one of --dry-run or --live", "ARGS");
  }
  for (const arg of args) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--live") {
      out.live = true;
      out.dryRun = false;
    } else if (arg === "--once") out.once = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw policy.coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function readSeed(name, env, io, allow) {
  const allowed = allow || policy.KEY_ENVS;
  if (name === "W0_SEED") throw policy.coded("refusing W0 master seed", "W0");
  if (!allowed.includes(name)) throw policy.coded(`refusing seed key ${name}`, "SEED");
  if (env && env[name]) return env[name];
  const file = (env && env.AETHER_SECRETS) || "/workspace/aether-foundry-secrets/.env";
  const exists = (io && io.existsSync) || fs.existsSync;
  const read = (io && io.readFileSync) || fs.readFileSync;
  if (!exists(file)) return "";
  for (const line of String(read(file, "utf8")).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || match[1] !== name) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

function archive(root, row) {
  if (!row || row.result !== "tesSUCCESS") {
    throw policy.coded("refusing to archive without tesSUCCESS", "RECORD");
  }
  const hash = String(row.hash || "").toUpperCase();
  if (!anchors.HASH_RE.test(hash)) throw policy.coded("refusing to archive without a ledger hash", "RECORD");
  const clean = Object.assign({}, row, { hash, result: "tesSUCCESS" });
  policy.assertNoSeedFields(clean);
  const file = path.join(root, "lab", "ledger-log.jsonl");
  fs.appendFileSync(file, `${JSON.stringify(clean)}\n`);
}

async function openLedgerClient(env) {
  const ws = hosts.resolveWs(env);
  policy.assertSigningRpc(ws);
  return hosts.openClient(ws, {
    networkId: anchors.XRPL_NETWORK_ID,
    assertUrl: (url) => policy.assertSigningRpc(url),
  });
}

async function signOnly(tx, keyEnv, regularAddress, env, loadSeed) {
  policy.assertLiveGate(env);
  policy.assertSigningTx(tx);
  const client = await openLedgerClient(env);
  let seed = "";
  try {
    seed = loadSeed(keyEnv);
    if (!seed) throw policy.coded(`${keyEnv} is not loaded. Refusing to sign.`, "NO_SEED");
    const xrpl = require("xrpl");
    let wallet;
    try {
      wallet = xrpl.Wallet.fromSeed(seed);
    } catch {
      throw policy.coded(`${keyEnv} is not a usable seed`, "NO_SEED");
    }
    const signer = wallet.classicAddress || wallet.address;
    if (signer !== regularAddress) throw policy.coded(`${keyEnv} address is not the regular key`, "SIGNER");
    const prepared = await client.autofill(tx);
    if (prepared.NetworkID === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
    policy.assertSigningTx(prepared);
    const signed = wallet.sign(prepared);
    if (!signed || !signed.tx_blob || !signed.hash) {
      throw policy.coded("signer did not return a blob", "SUBMIT");
    }
    return { tx_blob: signed.tx_blob, hash: signed.hash };
  } catch (error) {
    if (error && error.code && error.message && !String(error.message).includes(seed || "\0")) throw error;
    throw policy.coded(
      policy.redact(error && error.message ? error.message : "sign failed", [seed, env.FOUNDRY_SIGNER_TOKEN]),
      (error && error.code) || "SUBMIT"
    );
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function submitSignedBlob(txBlob, env) {
  policy.assertLiveGate(env);
  if (typeof txBlob !== "string" || !txBlob) throw policy.coded("refusing to submit an empty blob", "SUBMIT");
  const client = await openLedgerClient(env);
  try {
    const submitted = await client.submitAndWait(txBlob);
    const result = (submitted && submitted.result) || submitted || {};
    const meta = result.meta || result.metaData || {};
    if (meta.TransactionResult !== "tesSUCCESS" || !result.hash) {
      throw policy.coded(`result ${meta.TransactionResult || "missing"}`, "SUBMIT");
    }
    return {
      hash: String(result.hash).toUpperCase(),
      result: "tesSUCCESS",
      ledger_index: result.ledger_index == null ? null : result.ledger_index,
      tx_blob: txBlob,
    };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function signAndSubmit(tx, keyEnv, regularAddress, env, loadSeed) {
  policy.assertLiveGate(env);
  policy.assertSigningTx(tx);
  const client = await openLedgerClient(env);
  let seed = "";
  try {
    seed = loadSeed(keyEnv);
    if (!seed) throw policy.coded(`${keyEnv} is not loaded. Refusing to sign.`, "NO_SEED");
    const xrpl = require("xrpl");
    let wallet;
    try {
      wallet = xrpl.Wallet.fromSeed(seed);
    } catch {
      throw policy.coded(`${keyEnv} is not a usable seed`, "NO_SEED");
    }
    const signer = wallet.classicAddress || wallet.address;
    if (signer !== regularAddress) throw policy.coded(`${keyEnv} address is not the regular key`, "SIGNER");
    const prepared = await client.autofill(tx);
    if (prepared.NetworkID === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
    policy.assertSigningTx(prepared);
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const result = (submitted && submitted.result) || submitted || {};
    const meta = result.meta || result.metaData || {};
    if (meta.TransactionResult !== "tesSUCCESS" || !result.hash) {
      throw policy.coded(`result ${meta.TransactionResult || "missing"}`, "SUBMIT");
    }
    return {
      hash: String(result.hash).toUpperCase(),
      result: "tesSUCCESS",
      ledger_index: result.ledger_index == null ? null : result.ledger_index,
      meta,
      tx_blob: signed.tx_blob,
    };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

function publicView(plan) {
  const out = {};
  for (const key of PUBLIC_KEYS) {
    if (plan[key] !== undefined) out[key] = plan[key];
  }
  if (out.signs == null && plan.action === "director_snapshot") out.signs = false;
  return out;
}

function loadState(root) {
  const file = path.join(root, anchors.STATE_REL);
  if (!fs.existsSync(file)) return { missing: true, state: null, file };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw policy.coded(`director state is not JSON: ${error.message}`, "SCHEMA");
  }
  schema.validateState(parsed, { root });
  return { missing: false, state: parsed, file };
}

async function pass(opts) {
  const options = opts || {};
  const argv = options.argv || [];
  const mode = options.mode || parseArgs(argv);
  const env = options.env || process.env;
  const now = options.now || new Date();
  const root = options.root || anchors.repoRoot();
  const write = options.stdout || ((text) => console.log(text));
  if (mode.live) policy.assertLiveGate(env);
  policy.loadAllowlist();

  let loaded = loadState(root);
  const loader = options.loadSeed || ((name) => readSeed(name, env, options.io));
  let seedReads = 0;
  const guardedLoad = (name) => {
    seedReads += 1;
    if (!mode.live) throw policy.coded("dry-run read a seed", "SEED");
    return loader(name);
  };

  if (mode.live && (loaded.missing || policy.isStale(loaded.state, now))) {
    await snapshot.execute({
      root,
      state: loaded.state,
      now,
      tx: null,
      fetchImpl: options.fetchImpl,
    });
    loaded = loadState(root);
  }

  let alerts = [];
  if (loaded.missing || !loaded.state) {
    alerts = [{ code: "stale", message: "director state missing; run npm run director:snapshot" }];
  } else {
    alerts = wake.evaluate(loaded.state, { now }).alerts;
  }
  const stale = loaded.missing || !loaded.state || policy.isStale(loaded.state, now);
  const shared = {
    state: loaded.state,
    env,
    now,
    root,
    live: mode.live,
    alerts,
    io: options.io,
    index: options.index,
    loadSeed: guardedLoad,
    submit: (tx, keyEnv, regular) => signAndSubmit(tx, keyEnv, regular, env, guardedLoad),
    sign: (tx, keyEnv, regular) => signOnly(tx, keyEnv, regular, env, guardedLoad),
    submitBlob: (txBlob) => submitSignedBlob(txBlob, env),
    archive: (row) => archive(root, row),
    fetchImpl: options.fetchImpl,
    pollSellOffers: options.pollSellOffers,
  };

  const plans = [];
  plans.push(snapshot.plan({ missing: loaded.missing, stale, state: loaded.state }));
  const remintPlan = remint.plan(shared);
  plans.push(remintPlan);
  const grantPlan = await grant.plan(shared);
  plans.push(grantPlan);
  const heartbeatPlan = heartbeat.plan(shared);
  plans.push(heartbeatPlan);
  const outboundPlan = await outbound.plan(shared);
  plans.push(outboundPlan);

  if (mode.live) {
    const steps = [
      ["walk_in_remint", remintPlan, remint],
      ["grant_pay", grantPlan, grant],
      ["heartbeat", heartbeatPlan, heartbeat],
      ["x402_outbound", outboundPlan, outbound],
    ];
    for (const [, draft, action] of steps) {
      if (!draft.allow) continue;
      const done = await action.execute(shared);
      draft.submitted = done && typeof done.submitted === "boolean" ? done.submitted : true;
      draft.signed = true;
      draft.hash = done && done.hash ? done.hash : null;
      if (done && done.settlement) draft.settlement = done.settlement;
    }
  }

  const body = {
    mode: mode.live ? "live" : "dry-run",
    signed: plans.some((row) => row.signed === true),
    key_loaded: seedReads > 0,
    once: Boolean(mode.once),
    network_id: anchors.XRPL_NETWORK_ID,
    alerts,
    plans: plans.map(publicView),
  };
  policy.assertNoSeedFields(body);
  const text = JSON.stringify(body, null, 2);
  policy.assertPrintSafe(text);
  write(text);
  if (alerts.length > 0) return 2;
  return 0;
}

async function subscribe(tick) {
  const client = await openLedgerClient(process.env);
  await client.request({
    command: "subscribe",
    accounts: [
      anchors.WALLETS.W2.address,
      anchors.WALLETS.W3.address,
      anchors.WALLETS.W5.address,
      anchors.WALLETS.W6.address,
    ],
  });
  client.on("transaction", () => {
    tick().catch(() => {});
  });
  return client;
}

async function watch(argv, deps) {
  const options = deps || {};
  let running = false;
  const tick = async () => {
    if (running) return 0;
    running = true;
    try {
      return await pass(Object.assign({ argv }, options));
    } finally {
      running = false;
    }
  };
  const mode = parseArgs(argv);
  if (mode.live && options.ws !== false) {
    try {
      await subscribe(tick);
    } catch (error) {
      console.error(`ws unavailable: ${policy.redact(error && error.message)}`);
    }
  }
  let code = await tick();
  if (code === 1) return code;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      tick()
        .then((next) => {
          code = next;
          if (next === 1) {
            clearInterval(timer);
            resolve(next);
          }
        })
        .catch((error) => {
          clearInterval(timer);
          resolve(Promise.reject(error));
        });
    }, options.intervalMs || 60000);
  });
}

async function main(argv, deps) {
  const args = argv || [];
  const options = deps || {};
  const mode = parseArgs(args);
  if (mode.help) {
    const write = options.stdout || ((text) => console.log(text));
    write(HELP);
    return 0;
  }
  const env = options.env || process.env;
  if (mode.live) policy.assertLiveGate(env);
  if (mode.once) return pass(Object.assign({ argv: args, mode }, options));
  return watch(args, options);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      console.error(`${code}: ${policy.redact(error && error.message)}`);
      process.exit(1);
    });
}

module.exports = {
  HELP,
  parseArgs,
  pass,
  main,
  readSeed,
  archive,
  signAndSubmit,
  loadState,
};
