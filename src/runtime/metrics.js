"use strict";

/**
 * Public counters for the desk. Hashes come from lab/ledger-log.jsonl.
 * A missing hash stays null. This module does not invent one.
 * A missing file is seeded from market/pnl.md. A failed parse does not invent a number.
 * oracle_id, last_oracle, mpt_issuance_id, and domain_id already on disk stay
 * unless the caller passes clear. A partial heartbeat rewrite must not drop them.
 *
 * unique_inbound is the set of classic `buyer` addresses, `x402_hit` payers,
 * and `grant_paid` destinations that are absent from WALLETS.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const guard = require("../x402-outbound-guard");
const hits = require("../x402-hits");
const outboundRecord = require("../x402-outbound-record");
const grantRecord = require("../grants/record");
const policy = require("./policy");

const COUNT_KEYS = ["x402_hits", "x402_outbound_hits", "grants_paid", "inbound_counterparties"];
const HASH_KEYS = ["last_grant_hash", "last_outbound_hash", "last_heartbeat_hash"];
const FRONTIER_KEYS = ["oracle_id", "last_oracle", "mpt_issuance_id", "domain_id"];
const ISSUANCE_ID_RE = /^[0-9A-F]{48}$/;

function ioOf(io) {
  return {
    existsSync: (io && io.existsSync) || fs.existsSync,
    readFileSync: (io && io.readFileSync) || fs.readFileSync,
    writeFileSync: (io && io.writeFileSync) || fs.writeFileSync,
    mkdirSync: (io && io.mkdirSync) || fs.mkdirSync,
  };
}

function metricsPath(root) {
  return path.join(root, "lab", "metrics.json");
}

function emptyHeartbeat() {
  return { hash: null, ledger_index: null, ts: null };
}

function emptyOracle() {
  return {
    hash: null,
    oracle_id: null,
    ledger_index: null,
    last_update_time: null,
    quote_xrp_per_aeth: null,
    ts: null,
  };
}

function issuanceOrNull(value, label) {
  if (value == null) return null;
  const id = String(value).toUpperCase();
  if (!ISSUANCE_ID_RE.test(id)) {
    throw policy.coded(`${label} is not a 48-hex MPT issuance id`, "METRICS");
  }
  return id;
}

function assertMpt(doc) {
  if (!Object.prototype.hasOwnProperty.call(doc, "mpt_issuance_id") || doc.mpt_issuance_id == null) return;
  doc.mpt_issuance_id = issuanceOrNull(doc.mpt_issuance_id, "mpt_issuance_id");
}

function assertDomain(doc) {
  if (!Object.prototype.hasOwnProperty.call(doc, "domain_id") || doc.domain_id == null) return;
  doc.domain_id = hashOrNull(doc.domain_id, "domain_id");
}

function assertOracle(doc) {
  if (doc.oracle_id != null) hashOrNull(doc.oracle_id, "oracle_id");
  if (doc.last_oracle == null) return;
  const row = doc.last_oracle;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw policy.coded("metrics.json last_oracle is not an object", "METRICS");
  }
  policy.assertNoSeedFields(row);
  hashOrNull(row.hash, "last_oracle.hash");
  if (row.oracle_id != null) hashOrNull(row.oracle_id, "last_oracle.oracle_id");
  if (!(row.ledger_index == null || (Number.isInteger(row.ledger_index) && row.ledger_index > 0))) {
    throw policy.coded("metrics.json last_oracle.ledger_index is not a ledger", "METRICS");
  }
  if (!(row.last_update_time == null || (Number.isInteger(row.last_update_time) && row.last_update_time > 0))) {
    throw policy.coded("metrics.json last_oracle.last_update_time is not unix seconds", "METRICS");
  }
  if (row.quote_xrp_per_aeth != null && !/^\d+(\.\d+)?$/.test(String(row.quote_xrp_per_aeth))) {
    throw policy.coded("metrics.json last_oracle.quote_xrp_per_aeth is not a decimal", "METRICS");
  }
  if (!(row.ts == null || typeof row.ts === "string")) {
    throw policy.coded("metrics.json last_oracle.ts is not a timestamp", "METRICS");
  }
}

function parsePnlCounts(text) {
  const counts = {};
  const errors = [];
  const source = String(text || "");
  for (const key of COUNT_KEYS) {
    const match = source.match(new RegExp(`^\\| ${key} \\|\\s*\\**(\\d+)\\**`, "m"));
    if (!match) errors.push(`${key} missing`);
    else counts[key] = Number(match[1]);
  }
  return { counts, errors };
}

function hashOrNull(value, label) {
  if (value == null) return null;
  const hash = String(value).toUpperCase();
  if (!anchors.HASH_RE.test(hash)) {
    throw policy.coded(`${label} is not a 64-hex ledger hash`, "METRICS");
  }
  return hash;
}

function assertDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw policy.coded("metrics.json is not an object", "METRICS");
  }
  policy.assertNoSeedFields(doc);
  if (typeof doc.updated_at !== "string" || Number.isNaN(Date.parse(doc.updated_at))) {
    throw policy.coded("metrics.json updated_at is not a timestamp", "METRICS");
  }
  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(doc[key]) || doc[key] < 0) {
      throw policy.coded(`metrics.json ${key} is not a count`, "METRICS");
    }
  }
  for (const key of HASH_KEYS) {
    hashOrNull(doc[key], key);
  }
  if (doc.last_heartbeat != null) {
    const beat = doc.last_heartbeat;
    if (!beat || typeof beat !== "object" || Array.isArray(beat)) {
      throw policy.coded("metrics.json last_heartbeat is not an object", "METRICS");
    }
    policy.assertNoSeedFields(beat);
    hashOrNull(beat.hash, "last_heartbeat.hash");
    if (!(beat.ledger_index == null || (Number.isInteger(beat.ledger_index) && beat.ledger_index > 0))) {
      throw policy.coded("metrics.json last_heartbeat.ledger_index is not a ledger", "METRICS");
    }
    if (!(beat.ts == null || typeof beat.ts === "string")) {
      throw policy.coded("metrics.json last_heartbeat.ts is not a timestamp", "METRICS");
    }
  }
  assertOracle(doc);
  assertMpt(doc);
  assertDomain(doc);
  return doc;
}

function skeletonFromPnl(text, now) {
  const parsed = parsePnlCounts(text);
  if (parsed.errors.length) {
    throw policy.coded(`refusing to seed metrics: ${parsed.errors.join("; ")}`, "METRICS");
  }
  const doc = {
    updated_at: anchors.formatChicago(now || new Date()),
    x402_hits: parsed.counts.x402_hits,
    x402_outbound_hits: parsed.counts.x402_outbound_hits,
    grants_paid: parsed.counts.grants_paid,
    inbound_counterparties: parsed.counts.inbound_counterparties,
    last_grant_hash: null,
    last_outbound_hash: null,
    last_heartbeat_hash: null,
    last_heartbeat: emptyHeartbeat(),
    oracle_id: null,
    last_oracle: emptyOracle(),
    mpt_issuance_id: null,
    domain_id: null,
  };
  return assertDoc(doc);
}

function readMetrics(root, io) {
  const file = metricsPath(root);
  const disk = ioOf(io);
  if (!disk.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(disk.readFileSync(file, "utf8"));
  } catch (error) {
    throw policy.coded(`metrics.json is not JSON: ${error.message}`, "METRICS");
  }
  return assertDoc(doc);
}

function frontierHeld(key, value) {
  if (value == null) return false;
  if (key !== "last_oracle") return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return ["hash", "oracle_id", "ledger_index", "last_update_time", "quote_xrp_per_aeth", "ts"].some(
    (field) => value[field] != null
  );
}

function blankFrontier(key) {
  return key === "last_oracle" ? emptyOracle() : null;
}

function applyFrontier(doc, previous, clear) {
  const allowed = new Set(
    Array.isArray(clear) ? clear.filter((key) => FRONTIER_KEYS.includes(key)) : []
  );
  const prior = previous || {};
  for (const key of FRONTIER_KEYS) {
    if (frontierHeld(key, doc[key])) continue;
    if (frontierHeld(key, prior[key]) && !allowed.has(key)) {
      doc[key] = JSON.parse(JSON.stringify(prior[key]));
      continue;
    }
    doc[key] = blankFrontier(key);
  }
  return doc;
}

function writeMetrics(root, doc, io, opts) {
  const disk = ioOf(io);
  const file = metricsPath(root);
  const previous = disk.existsSync(file) ? readMetrics(root, disk) : null;
  const clean = assertDoc(applyFrontier(doc, previous, opts && opts.clear));
  disk.mkdirSync(path.dirname(file), { recursive: true });
  disk.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

function seedIfMissing(root, now, io) {
  const disk = ioOf(io);
  const existing = readMetrics(root, disk);
  if (existing) return existing;
  const pnlPath = path.join(root, "market", "pnl.md");
  if (!disk.existsSync(pnlPath)) {
    throw policy.coded("refusing to seed metrics without market/pnl.md", "METRICS");
  }
  const doc = skeletonFromPnl(disk.readFileSync(pnlPath, "utf8"), now);
  return writeMetrics(root, doc, disk);
}

function parseJsonl(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip torn lines */
    }
  }
  return rows;
}

