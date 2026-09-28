"use strict";

/**
 * W5 heartbeat. Default 1 drop to W3. Memo purpose=aether-heartbeat.
 * At most 4 per UTC day, with a rolling 24h backstop, and at least 6 hours apart.
 * Dry-run does not read W5_REGULAR_SEED.
 *
 *   npm run heartbeat:dry
 *   FOUNDRY_DAEMON_LIVE=yes npm run heartbeat:live
 */

const path = require("path");
const anchors = require("../../director/anchors");
const schema = require("../../director/schema");
const grants = require("../../grants/policy");
const policy = require("../policy");
const metrics = require("../metrics");

function historyFile(root) {
  return path.join(root, "lab", "ledger-log.jsonl");
}

function buildUnsigned(opts) {
  const checked = policy.assertHeartbeat(opts);
  const ledger = opts && opts.ledgerIndex;
  const memos = [
    grants.memo("purpose", "aether-heartbeat"),
    grants.memo("experiment", "foundry-runtime"),
  ];
  if (Number.isInteger(ledger) && ledger > 0) memos.push(grants.memo("ledger", String(ledger)));
  return {
    TransactionType: "Payment",
    Account: anchors.WALLETS.W5.address,
    Destination: checked.destination,
    Amount: checked.drops,
    SourceTag: policy.HEARTBEAT_SOURCE_TAG,
    Memos: memos,
  };
}

function plan(opts) {
  const options = opts || {};
  const now = options.now || new Date();
  try {
    if (!options.state || policy.isStale(options.state, now)) {
      throw policy.coded("refusing to sign on stale director state", "STALE");
    }
    if (options.live) {
      policy.assertLiveGate(options.env);
      policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: anchors.XRPL_HTTP });
    }
    const history = options.history || policy.readJsonl(historyFile(options.root), options.io);
    const ledger = options.state.networks && options.state.networks.xrpl_testnet
      ? options.state.networks.xrpl_testnet.validated_ledger_index
      : null;
    const tx = buildUnsigned({
      drops: options.drops == null ? policy.HEARTBEAT_DEFAULT_DROPS : options.drops,
      destination: options.destination || anchors.WALLETS.W3.address,
      history,
      now,
      ledgerIndex: ledger,
    });
    policy.assertSigningTx(tx, options.state);
    return policy.decision("heartbeat", {
      allow: true,
      code: "DUE",
      message: `unsigned heartbeat ${tx.Amount} drops to ${tx.Destination}`,
      tx,
    });
  } catch (error) {
    return policy.fromError("heartbeat", error);
  }
}

async function execute(opts) {
  const options = opts || {};
  policy.assertLiveGate(options.env);
  const draft = plan(options);
  if (!draft.allow || !draft.tx) throw policy.coded(draft.message || "heartbeat refused", draft.code || "REFUSED");
  const regular = policy.regularKey(options.state, "W5");
  const submitted = await options.submit(draft.tx, "W5_REGULAR_SEED", regular);
  if (!submitted || submitted.result !== "tesSUCCESS") {
    throw policy.coded("heartbeat did not succeed", "SUBMIT");
  }
  const row = {
    ts: new Date().toISOString(),
    action: "heartbeat",
    event: "heartbeat",
    network: "XRPL Testnet",
    network_id: 1,
    account: anchors.WALLETS.W5.address,
    destination: draft.tx.Destination,
    amount_drops: draft.tx.Amount,
    hash: String(submitted.hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    purpose: "aether-heartbeat",
    experiment: "foundry-runtime",
  };
  if (options.archive) options.archive(row);
  if (options.recordMetrics !== false) {
    metrics.recordHeartbeat(options.root || anchors.repoRoot(), {
      hash: row.hash,
      ledger_index: row.ledger_index,
      ts: row.ts,
    }, options.io);
  }
  return {
    hash: row.hash,
    result: "tesSUCCESS",
    ledger_index: row.ledger_index,
  };
}

function loadState(root, io) {
  const file = path.join(root, anchors.STATE_REL);
  const exists = (io && io.existsSync) || require("fs").existsSync;
  const read = (io && io.readFileSync) || require("fs").readFileSync;
  if (!exists(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(read(file, "utf8"));
  } catch (error) {
    throw policy.coded(`director state is not JSON: ${error.message}`, "SCHEMA");
  }
  schema.validateState(parsed, { root });
  return parsed;
}

function parseArgs(argv) {
  const out = { dryRun: true, live: false, help: false, drops: null, destination: null };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw policy.coded("pass only one of --dry-run or --live", "ARGS");
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--live") {
      out.live = true;
      out.dryRun = false;
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--drops") {
      out.drops = args[i + 1];
      i += 1;
      if (out.drops == null) throw policy.coded("--drops needs a value", "ARGS");
    } else if (arg === "--destination") {
      out.destination = args[i + 1];
      i += 1;
      if (!out.destination) throw policy.coded("--destination needs a value", "ARGS");
    } else throw policy.coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function publicBody(mode, draft, seedReads) {
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    action: draft.action,
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    tx: draft.tx,
  };
}

async function run(argv, deps) {
  const options = deps || {};
  const mode = parseArgs(argv);
  const write = options.stdout || ((text) => console.log(text));
  if (mode.help) {
    write("Usage: node src/runtime/actions/heartbeat.js [--dry-run] [--live] [--drops 1] [--destination r...]\n\n--dry-run is the default. It prints an unsigned Payment and does not read W5_REGULAR_SEED.\n--live requires FOUNDRY_DAEMON_LIVE=yes and refuses CI / GITHUB_ACTIONS.");
    return 0;
  }
  const env = options.env || process.env;
  const now = options.now || new Date();
  const root = options.root || anchors.repoRoot();
  let seedReads = 0;
  const loadSeed = (name) => {
    seedReads += 1;
    if (!mode.live) throw policy.coded("dry-run read a seed", "SEED");
    const reader = options.loadSeed || ((key) => require("../daemon").readSeed(key, env, options.io));
    return reader(name);
  };
  if (mode.live) {
    policy.assertLiveGate(env);
    policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: anchors.XRPL_HTTP });
  }
  const state = Object.prototype.hasOwnProperty.call(options, "state") ? options.state : loadState(root, options.io);
  const shared = {
    state,
    env,
    now,
    root,
    live: mode.live,
    drops: mode.drops,
    destination: mode.destination,
    history: options.history,
    io: options.io,
  };
  if (!mode.live) {
    const draft = plan(shared);
    const body = publicBody(mode, draft, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    return draft.allow ? 0 : 2;
  }
  const daemon = options.daemon || require("../daemon");
  const done = await execute(Object.assign({}, shared, {
    loadSeed,
    submit: options.submit || ((tx, keyEnv, regular) => daemon.signAndSubmit(tx, keyEnv, regular, env, loadSeed)),
    archive: options.archive || ((row) => daemon.archive(root, row)),
    recordMetrics: options.recordMetrics,
  }));
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    action: "heartbeat",
    allow: true,
    code: "SUBMITTED",
    hash: done.hash,
    ledger_index: done.ledger_index,
    result: done.result,
  };
  policy.assertNoSeedFields(body);
  const text = JSON.stringify(body, null, 2);
  policy.assertPrintSafe(text);
  write(text);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      console.error(`${code}: ${policy.redact(error && error.message)}`);
      process.exit(1);
    });
}

module.exports = { buildUnsigned, plan, execute, parseArgs, run };
