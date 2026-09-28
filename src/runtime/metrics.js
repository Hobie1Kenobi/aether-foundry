"use strict";

/**
 * Public counters for the desk. Hashes stay null until a tesSUCCESS archive.
 * A missing file is seeded from market/pnl.md. A failed parse does not invent a number.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const policy = require("./policy");

const COUNT_KEYS = ["x402_hits", "x402_outbound_hits", "grants_paid", "inbound_counterparties"];
const HASH_KEYS = ["last_grant_hash", "last_outbound_hash", "last_heartbeat_hash"];

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

function writeMetrics(root, doc, io) {
  const clean = assertDoc(doc);
  const disk = ioOf(io);
  const file = metricsPath(root);
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

module.exports = {
  COUNT_KEYS,
  HASH_KEYS,
  parsePnlCounts,
  skeletonFromPnl,
  readMetrics,
  seedIfMissing,
  recordHeartbeat,
  emptyHeartbeat,
};
