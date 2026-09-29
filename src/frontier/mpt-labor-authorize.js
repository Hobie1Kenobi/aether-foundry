#!/usr/bin/env node
"use strict";

/**
 * F2 MPTokenAuthorize for the AETH-LABOR issuance. Dry-run is the default.
 * Issuer mode (default) is W5 authorizing one holder. --opt-in is the holder's
 * own MPTokenAuthorize. Refuses unless MPTokensV1 is enabled on network id 1.
 *
 *   npm run frontier:mpt-labor-authorize -- --issuance-id <48 hex>
 *   npm run frontier:mpt-labor-authorize -- --opt-in --issuance-id <48 hex>
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const { rpcCall } = require("../director/snapshot");
const probe = require("./probe-amendments");
const labor = require("./mpt-labor");
const policy = require("../runtime/policy");
const metrics = require("../runtime/metrics");

const HELP = `Usage: node src/frontier/mpt-labor-authorize.js [--dry-run] [--live] [--xrpl-http URL]
       [--issuance-id HEX] [--holder r...] [--opt-in]

--dry-run is the default. It does not read a seed.
Default mode: W5 submits MPTokenAuthorize with Holder (requires tfMPTRequireAuth).
--opt-in: the holder submits MPTokenAuthorize and creates their MPToken.
The issuance id comes from --issuance-id or lab/metrics.json mpt_issuance_id.
The script refuses network id other than 1 and refuses when MPTokensV1 is disabled.`;

function parseArgs(argv) {
  const out = {
    dryRun: true,
    live: false,
    help: false,
    xrplHttp: null,
    issuanceId: null,
    holder: null,
    optIn: false,
  };
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
    } else if (arg === "--opt-in") out.optIn = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--xrpl-http" || arg === "--issuance-id" || arg === "--holder") {
      const value = args[i + 1];
      i += 1;
      if (!value || value.startsWith("--")) throw labor.coded(`${arg} needs a value`, "ARGS");
      if (arg === "--xrpl-http") out.xrplHttp = value;
      else if (arg === "--issuance-id") out.issuanceId = value;
      else out.holder = value;
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

function filedId(root, io) {
  const disk = io || fs;
  const file = path.join(root, "lab", "metrics.json");
  if (!disk.existsSync(file)) return null;
  const doc = metrics.readMetrics(root, disk);
  return doc && doc.mpt_issuance_id ? doc.mpt_issuance_id : null;
}

async function plan(opts) {
  const options = opts || {};
  const http = resolveLedger(options.env || {}, options.xrplHttp || null);
  try {
    const info = await rpcCall(http, "server_info", {}, options.fetchImpl || globalThis.fetch);
    const server = probe.readServer(info);
    const feature = await rpcCall(http, "feature", {}, options.fetchImpl || globalThis.fetch);
    const amendment = labor.assertMptEnabled(feature, "MPTokenAuthorize");
    const id = options.issuanceId || filedId(options.root || anchors.repoRoot(), options.io);
    if (!id) {
      return {
        allow: false,
        code: "MISSING_ISSUANCE",
        message: "mpt_issuance_id is null; pass --issuance-id or archive a create first",
        http,
        network_id: server.network_id,
        build_version: server.build_version,
        amendment,
        built: null,
      };
    }
    const built = labor.buildAuthorize({
      issuanceId: id,
      holder: options.holder || anchors.WALLETS.W2.address,
      optIn: options.optIn === true,
    });
    if (built.tx.TransactionType !== "MPTokenAuthorize") throw labor.coded("refusing a non-authorize tx", "TX");
    return {
      allow: true,
      code: "DRY_RUN",
      message: built.optIn
        ? `unsigned MPTokenAuthorize opt-in by ${built.holder}`
        : `unsigned MPTokenAuthorize holder ${built.holder}`,
      http,
      network_id: server.network_id,
      build_version: server.build_version,
      amendment,
      built,
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
      built: null,
    };
  }
}

function publicBody(mode, draft, seedReads) {
  const built = draft.built;
  const signerId = built ? built.signerId : labor.ISSUER_ID;
  const keyEnv = signerId ? labor.REGULAR_KEY_ENV[signerId] || null : null;
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: keyEnv,
    network: "xrpl:1",
    network_id: draft.network_id,
    action: labor.INTENT_AUTHORIZE,
    intent: labor.INTENT_AUTHORIZE,
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendment: draft.amendment,
    auth: built ? (built.optIn ? "opt-in" : "issuer") : mode.optIn ? "opt-in" : "issuer",
    holder: built ? built.holder : null,
    mpt_issuance_id: built ? built.issuanceId : null,
    tx: built ? built.tx : null,
    signer: built && built.optIn
      ? "box RegularKey of the holder; not the agent allowlist"
      : "box RegularKey W5; not the agent allowlist",
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
    root,
    io: options.io,
    xrplHttp: mode.xrplHttp,
    fetchImpl: options.fetchImpl,
    issuanceId: mode.issuanceId,
    holder: mode.holder,
    optIn: mode.optIn,
  });
  if (!mode.live) {
    const body = publicBody(mode, draft, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    return draft.allow ? 0 : 2;
  }
  if (!draft.allow || !draft.built) {
    throw labor.coded(draft.message || "MPTokenAuthorize refused", draft.code || "REFUSED");
  }
  const signerId = draft.built.signerId;
  if (!signerId) throw labor.coded("opt-in holder is not a Foundry regular key", "HOLDER");
  const keyEnv = labor.keyEnvFor(signerId);
  const state = directorState(root, options);
  policy.assertFreshForSign(state, now);
  const regular = policy.regularKey(state, signerId);
  const daemon = options.daemon || require("../runtime/daemon");
  const submit = options.submit || ((tx, envName, regularKey) => daemon.signAndSubmit(tx, envName, regularKey, env, loadSeed));
  const submitted = await submit(draft.built.tx, keyEnv, regular);
  if (!submitted || submitted.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(submitted.hash || "").toUpperCase())) {
    throw labor.coded("MPTokenAuthorize did not succeed", "SUBMIT");
  }
  const row = {
    ts: now.toISOString(),
    action: labor.INTENT_AUTHORIZE,
    intent: labor.INTENT_AUTHORIZE,
    network: "XRPL Testnet",
    network_id: 1,
    account: draft.built.tx.Account,
    holder: draft.built.holder,
    auth: draft.built.optIn ? "opt-in" : "issuer",
    hash: String(submitted.hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    mpt_issuance_id: draft.built.issuanceId,
  };
  if (options.archive !== false) {
    const archive = options.archive || ((entry) => daemon.archive(root, entry));
    archive(row);
  }
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    key_env: keyEnv,
    network: "xrpl:1",
    network_id: 1,
    action: labor.INTENT_AUTHORIZE,
    intent: labor.INTENT_AUTHORIZE,
    allow: true,
    code: "SUBMITTED",
    auth: row.auth,
    holder: row.holder,
    hash: row.hash,
    mpt_issuance_id: row.mpt_issuance_id,
    ledger_index: row.ledger_index,
    result: "tesSUCCESS",
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
  filedId,
  run,
};
