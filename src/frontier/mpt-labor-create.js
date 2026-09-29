#!/usr/bin/env node
"use strict";

/**
 * F2 MPTokenIssuanceCreate for AETH-LABOR. Dry-run is the default.
 * Refuses unless feature says MPTokensV1 is enabled on network id 1.
 *
 *   npm run frontier:mpt-labor-create
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:mpt-labor-create -- --live
 *
 * --live signs with W5_REGULAR_SEED on the Foundry box. It does not use the
 * agent signer allowlist. Intent name: mpt_labor_create.
 */

const anchors = require("../director/anchors");
const { rpcCall } = require("../director/snapshot");
const probe = require("./probe-amendments");
const labor = require("./mpt-labor");
const policy = require("../runtime/policy");
const metrics = require("../runtime/metrics");

const HELP = `Usage: node src/frontier/mpt-labor-create.js [--dry-run] [--live] [--xrpl-http URL]

--dry-run is the default. It prints an unsigned MPTokenIssuanceCreate and does not read W5_REGULAR_SEED.
--live requires FOUNDRY_DAEMON_LIVE=yes and refuses CI / GITHUB_ACTIONS.
The script refuses network id other than 1 and refuses the transaction when MPTokensV1 is disabled.
mpt_issuance_id stays null until tesSUCCESS returns one. A predicted id is not archived.`;

