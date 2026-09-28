#!/usr/bin/env node
"use strict";

/**
 * F1 OracleSet keeper. Dry-run is the default.
 * Computes AETH/XRP mid from amm_info and book_offers, then builds OracleSet
 * for W5. Refuses unless feature says PriceOracle is enabled on network id 1.
 *
 *   npm run frontier:oracle-set
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:oracle-set -- --live
 *
 * --live signs with W5_REGULAR_SEED on the Foundry box. It does not use the
 * agent signer allowlist. Intent name, if an operator adds one later: oracle_set.
 */

const path = require("path");
const anchors = require("../director/anchors");
const schema = require("../director/schema");
const { rpcCall } = require("../director/snapshot");
const probe = require("./probe-amendments");
const math = require("./oracle-math");
const policy = require("../runtime/policy");
const metrics = require("../runtime/metrics");

const HELP = `Usage: node src/frontier/oracle-set.js [--dry-run] [--live] [--xrpl-http URL]

--dry-run is the default. It prints an unsigned OracleSet and does not read W5_REGULAR_SEED.
--live requires FOUNDRY_DAEMON_LIVE=yes and refuses CI / GITHUB_ACTIONS.
The script refuses network id other than 1 and refuses OracleSet when PriceOracle is disabled.
LastUpdateTime is UNIX seconds (OracleSet rule). Do not put that value in an Escrow FinishAfter.`;

function parseArgs(argv) {
  const out = { dryRun: true, live: false, help: false, xrplHttp: null };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw math.coded("pass only one of --dry-run or --live", "ARGS");
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
      if (!out.xrplHttp) throw math.coded("--xrpl-http needs a value", "ARGS");
    } else throw math.coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function aethAsset() {
  return { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address };
}

