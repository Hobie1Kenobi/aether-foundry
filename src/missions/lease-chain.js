"use strict";

/**
 * Append-only lease history. Records are hash-chained. A later grant
 * adds a line. It does not rewrite or delete an earlier line.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { coded } = require("./ledger");

const FILE = "lease-history.jsonl";

function canonical(record) {
  const copy = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "hash") continue;
    copy[key] = record[key];
  }
  return JSON.stringify(copy);
}

function hashRecord(record) {
  return crypto.createHash("sha256").update(canonical(record)).digest("hex");
}

function historyPath(home) {
  return path.join(home, FILE);
}

function readHistory(home) {
  const file = historyPath(home);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => JSON.parse(line));
}

function assertChain(records) {
  let prev = "";
  for (const record of records) {
    if (!record || typeof record.hash !== "string" || record.hash !== hashRecord(record)) {
      throw coded("lease history hash does not match the record", "TAMPER");
    }
    if (record.prev_hash !== prev) throw coded("lease history chain is broken", "TAMPER");
    prev = record.hash;
  }
  return true;
}

function openGeneration(records) {
  const used = new Set(records.filter((row) => row && row.type === "lease.used").map((row) => row.lease_id));
  const open = records.filter((row) => row && row.type === "lease.issued" && !used.has(row.lease_id));
  if (open.length > 1) throw coded("more than one lease generation is unused", "TAMPER");
  return open[0] || null;
}

function generationUsed(records) {
  return records.some((row) => row && row.type === "lease.used");
}

function seenInvoices(records) {
  return new Set(records.filter((row) => row && row.type === "lease.used" && row.invoice_id).map((row) => row.invoice_id));
}

function appendRecord(home, fields) {
  const records = readHistory(home);
  assertChain(records);
  const record = Object.assign({}, fields, {
    prev_hash: records.length ? records[records.length - 1].hash : "",
  });
  record.hash = hashRecord(record);
  const file = historyPath(home);
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

module.exports = {
  FILE,
  canonical,
  hashRecord,
  historyPath,
  readHistory,
  assertChain,
  openGeneration,
  generationUsed,
  seenInvoices,
  appendRecord,
};
