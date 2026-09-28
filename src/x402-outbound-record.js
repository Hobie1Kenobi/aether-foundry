"use strict";

/**
 * Append an x402_outbound event after a real paid 200.
 * Does not invent hashes. Refuses mainnet and Foundry payTo.
 */

const fs = require("fs");
const path = require("path");
const guard = require("./x402-outbound-guard");

const ROOT = path.resolve(__dirname, "..");

function countOutbound(text) {
  const seen = new Set();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.action !== "x402_outbound" || !row.hash) continue;
    seen.add(String(row.hash).toUpperCase());
  }
  return seen.size;
}

function normalize(input) {
  const event = input && input.x402_outbound ? input.x402_outbound : input;
  if (!event || typeof event !== "object") {
    throw new Error("expected an x402_outbound object");
  }
  if (!event.hash) throw new Error("x402_outbound needs a tx hash");
  if (event.network === "xrpl:0") throw new Error("refusing a mainnet x402_outbound");
  if (!event.pay_to) throw new Error("x402_outbound needs pay_to");
  const index = guard.foundryIndex();
  if (index.has(event.pay_to) || event.pay_to === guard.W3_ADDRESS) {
    throw new Error(`refusing to record Foundry payTo ${event.pay_to}`);
  }
  return {
    ts: event.ts || new Date().toISOString(),
    action: "x402_outbound",
    network: event.network || "xrpl:1",
    resource_url: event.resource_url || null,
    pay_to: event.pay_to,
    payer: event.payer || guard.W3_ADDRESS,
    amount_drops: event.amount_drops,
    source_tag: event.source_tag == null ? null : event.source_tag,
    invoice_id: event.invoice_id || null,
    hash: String(event.hash).toUpperCase(),
    ledger_index: event.ledger_index == null ? null : event.ledger_index,
    http_status: event.http_status == null ? 200 : event.http_status,
  };
}

function updatePnl(text, count) {
  const re = /^\| x402_outbound_hits \|[^|\n]*\|[^|\n]*\|$/m;
  if (!re.test(text)) {
    throw new Error("market/pnl.md is missing the x402_outbound_hits row");
  }
  return text.replace(
    re,
    `| x402_outbound_hits | ${count} | append via npm run x402:outbound -- --record |`
  );
}

function recordOutbound(input, opts = {}) {
  const event = normalize(input);
  const logPath = opts.logPath || path.join(ROOT, "lab", "ledger-log.jsonl");
  const pnlPath = opts.pnlPath || path.join(ROOT, "market", "pnl.md");
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const already = existing.split("\n").some((line) => {
    try {
      const row = JSON.parse(line);
      return (
        row &&
        row.action === "x402_outbound" &&
        String(row.hash).toUpperCase() === event.hash
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
  const count = countOutbound(nextLog);
  const pnl = fs.readFileSync(pnlPath, "utf8");
  const nextPnl = updatePnl(pnl, count);
  if (nextPnl !== pnl) fs.writeFileSync(pnlPath, nextPnl);
  if (opts.root || (!opts.logPath && !opts.pnlPath)) {
    require("./runtime/metrics").refresh(opts.root || ROOT, {
      now: new Date(event.ts),
      ledgerPath: opts.logPath,
      pnlPath: opts.pnlPath,
    });
  }
  return { appended: !already, count, hash: event.hash };
}

module.exports = { recordOutbound, countOutbound, normalize, updatePnl };