function isSeedShaped(value) {
  const text = String(value);
  return anchors.FAMILY_SEED_RE.test(text) || anchors.EMBEDDED_SEED_RE.test(text) || /sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text);
}

function considerInbound(seen, value, labeled) {
  if (value == null || value === "") return;
  if (isSeedShaped(value)) {
    throw policy.coded("refusing a seed-shaped counterparty in public records", "SEED");
  }
  if (!anchors.ADDRESS_RE.test(value)) return;
  if (labeled && labeled.has(value)) return;
  seen.add(value);
}

function uniqueInbound(text, labeled) {
  const index = labeled || guard.foundryIndex();
  const seen = new Set();
  for (const row of parseJsonl(text)) {
    if (!row || typeof row !== "object") continue;
    const action = String(row.action || row.event || "");
    if (row.buyer) considerInbound(seen, row.buyer, index);
    if (action === "x402_hit" && row.payer) considerInbound(seen, row.payer, index);
    if (action === "grant_paid" && row.destination) considerInbound(seen, row.destination, index);
  }
  return Array.from(seen).sort();
}

function lastValid(rows, pred) {
  let found = null;
  for (const row of rows) {
    if (!row || !pred(row)) continue;
    const hash = String(row.hash || "").toUpperCase();
    if (!anchors.HASH_RE.test(hash)) continue;
    found = {
      hash,
      ledger_index: Number.isInteger(row.ledger_index) && row.ledger_index > 0 ? row.ledger_index : null,
      ts: typeof row.ts === "string" ? row.ts : null,
    };
  }
  return found;
}