async function quoteFromLedger(http, fetchImpl, now) {
  const info = await rpcCall(http, "server_info", {}, fetchImpl);
  const server = probe.readServer(info);
  const feature = await rpcCall(http, "feature", {}, fetchImpl);
  const amendment = math.assertPriceOracleEnabled(feature);
  const ammInfo = await rpcCall(
    http,
    "amm_info",
    {
      asset: aethAsset(),
      asset2: { currency: "XRP" },
      ledger_index: "validated",
    },
    fetchImpl
  );
  const spot = math.spotFromAmm(ammInfo.amm);
  const asks = await rpcCall(
    http,
    "book_offers",
    {
      taker_gets: aethAsset(),
      taker_pays: { currency: "XRP" },
      limit: 10,
      ledger_index: "validated",
    },
    fetchImpl
  );
  const bids = await rpcCall(
    http,
    "book_offers",
    {
      taker_gets: { currency: "XRP" },
      taker_pays: aethAsset(),
      limit: 10,
      ledger_index: "validated",
    },
    fetchImpl
  );
  const quote = math.compositeQuote(spot.spot_amm, bids.offers || [], asks.offers || []);
  const ledger = ammInfo.ledger_index || ammInfo.ledger_current_index || null;
  return {
    network_id: server.network_id,
    build_version: server.build_version,
    amendment,
    quote: {
      ledger_index: Number.isInteger(ledger) ? ledger : null,
      pool_aeth: spot.pool_aeth,
      pool_xrp_drops: spot.pool_xrp_drops,
      spot_amm: quote.spot_amm,
      best_bid: quote.best_bid,
      best_ask: quote.best_ask,
      mid_clob: quote.mid_clob,
      clob_thin: quote.clob_thin,
      weights: quote.weights,
      quote_xrp_per_aeth: quote.encoded.quote_xrp_per_aeth,
      asset_price: quote.encoded.asset_price,
      asset_price_hex: quote.encoded.asset_price_hex,
      scale: quote.encoded.scale,
    },
    tx: math.buildOracleSet({ encoded: quote.encoded, now }),
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

function resolveLedger(env, override) {
  try {
    return probe.resolveHttp(env, override);
  } catch (error) {
    if (error && error.code) throw error;
    const message = error && error.message ? error.message : String(error);
    throw math.coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
}

async function plan(opts) {
  const options = opts || {};
  const http = resolveLedger(options.env || {}, options.xrplHttp || null);
  try {
    const built = await quoteFromLedger(http, options.fetchImpl || globalThis.fetch, options.now);
    if (built.tx.Account !== anchors.WALLETS.W5.address) {
      throw math.coded("OracleSet Account is not W5", "ACCOUNT");
    }
    if (built.tx.TransactionType !== "OracleSet") throw math.coded("refusing a non-OracleSet tx", "TX");
    return {
      allow: true,
      code: "DRY_RUN",
      message: `unsigned OracleSet AETH/XRP ${built.quote.quote_xrp_per_aeth} on W5 document ${math.ORACLE_DOCUMENT_ID}`,
      http,
      network_id: built.network_id,
      build_version: built.build_version,
      amendment: built.amendment,
      quote: built.quote,
      tx: built.tx,
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
      quote: null,
      tx: null,
    };
  }
}

function publicBody(mode, draft, seedReads) {
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    network_id: draft.network_id,
    action: math.INTENT,
    intent: math.INTENT,
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendment: draft.amendment,
    quote: draft.quote,
    tx: draft.tx,
    signer: "box RegularKey W5; not the agent allowlist",
  };
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
    if (!mode.live) throw math.coded("dry-run read a seed", "SEED");
    const reader = options.loadSeed || ((key) => require("../runtime/daemon").readSeed(key, env, options.io));
    return reader(name);
  };
  if (mode.live) {
    policy.assertLiveGate(env);
    policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: mode.xrplHttp || anchors.XRPL_HTTP });
  }
  const draft = await plan({
    env,
    now,
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
    throw math.coded(draft.message || "OracleSet refused", draft.code || "REFUSED");
  }
  const state = Object.prototype.hasOwnProperty.call(options, "state") ? options.state : loadState(root, options.io);
  if (!state) throw math.coded("refusing --live without director state", "STALE");
  if (policy.isStale(state, now)) throw math.coded("refusing to sign on stale director state", "STALE");
  const regular = policy.regularKey(state, "W5");
  const daemon = options.daemon || require("../runtime/daemon");
  const submit = options.submit || ((tx, keyEnv, regularKey) => daemon.signAndSubmit(tx, keyEnv, regularKey, env, loadSeed));
  const submitted = await submit(draft.tx, "W5_REGULAR_SEED", regular);
  if (!submitted || submitted.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(submitted.hash || "").toUpperCase())) {
    throw math.coded("OracleSet did not succeed", "SUBMIT");
  }
  let oracleId = submitted.oracle_id && anchors.HASH_RE.test(String(submitted.oracle_id).toUpperCase())
    ? String(submitted.oracle_id).toUpperCase()
    : null;
  if (!oracleId) {
    try {
      const { rpcCall } = require("../director/snapshot");
      const entry = await rpcCall(draft.http, "ledger_entry", math.ledgerEntryParams(), options.fetchImpl || globalThis.fetch);
      oracleId = math.readOraclePrice(entry).oracle_id;
    } catch {
      oracleId = null;
    }
  }
  const row = {
    ts: now.toISOString(),
    action: "oracle_set",
    intent: math.INTENT,
    network: "XRPL Testnet",
    network_id: 1,
    account: anchors.WALLETS.W5.address,
    oracle_document_id: math.ORACLE_DOCUMENT_ID,
    quote_xrp_per_aeth: draft.quote.quote_xrp_per_aeth,
    hash: String(submitted.hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    oracle_id: oracleId,
    last_update_time: draft.tx.LastUpdateTime,
  };
  if (options.archive !== false) {
    const archive = options.archive || ((entry) => daemon.archive(root, entry));
    archive(row);
  }
  if (options.recordMetrics !== false) {
    metrics.recordOracle(root, {
      hash: row.hash,
      oracle_id: row.oracle_id,
      ledger_index: row.ledger_index,
      last_update_time: row.last_update_time,
      quote_xrp_per_aeth: row.quote_xrp_per_aeth,
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
    action: math.INTENT,
    intent: math.INTENT,
    allow: true,
    code: "SUBMITTED",
    hash: row.hash,
    oracle_id: row.oracle_id,
    ledger_index: row.ledger_index,
    result: "tesSUCCESS",
    quote_xrp_per_aeth: row.quote_xrp_per_aeth,
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
  loadState,
  plan,
  quoteFromLedger,
  run,
};
