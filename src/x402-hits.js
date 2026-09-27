#!/usr/bin/env node
"use strict";

/**
 * Append a desk x402_hit to the P&L hygiene path.
 * The Vercel desk cannot write these files. Pipe the JSON response, or pass --file.
 *
 *   npm run x402:hit -- --file /tmp/x402-reserve.json
 *   curl -sS ... | npm run x402:hit
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function countHits(text) {
  const seen = new Set();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.action !== "x402_hit" || !row.hash || !row.sku) continue;
    seen.add(`${row.sku}:${String(row.hash).toUpperCase()}`);
  }
  return seen.size;
}

function normalize(input) {
  const event = input && input.x402_hit ? input.x402_hit : input;
  if (!event || typeof event !== "object") {
    throw new Error("expected an x402_hit object or a desk response that contains one");
  }
  if (!event.hash || !event.sku) throw new Error("x402_hit needs hash and sku");
  if (event.network === "xrpl:0") throw new Error("refusing a mainnet x402_hit");
  return {
    ts: event.ts || new Date().toISOString(),
    action: "x402_hit",
    sku: event.sku,
    network: event.network || "xrpl:1",
    pay_to: event.pay_to,
    amount_drops: event.amount_drops,
    amount_xrp: event.amount_xrp,
    source_tag: event.source_tag,
    invoice_id: event.invoice_id,
    hash: String(event.hash).toUpperCase(),
    payer: event.payer,
    ledger_index: event.ledger_index == null ? null : event.ledger_index,
    duplicate: Boolean(event.duplicate),
    persisted: true,
  };
}

function updatePnl(text, count) {
  const re = /^\| x402_hits \|[^|\n]*\|[^|\n]*\|$/m;
  if (!re.test(text)) throw new Error("market/pnl.md is missing the x402_hits row");
  return text.replace(
    re,
    `| x402_hits | ${count} | append desk x402_hit via npm run x402:hit |`
  );
}

function recordHit(input, opts = {}) {
  const event = normalize(input);
  const logPath = opts.logPath || path.join(ROOT, "lab", "ledger-log.jsonl");
  const pnlPath = opts.pnlPath || path.join(ROOT, "market", "pnl.md");
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const key = `${event.sku}:${event.hash}`;
  const already = existing.split("\n").some((line) => {
    try {
      const row = JSON.parse(line);
      return (
        row &&
        row.action === "x402_hit" &&
        `${row.sku}:${String(row.hash).toUpperCase()}` === key
      );
    } catch {
      return false;
    }
  });
  let nextLog = existing;
  if (!already) {
    const prefix = nextLog.length && !nextLog.endsWith("\n") ? "\n" : "";
    nextLog = `${nextLog}${prefix}${JSON.stringify(event)}\n`;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, nextLog);
  }
  const count = countHits(nextLog);
  const pnl = fs.readFileSync(pnlPath, "utf8");
  const nextPnl = updatePnl(pnl, count);
  if (nextPnl !== pnl) fs.writeFileSync(pnlPath, nextPnl);
  return { appended: !already, count, hash: event.hash, sku: event.sku };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const fileFlag = process.argv.indexOf("--file");
  const raw =
    fileFlag === -1
      ? await readStdin()
      : fs.readFileSync(process.argv[fileFlag + 1], "utf8");
  if (!raw.trim()) throw new Error("no x402_hit JSON on stdin or --file");
  const parsed = JSON.parse(raw);
  console.log(JSON.stringify(recordHit(parsed)));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { recordHit, countHits, normalize, updatePnl };