function extract(text, labeled) {
  const rows = parseJsonl(text);
  const grant = lastValid(rows, (row) => row.action === "grant_paid" && row.result === "tesSUCCESS");
  const outbound = lastValid(rows, (row) => row.action === "x402_outbound");
  const beat = lastValid(rows, (row) => row.action === "heartbeat" || row.event === "heartbeat");
  const inbound = uniqueInbound(text, labeled);
  return {
    x402_hits: hits.countHits(text),
    x402_outbound_hits: outboundRecord.countOutbound(text),
    grants_paid: grantRecord.countGrants(text),
    inbound,
    last_grant_hash: grant ? grant.hash : null,
    last_outbound_hash: outbound ? outbound.hash : null,
    last_heartbeat_hash: beat ? beat.hash : null,
    heartbeat: beat
      ? { hash: beat.hash, ledger_index: beat.ledger_index, ts: beat.ts }
      : emptyHeartbeat(),
  };
}

function updateInboundPnl(text, count) {
  const re = /^\| inbound_counterparties \|[^|\n]*\|[^|\n]*\|$/m;
  if (!re.test(text)) return text;
  return text.replace(
    re,
    `| inbound_counterparties | **${count}** | distinct buyers and grant destinations outside WALLETS |`
  );
}

function refresh(root, opts) {
  const options = opts || {};
  const disk = ioOf(options.io);
  const now = options.now || new Date();
  const ledgerPath = options.ledgerPath || path.join(root, "lab", "ledger-log.jsonl");
  const text = disk.existsSync(ledgerPath) ? disk.readFileSync(ledgerPath, "utf8") : "";
  const extracted = extract(text, options.labeled);
  const current = (() => {
    try {
      return readMetrics(root, disk);
    } catch (error) {
      if (error && error.code === "METRICS") throw error;
      return null;
    }
  })();
  let heartbeat = extracted.heartbeat;
  let lastHeartbeatHash = extracted.last_heartbeat_hash;
  if (!lastHeartbeatHash && current && current.last_heartbeat_hash) {
    lastHeartbeatHash = current.last_heartbeat_hash;
    heartbeat = current.last_heartbeat || {
      hash: current.last_heartbeat_hash,
      ledger_index: null,
      ts: null,
    };
  }
  const doc = {
    updated_at: anchors.formatChicago(now),
    x402_hits: extracted.x402_hits,
    x402_outbound_hits: extracted.x402_outbound_hits,
    grants_paid: extracted.grants_paid,
    inbound_counterparties: extracted.inbound.length,
    last_grant_hash: extracted.last_grant_hash,
    last_outbound_hash: extracted.last_outbound_hash,
    last_heartbeat_hash: lastHeartbeatHash,
    last_heartbeat: {
      hash: heartbeat && heartbeat.hash ? heartbeat.hash : null,
      ledger_index: heartbeat && Number.isInteger(heartbeat.ledger_index) ? heartbeat.ledger_index : null,
      ts: heartbeat && typeof heartbeat.ts === "string" ? heartbeat.ts : null,
    },
    oracle_id: current && current.oracle_id ? current.oracle_id : null,
    last_oracle: current && current.last_oracle ? current.last_oracle : emptyOracle(),
    mpt_issuance_id: current && current.mpt_issuance_id ? current.mpt_issuance_id : null,
    domain_id: current && current.domain_id ? current.domain_id : null,
  };
  const pnlPath = options.pnlPath || path.join(root, "market", "pnl.md");
  if (disk.existsSync(pnlPath)) {
    const pnl = disk.readFileSync(pnlPath, "utf8");
    const next = updateInboundPnl(pnl, doc.inbound_counterparties);
    if (next !== pnl) disk.writeFileSync(pnlPath, next);
  }
  return writeMetrics(root, doc, disk);
}