function parseArgs(argv) {
  const out = { dryRun: true, live: false, help: false, xrplHttp: null };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw labor.coded("pass only one of --dry-run or --live", "ARGS");
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--live") {
      out.live = true;
      out.dryRun = false;
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--xrpl-http") {
      out.xrplHttp = args[i + 1];
      i += 1;
      if (!out.xrplHttp) throw labor.coded("--xrpl-http needs a value", "ARGS");
    } else throw labor.coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function resolveLedger(env, override) {
  try {
    return probe.resolveHttp(env, override);
  } catch (error) {
    if (error && error.code) throw error;
    const message = error && error.message ? error.message : String(error);
    throw labor.coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
}

async function plan(opts) {
  const options = opts || {};
  const http = resolveLedger(options.env || {}, options.xrplHttp || null);
  try {
    const info = await rpcCall(http, "server_info", {}, options.fetchImpl || globalThis.fetch);
    const server = probe.readServer(info);
    const feature = await rpcCall(http, "feature", {}, options.fetchImpl || globalThis.fetch);
    const amendment = labor.assertMptEnabled(feature, "MPTokenIssuanceCreate");
    const tx = labor.buildIssuance();
    if (tx.Account !== anchors.WALLETS.W5.address) throw labor.coded("issuance Account is not W5", "ACCOUNT");
    if (tx.TransactionType !== "MPTokenIssuanceCreate") throw labor.coded("refusing a non-issuance tx", "TX");
    let predicted = null;
    try {
      const account = await rpcCall(
        http,
        "account_info",
        { account: tx.Account, ledger_index: "validated" },
        options.fetchImpl || globalThis.fetch
      );
      const seq = account && account.account_data ? account.account_data.Sequence : null;
      if (Number.isInteger(seq)) predicted = labor.issuanceId(seq, tx.Account);
    } catch (error) {
      if (error && error.code === "MAINNET") throw error;
      predicted = null;
    }
    return {
      allow: true,
      code: "DRY_RUN",
      message: `unsigned MPTokenIssuanceCreate ${labor.SYMBOL} cap ${labor.MAXIMUM_AMOUNT} on W5`,
      http,
      network_id: server.network_id,
      build_version: server.build_version,
      amendment,
      predicted_mpt_issuance_id: predicted,
      tx,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return {
      allow: false,
      code: (error && error.code) || "REFUSED",
      message: error && error.message ? error.message : String(error),
      http,
      network_id: anchors.XRPL_NETWORK_ID,
      build_version: null,
      amendment: null,
      predicted_mpt_issuance_id: null,
      tx: null,
    };
  }
}

function publicBody(mode, draft, seedReads) {
  const decoded = draft.tx ? labor.decodeMetadata(draft.tx.MPTokenMetadata) : null;
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    network_id: draft.network_id,
    action: labor.INTENT_CREATE,
    intent: labor.INTENT_CREATE,
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendment: draft.amendment,
    symbol: labor.SYMBOL,
    ticker: decoded ? decoded.t : null,
    mpt_issuance_id: null,
    predicted_mpt_issuance_id: draft.predicted_mpt_issuance_id,
    metadata: decoded
      ? {
          ticker: decoded.t,
          name: decoded.n,
          symbol: decoded.ai && decoded.ai.symbol,
          asset_class: decoded.ac,
          maximum_amount: labor.MAXIMUM_AMOUNT,
          asset_scale: labor.ASSET_SCALE,
          flags: labor.ISSUANCE_FLAGS,
        }
      : null,
    tx: draft.tx,
    signer: "box RegularKey W5; not the agent allowlist",
  };
}

function directorState(root, options) {
  if (options.state) return options.state;
  const daemon = options.daemon || require("../runtime/daemon");
  const loaded = daemon.loadState(root);
  if (!loaded || loaded.missing || !loaded.state) {
    throw labor.coded("refusing --live without director state", "STALE");
  }
  return loaded.state;
}

async function run(argv, deps) {
  const options = deps || {};
  const mode = parseArgs(argv);
  const write = options.stdout || ((text) => console.log(text));
  if (mode.help) {
    write(HELP);
    return 0;
  }
  const env = options.env || process.env;
  const now = options.now || new Date();
  const root = options.root || anchors.repoRoot();
  let seedReads = 0;
  const loadSeed = (name) => {
    seedReads += 1;
    if (!mode.live) throw labor.coded("dry-run read a seed", "SEED");
    const reader = options.loadSeed || ((key) => require("../runtime/daemon").readSeed(key, env, options.io));
    return reader(name);
  };
  if (mode.live) {
    policy.assertLiveGate(env);
    policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: mode.xrplHttp || anchors.XRPL_HTTP });
  }
  const draft = await plan({
    env,
    xrplHttp: mode.xrplHttp,
    fetchImpl: options.fetchImpl,
  });
  if (!mode.live) {
    const body = publicBody(mode, draft, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    return draft.allow ? 0 : 2;
  }
  if (!draft.allow || !draft.tx) {
    throw labor.coded(draft.message || "MPTokenIssuanceCreate refused", draft.code || "REFUSED");
  }
  const state = directorState(root, options);
  policy.assertFreshForSign(state, now);
  const regular = policy.regularKey(state, "W5");
  const daemon = options.daemon || require("../runtime/daemon");
  const submit = options.submit || ((tx, keyEnv, regularKey) => daemon.signAndSubmit(tx, keyEnv, regularKey, env, loadSeed));
  const submitted = await submit(draft.tx, "W5_REGULAR_SEED", regular);
  if (!submitted || submitted.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(submitted.hash || "").toUpperCase())) {
    throw labor.coded("MPTokenIssuanceCreate did not succeed", "SUBMIT");
  }
  const issuance = labor.issuanceIdFromMeta(submitted.meta, anchors.WALLETS.W5.address);
  const row = {
    ts: now.toISOString(),
    action: labor.INTENT_CREATE,
    intent: labor.INTENT_CREATE,
    network: "XRPL Testnet",
    network_id: 1,
    account: anchors.WALLETS.W5.address,
    symbol: labor.SYMBOL,
    ticker: labor.TICKER,
    maximum_amount: labor.MAXIMUM_AMOUNT,
    hash: String(submitted.hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    mpt_issuance_id: issuance,
  };
  if (options.archive !== false) {
    const archive = options.archive || ((entry) => daemon.archive(root, entry));
    archive(row);
  }
  if (issuance && options.recordMetrics !== false) {
    metrics.recordMpt(root, {
      hash: row.hash,
      mpt_issuance_id: issuance,
      ledger_index: row.ledger_index,
      ts: row.ts,
      now,
    }, options.io);
  }
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    network_id: 1,
    action: labor.INTENT_CREATE,
    intent: labor.INTENT_CREATE,
    allow: true,
    code: "SUBMITTED",
    hash: row.hash,
    mpt_issuance_id: issuance,
    predicted_mpt_issuance_id: draft.predicted_mpt_issuance_id,
    ledger_index: row.ledger_index,
    result: "tesSUCCESS",
    symbol: labor.SYMBOL,
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

module.exports = {
  HELP,
  parseArgs,
  plan,
  run,
};
