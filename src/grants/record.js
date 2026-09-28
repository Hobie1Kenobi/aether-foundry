"use strict";

const fs = require("fs");
const path = require("path");
const policy = require("./policy");

const HASH_RE = /^[0-9A-F]{64}$/;

function assertRow(row) {
  if (!row || row.result !== "tesSUCCESS") {
    throw policy.coded("refusing to record a grant that did not succeed", "RECORD");
  }
  const hash = String(row.hash || "").toUpperCase();
  if (!HASH_RE.test(hash)) throw policy.coded("refusing to record a grant without a hash", "RECORD");
  if (!policy.isClassic(row.destination)) throw policy.coded("refusing to record a grant without a destination", "RECORD");
  if (!policy.REASONS.includes(row.reason)) throw policy.coded("refusing to record an unknown grant reason", "RECORD");
  return Object.assign({}, row, { hash, action: "grant_paid", result: "tesSUCCESS" });
}

function hashPresent(text, hash) {
  return parseLines(text).some((row) => row && String(row.hash || "").toUpperCase() === hash && row.action === "grant_paid");
}

function parseLines(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function countGrants(text) {
  const seen = new Set();
  for (const row of parseLines(text)) {
    if (!row || row.action !== "grant_paid" || !row.hash) continue;
    seen.add(String(row.hash).toUpperCase());
  }
  return seen.size;
}

function updatePnl(text, count) {
  const re = /^\| grants_paid \|[^|\n]*\|[^|\n]*\|$/m;
  if (!re.test(text)) throw policy.coded("market/pnl.md is missing the grants_paid row", "RECORD");
  return text.replace(
    re,
    `| grants_paid | ${count} | append via npm run grants:pay -- --record |`
  );
}

function appendLine(file, line, io) {
  const read = io.readFileSync;
  const write = io.writeFileSync;
  const mkdir = io.mkdirSync;
  const exists = io.existsSync;
  mkdir(path.dirname(file), { recursive: true });
  const prev = exists(file) ? read(file, "utf8") : "";
  const prefix = prev.length && !prev.endsWith("\n") ? "\n" : "";
  write(file, `${prev}${prefix}${line}`);
}

function resultsBlock(row) {
  return `
## Grant ${row.ts}

W6 paid a non-labeled counterparty. Recorded only after \`tesSUCCESS\`.

| Field | Value |
|-------|-------|
| Destination | \`${row.destination}\` |
| Reason | \`${row.reason}\` |
| Drops | \`${row.amount_drops}\` |
| Hash | \`${row.hash}\` |
| Signer | \`${row.signer}\` |
| Experiment | \`${row.experiment}\` |
`;
}

function recordGrant(row, opts) {
  const event = assertRow(row);
  const io = opts.io || fs;
  const grantsPath = opts.grantsPath;
  const existingGrants = io.existsSync(grantsPath) ? io.readFileSync(grantsPath, "utf8") : "";
  const duplicate = hashPresent(existingGrants, event.hash);
  if (!duplicate) appendLine(grantsPath, `${JSON.stringify(event)}\n`, io);
  if (!opts.public) return { appended: !duplicate, public: false, hash: event.hash };
  const ledgerPath = opts.ledgerPath;
  const ledger = io.existsSync(ledgerPath) ? io.readFileSync(ledgerPath, "utf8") : "";
  let nextLedger = ledger;
  if (!hashPresent(ledger, event.hash)) {
    const prefix = nextLedger.length && !nextLedger.endsWith("\n") ? "\n" : "";
    nextLedger = `${nextLedger}${prefix}${JSON.stringify(event)}\n`;
    io.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    io.writeFileSync(ledgerPath, nextLedger);
  }
  const count = countGrants(nextLedger);
  const pnlPath = opts.pnlPath;
  const pnl = io.readFileSync(pnlPath, "utf8");
  const nextPnl = updatePnl(pnl, count);
  if (nextPnl !== pnl) io.writeFileSync(pnlPath, nextPnl);
  const resultsPath = opts.resultsPath;
  const results = io.existsSync(resultsPath) ? io.readFileSync(resultsPath, "utf8") : "";
  if (!results.includes(event.hash)) {
    appendLine(resultsPath, resultsBlock(event), io);
  }
  if (opts.root) {
    require("../runtime/metrics").refresh(opts.root, {
      io,
      now: event.ts ? new Date(event.ts) : new Date(),
      ledgerPath: opts.ledgerPath,
      pnlPath: opts.pnlPath,
    });
  }
  return { appended: !duplicate, public: true, hash: event.hash, count };
}

module.exports = {
  assertRow,
  countGrants,
  updatePnl,
  recordGrant,
  hashPresent,
};
