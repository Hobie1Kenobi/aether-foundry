#!/usr/bin/env node
"use strict";

/**
 * Work-ticket quote that reads the W5 Oracle via ledger_entry.
 * The price is the on-ledger AETH/XRP pair. This script does not call
 * amm_info or book_offers and does not fall back to a local float.
 *
 *   npm run frontier:oracle-ticket
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:oracle-ticket -- --live
 *
 * Default is dry-run. --live may submit the W2 NFTokenMint only.
 * The sell offer and the XRP escrow stay unsigned: the purchaser signs
 * EscrowCreate. FinishAfter and CancelAfter are Ripple Epoch.
 */

const anchors = require("../director/anchors");
const { rpcCall } = require("../director/snapshot");
const probe = require("./probe-amendments");
const math = require("./oracle-math");
const policy = require("../runtime/policy");

const HELP = `Usage: node src/frontier/oracle-ticket.js [--dry-run] [--live] [--xrpl-http URL] [--labor-units N]

Reads ledger_entry for W5 oracle document 1 and prices a work-ticket from that object.
Does not read amm_info. Does not use a local float. Refuses when the oracle is missing.
--dry-run is the default and does not read a seed.
--live requires FOUNDRY_DAEMON_LIVE=yes, refuses CI, and submits only the W2 NFTokenMint.`;

function parseArgs(argv) {
  const out = { dryRun: true, live: false, help: false, xrplHttp: null, laborUnits: 1 };
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
    } else if (arg === "--labor-units") {
      out.laborUnits = Number(args[i + 1]);
      i += 1;
      if (!Number.isInteger(out.laborUnits)) throw math.coded("--labor-units needs an integer", "ARGS");
    } else throw math.coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function missingOracle(error) {
  const text = String((error && error.message) || error || "");
  return /entryNotFound|actNotFound/i.test(text);
}

async function readPrice(http, fetchImpl) {
  const info = await rpcCall(http, "server_info", {}, fetchImpl);
  const server = probe.readServer(info);
  let entry;
  try {
    entry = await rpcCall(http, "ledger_entry", math.ledgerEntryParams(), fetchImpl);
  } catch (error) {
    if (missingOracle(error)) {
      throw math.coded("ledger oracle is missing; refusing to price from a local float", "ORACLE_MISSING");
    }
    throw error;
  }
  const price = math.readOraclePrice(entry);
  if (price.account !== anchors.WALLETS.W5.address) {
    throw math.coded("oracle Owner is not W5", "ORACLE");
  }
  if (price.oracle_document_id !== math.ORACLE_DOCUMENT_ID) {
    throw math.coded("oracle document id is not 1", "ORACLE");
  }
  return { server, price };
}

function publicBody(mode, price, ticket, seedReads) {
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: mode.live ? "W2_REGULAR_SEED" : null,
    network: "xrpl:1",
    network_id: 1,
    action: "oracle_ticket",
    source: "ledger_entry",
    oracle_id: price.oracle_id,
    oracle: price,
    ticket,
    purchaser_signs_escrow: true,
    epoch: "escrow FinishAfter and CancelAfter are Ripple Epoch",
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
  let http;
  try {
    http = probe.resolveHttp(env, mode.xrplHttp);
  } catch (error) {
    if (error && error.code) throw error;
    const message = error && error.message ? error.message : String(error);
    throw math.coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
  const read = await readPrice(http, options.fetchImpl || globalThis.fetch);
  const ticket = math.buildTicket(read.price, { now, labor_units: mode.laborUnits });
  if (ticket.escrow.FinishAfter > 1_000_000_000) {
    throw math.coded("refusing a Unix FinishAfter on the work-ticket escrow", "EPOCH");
  }
  if (!mode.live) {
    const body = publicBody(mode, read.price, ticket, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    return 0;
  }
  const state = options.state;
  if (!state) throw math.coded("refusing --live without director state", "STALE");
  if (policy.isStale(state, now)) throw math.coded("refusing to sign on stale director state", "STALE");
  const regular = policy.regularKey(state, "W2");
  const daemon = options.daemon || require("../runtime/daemon");
  const submit = options.submit || ((tx, keyEnv, regularKey) => daemon.signAndSubmit(tx, keyEnv, regularKey, env, loadSeed));
  const submitted = await submit(ticket.mint, "W2_REGULAR_SEED", regular);
  if (!submitted || submitted.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(submitted.hash || "").toUpperCase())) {
    throw math.coded("oracle ticket mint did not succeed", "SUBMIT");
  }
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    key_env: "W2_REGULAR_SEED",
    network: "xrpl:1",
    network_id: 1,
    action: "oracle_ticket",
    source: "ledger_entry",
    oracle_id: read.price.oracle_id,
    quote_xrp_per_aeth: read.price.quote_xrp_per_aeth,
    labor_drops: ticket.labor_drops,
    hash: String(submitted.hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    sell: ticket.sell,
    escrow: ticket.escrow,
    purchaser_signs_escrow: true,
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
  readPrice,
  run,
};
