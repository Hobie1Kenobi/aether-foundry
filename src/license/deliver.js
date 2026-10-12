"use strict";

/**
 * Cheap on-ledger job: a balance and owner report for the buyer.
 * Scribe summarizes when it is up. Otherwise the sentence is fixed.
 */

const catalog = require("./catalog");

function fallbackSummary(report) {
  const row = report || {};
  return `Ledger analysis for ${row.account}: balance ${row.balance_drops} drops, owner_count ${row.owner_count}, objects ${row.object_count}, sequence ${row.sequence}, ledger ${row.ledger_index}.`;
}

function reportFromReads(account, info, objects, ledgerIndex) {
  const data = info || {};
  return {
    account,
    balance_drops: String(data.balance_drops != null ? data.balance_drops : data.Balance),
    owner_count: Number(data.owner_count != null ? data.owner_count : data.OwnerCount || 0),
    sequence: Number(data.sequence != null ? data.sequence : data.Sequence),
    object_count: Array.isArray(objects) ? objects.length : Number(objects || 0),
    ledger_index: ledgerIndex == null ? null : ledgerIndex,
    network_id: 1,
  };
}

async function summarize(report, opts) {
  const options = opts || {};
  const fallback = fallbackSummary(report);
  if (options.scribe === false) return { source: "fallback", text: fallback };
  const base = String(options.scribeUrl || process.env.AETHER_SCRIBE_URL || "http://127.0.0.1:8791").replace(/\/$/, "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) {
    return { source: "fallback", text: fallback };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeout = options.timeoutMs || 800;
  try {
    const health = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(Math.min(timeout, 400)) });
    if (!health.ok) return { source: "fallback", text: fallback };
    const res = await fetchImpl(`${base}/v1/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ text: fallback }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return { source: "fallback", text: fallback };
    const body = await res.json();
    if (!body || typeof body.summary !== "string" || !body.summary.trim()) {
      return { source: "fallback", text: fallback };
    }
    return { source: "scribe", text: body.summary.trim() };
  } catch {
    return { source: "fallback", text: fallback };
  }
}

async function deliver(spec) {
  const options = spec || {};
  const account = options.account;
  if (account !== catalog.W4 && options.allowAnyAccount !== true) {
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(account || ""))) {
      throw catalog.coded("deliver requires the buyer account", "TX");
    }
  }
  let info = options.accountInfo;
  let objects = options.accountObjects;
  let ledgerIndex = options.ledgerIndex;
  if (!info && typeof options.readAccount === "function") {
    const read = await options.readAccount(account);
    info = read.info || read;
    objects = read.objects;
    ledgerIndex = read.ledgerIndex != null ? read.ledgerIndex : read.ledger_index;
  }
  if (!info) throw catalog.coded("deliver requires ledger reads", "RPC");
  const report = reportFromReads(account, info, objects || [], ledgerIndex);
  const summary = await summarize(report, options);
  return { report, summary: summary.text, summary_source: summary.source };
}

module.exports = {
  fallbackSummary,
  reportFromReads,
  summarize,
  deliver,
};
