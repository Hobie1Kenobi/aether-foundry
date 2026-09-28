#!/usr/bin/env node
"use strict";

/**
 * Protocol amendment probe. Read-only XRPL Testnet HTTP.
 * Refuses any network id other than 1. Does not sign, load seeds, or invent hashes.
 * On RPC failure the process exits non-zero and does not write lab/frontier/amendments.json.
 *
 *   npm run frontier:probe
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const schema = require("../director/schema");
const { rpcCall } = require("../director/snapshot");

const OUT_REL = path.join("lab", "frontier", "amendments.json");

const BANDS = {
  A: [
    "Credentials",
    "PermissionedDomains",
    "PermissionedDEX",
    "TokenEscrow",
    "MPTokensV1",
    "PriceOracle",
    "DynamicNFT",
    "DID",
    "Clawback",
    "DeepFreeze",
    "DepositAuth",
  ],
  B: ["BatchV1_1", "fixBatchV1_2", "TicketBatch", "PermissionDelegationV1_1"],
  C: [
    "SingleAssetVault",
    "LendingProtocol",
    "LendingProtocolV1_1",
    "Sponsor",
    "ConfidentialTransfer",
    "DynamicMPT",
    "XChainBridge",
  ],
};

const WATCHED = BANDS.A.concat(BANDS.B, BANDS.C);

const HELP = `Usage: node src/frontier/probe-amendments.js [--root DIR] [--out FILE] [--xrpl-http URL]

Reads server_info and feature from XRPL Testnet HTTP and writes lab/frontier/amendments.json.
URL order: --xrpl-http, FOUNDRY_XRPL_HTTP, XRPL_HTTP, XRPL_RPC_URL, then the public Testnet default.
Refuses network id other than 1. Does not sign. Does not invent an amendment hash.
If RPC fails, exits non-zero and leaves any existing amendments.json untouched.`;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function parseArgs(argv) {
  const out = {
    root: anchors.repoRoot(),
    out: null,
    xrplHttp: null,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--root" || arg === "--out" || arg === "--xrpl-http") {
      const value = args[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === "--root") out.root = path.resolve(value);
      else if (arg === "--out") out.out = path.resolve(value);
      else out.xrplHttp = value;
    } else {
      throw new Error(`unknown arg ${arg}`);
    }
  }
  return out;
}

function firstEnv(env, keys) {
  for (const key of keys) {
    const value = env && env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function publicRpc(raw) {
  const checked = anchors.assertXrplTestnetUrl(String(raw || "").trim());
  let url;
  try {
    url = new URL(checked);
  } catch {
    fail("refusing unparseable XRPL url", "MAINNET");
  }
  if (url.username || url.password) fail("refusing XRPL url with userinfo", "SCHEMA");
  if (url.search || url.hash) fail("refusing XRPL url with query or fragment", "SCHEMA");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  let text = url.toString();
  if (text.endsWith("/") && (url.pathname === "/" || url.pathname === "")) text = text.slice(0, -1);
  return text;
}

function resolveHttp(env, override) {
  const raw = override || firstEnv(env, ["FOUNDRY_XRPL_HTTP", "XRPL_HTTP", "XRPL_RPC_URL"]) || anchors.XRPL_HTTP;
  return publicRpc(raw);
}

function hashOf(key, row, name) {
  const fromKey = key != null && anchors.HASH_RE.test(String(key).toUpperCase()) ? String(key).toUpperCase() : null;
  const rawRow = row && row.hash != null ? String(row.hash).toUpperCase() : null;
  const fromRow = rawRow && anchors.HASH_RE.test(rawRow) ? rawRow : null;
  if (rawRow && !fromRow) fail(`feature response hash for ${name} is not 64 hex`, "RPC");
  if (fromKey && fromRow && fromKey !== fromRow) fail(`feature response hash for ${name} disagrees with the map key`, "RPC");
  return fromKey || fromRow || null;
}

function indexFeatures(feature) {
  const raw = feature && feature.features;
  if (!raw || typeof raw !== "object") fail("feature response omitted features", "RPC");
  const entries = Array.isArray(raw) ? raw : Object.entries(raw);
  if (entries.length === 0) fail("feature response omitted features", "RPC");
  const rows = Array.isArray(raw)
    ? raw.map((row) => Object.assign({}, row))
    : entries.map(([key, row]) => {
        const copy = Object.assign({}, row || {});
        const keyHash = hashOf(key, copy, copy.name || key);
        if (!keyHash) fail("feature response omitted amendment hash", "RPC");
        if (copy.hash != null && String(copy.hash).toUpperCase() !== keyHash) {
          fail(`feature response hash for ${copy.name || key} disagrees with the map key`, "RPC");
        }
        copy.hash = keyHash;
        return copy;
      });
  const byName = new Map();
  for (const row of rows) {
    if (!row || row.name == null) continue;
    const name = String(row.name);
    const hash = hashOf(null, row, name);
    if (!hash) fail(`feature response omitted hash for ${name}`, "RPC");
    const prev = byName.get(name);
    if (prev && (prev.hash !== hash || prev.enabled !== row.enabled || prev.supported !== row.supported)) {
      fail(`feature response duplicated ${name}`, "RPC");
    }
    byName.set(name, Object.assign({}, row, { hash }));
  }
  return byName;
}

function readVetoed(row, name) {
  if (row.vetoed == null) return null;
  if (typeof row.vetoed === "boolean" || typeof row.vetoed === "string") return row.vetoed;
  fail(`feature ${name} vetoed is not a flag`, "RPC");
}

function readAmendments(feature) {
  const byName = indexFeatures(feature);
  return WATCHED.map((name) => {
    const row = byName.get(name);
    if (!row) fail(`feature response omitted ${name}; refusing to mark it disabled`, "RPC");
    if (typeof row.enabled !== "boolean" || typeof row.supported !== "boolean") {
      fail(`feature response omitted boolean flags for ${name}`, "RPC");
    }
    const hash = hashOf(null, row, name);
    if (!hash) fail(`feature response omitted hash for ${name}`, "RPC");
    return {
      name,
      enabled: row.enabled,
      supported: row.supported,
      hash,
      vetoed: readVetoed(row, name),
    };
  });
}

function readServer(info) {
  const inner = info && info.info;
  if (!inner || typeof inner !== "object") fail("server_info omitted info", "RPC");
  if (inner.network_id == null || inner.network_id === "") fail("server_info omitted network_id", "RPC");
  const networkId = anchors.assertNetworkId(inner.network_id, anchors.XRPL_NETWORK_ID);
  if (typeof inner.build_version !== "string" || !inner.build_version.trim()) {
    fail("server_info omitted build_version", "RPC");
  }
  return {
    network_id: networkId,
    build_version: inner.build_version,
  };
}

function assemble(server, amendments, rpc, now) {
  const clock = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return {
    probed_at: anchors.formatChicago(clock),
    rpc,
    network_id: server.network_id,
    build_version: server.build_version,
    amendments,
  };
}

async function collect(opts) {
  const http = opts.http;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const info = await rpcCall(http, "server_info", {}, fetchImpl);
  const server = readServer(info);
  const feature = await rpcCall(http, "feature", {}, fetchImpl);
  const amendments = readAmendments(feature);
  return assemble(server, amendments, http, opts.now);
}

function writeAmendments(file, doc) {
  schema.assertNoSecrets(doc);
  if (!doc || !Array.isArray(doc.amendments) || doc.amendments.length !== WATCHED.length) {
    fail("refusing to write an incomplete amendment map", "RPC");
  }
  for (const row of doc.amendments) {
    if (!anchors.HASH_RE.test(row.hash || "")) fail(`refusing invented hash for ${row.name}`, "RPC");
    if (typeof row.enabled !== "boolean") fail(`refusing non-boolean enabled for ${row.name}`, "RPC");
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  schema.assertNoSecrets(JSON.parse(text));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw error;
  }
}

async function run(argv, deps = {}) {
  const args = parseArgs(argv || process.argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const env = deps.env || process.env;
  const http = resolveHttp(env, args.xrplHttp);
  const outPath = args.out || path.join(args.root, OUT_REL);
  const doc = await collect({
    http,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  writeAmendments(outPath, doc);
  if (!deps.silent) {
    const disabled = doc.amendments.filter((row) => row.enabled === false).map((row) => row.name);
    console.log(
      `wrote ${outPath} build=${doc.build_version} network_id=${doc.network_id} disabled=${disabled.join(",")}`
    );
  }
  return 0;
}

if (require.main === module) {
  run(process.argv).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  HELP,
  OUT_REL,
  BANDS,
  WATCHED,
  parseArgs,
  publicRpc,
  resolveHttp,
  readServer,
  readAmendments,
  assemble,
  collect,
  writeAmendments,
  run,
};