function recordHeartbeat(root, event, io) {
  const hash = hashOrNull(event && event.hash, "heartbeat hash");
  if (!hash) throw policy.coded("refusing heartbeat metrics without a ledger hash", "RECORD");
  const disk = ioOf(io);
  const current = readMetrics(root, disk) || seedIfMissing(root, event && event.now, disk);
  const ledger = event && event.ledger_index;
  current.updated_at = anchors.formatChicago((event && event.now) || new Date());
  current.last_heartbeat_hash = hash;
  current.last_heartbeat = {
    hash,
    ledger_index: Number.isInteger(ledger) && ledger > 0 ? ledger : null,
    ts: event && typeof event.ts === "string" ? event.ts : null,
  };
  return writeMetrics(root, current, disk);
}

function recordOracle(root, event, io) {
  const hash = hashOrNull(event && event.hash, "oracle hash");
  if (!hash) throw policy.coded("refusing oracle metrics without a ledger hash", "RECORD");
  const disk = ioOf(io);
  const current = readMetrics(root, disk) || seedIfMissing(root, event && event.now, disk);
  const oracleId = event && event.oracle_id != null ? hashOrNull(event.oracle_id, "oracle_id") : null;
  const quote = event && event.quote_xrp_per_aeth;
  if (quote != null && !/^\d+(\.\d+)?$/.test(String(quote))) {
    throw policy.coded("refusing oracle metrics with a non-decimal quote", "RECORD");
  }
  const ledger = event && event.ledger_index;
  const updated = event && event.last_update_time;
  current.updated_at = anchors.formatChicago((event && event.now) || new Date());
  current.oracle_id = oracleId;
  current.last_oracle = {
    hash,
    oracle_id: oracleId,
    ledger_index: Number.isInteger(ledger) && ledger > 0 ? ledger : null,
    last_update_time: Number.isInteger(updated) && updated > 0 ? updated : null,
    quote_xrp_per_aeth: quote == null ? null : String(quote),
    ts: event && typeof event.ts === "string" ? event.ts : null,
  };
  return writeMetrics(root, current, disk);
}

function recordDomain(root, event, io) {
  if (!hashOrNull(event && event.hash, "domain hash")) {
    throw policy.coded("refusing domain metrics without a ledger hash", "RECORD");
  }
  const domainId = hashOrNull(event && event.domain_id, "domain_id");
  if (!domainId) throw policy.coded("refusing domain metrics without a domain id", "RECORD");
  const disk = ioOf(io);
  const current = readMetrics(root, disk) || seedIfMissing(root, event && event.now, disk);
  current.updated_at = anchors.formatChicago((event && event.now) || new Date());
  current.domain_id = domainId;
  if (event && event.ts != null && typeof event.ts !== "string") {
    throw policy.coded("domain metrics ts is not a timestamp", "RECORD");
  }
  return writeMetrics(root, current, disk);
}

function recordMpt(root, event, io) {
  if (!hashOrNull(event && event.hash, "mpt hash")) {
    throw policy.coded("refusing MPT metrics without a ledger hash", "RECORD");
  }
  const issuance = issuanceOrNull(event && event.mpt_issuance_id, "mpt_issuance_id");
  if (!issuance) throw policy.coded("refusing MPT metrics without an issuance id", "RECORD");
  const disk = ioOf(io);
  const current = readMetrics(root, disk) || seedIfMissing(root, event && event.now, disk);
  const ledger = event && event.ledger_index;
  current.updated_at = anchors.formatChicago((event && event.now) || new Date());
  current.mpt_issuance_id = issuance;
  if (event && event.ts != null && typeof event.ts !== "string") {
    throw policy.coded("mpt metrics ts is not a timestamp", "RECORD");
  }
  return writeMetrics(root, current, disk);
}

module.exports = {
  COUNT_KEYS,
  HASH_KEYS,
  FRONTIER_KEYS,
  writeMetrics,
  parsePnlCounts,
  skeletonFromPnl,
  readMetrics,
  seedIfMissing,
  recordHeartbeat,
  recordOracle,
  recordMpt,
  recordDomain,
  emptyHeartbeat,
  emptyOracle,
  uniqueInbound,
  extract,
  updateInboundPnl,
  refresh,
};
