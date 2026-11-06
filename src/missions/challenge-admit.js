"use strict";

/**
 * Record one fresh unpaid x402 challenge. This does not reserve drops,
 * rewrite discovery, mint a candidate id, or sign. The retained invoice
 * cannot be admitted again. Admission is not permission to pay: payable
 * stays false until a later parent decision and a live 402.
 */

const fs = require("fs");
const path = require("path");
const { exclusive, coded, readEvents } = require("./ledger");
const serviceResult = require("./service-result");
const { RETAINED_INVOICE } = require("./x402-deliver");

const REVIEWED_PAYTO = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const INVOICE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;

function rowOf(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.reviewed_row && typeof doc.reviewed_row === "object") return doc.reviewed_row;
  const rows = Array.isArray(doc.xrpl1_accepts_sanitized) ? doc.xrpl1_accepts_sanitized : [];
  return rows.find((row) => row && row.network === "xrpl:1") || null;
}

function resourceOf(doc) {
  const requested = doc && doc.resource_url_requested;
  const body = doc && doc.resource_url_in_body;
  if (typeof requested === "string" && requested) return requested;
  if (typeof body === "string" && body) return body;
  return "";
}

function invoiceSeen(events, invoiceId) {
  return events.some((event) => event && event.type === "challenge.admitted" && event.invoice_id === invoiceId);
}

function admitFreshChallenge(dir, doc, now) {
  const clock = now || new Date().toISOString();
  if (!doc || doc.paid === true || doc.proof_sent === true) {
    throw coded("refusing a challenge that claims a payment was sent", "NO_RETRY");
  }
  if (doc.http_status !== 402 || doc.x402Version !== 2) {
    throw coded("a fresh challenge must be an unpaid x402 version 2 response", "TX");
  }
  const resource = resourceOf(doc);
  if (doc.resource_url_exact_match !== true || !serviceResult.supportsResource(resource)) {
    throw coded("the challenge resource is not the reviewed sanctions URL", "unsupported_delivery");
  }
  if (doc.resource_url_in_body && doc.resource_url_in_body !== resource) {
    throw coded("the challenge resource does not match the request", "unsupported_delivery");
  }
  const row = rowOf(doc);
  if (!row || row.scheme !== "exact" || row.network !== "xrpl:1" || row.asset !== "XRP" || row.payTo !== REVIEWED_PAYTO) {
    throw coded("the challenge is not the reviewed xrpl:1 XRP payTo", "MAINNET");
  }
  if (typeof row.amount !== "string" || !/^[1-9][0-9]*$/.test(row.amount)) {
    throw coded("the challenge amount is not a positive integer", "TX");
  }
  const extra = row.extra && typeof row.extra === "object" ? row.extra : {};
  const tag = Number(extra.sourceTag);
  if (!Number.isInteger(tag) || tag < 0 || tag > 4294967295) {
    throw coded("the challenge sourceTag is missing or malformed", "TX");
  }
  const invoiceId = extra.invoiceId;
  if (typeof invoiceId !== "string" || !INVOICE_RE.test(invoiceId)) {
    throw coded("the challenge invoiceId is missing or malformed", "TX");
  }
  if (invoiceId === RETAINED_INVOICE) {
    throw coded("the retained invoice is not permission to replay a signed challenge", "NO_RETRY");
  }
  const retrieved = Date.parse(doc.retrieved_at);
  const timeout = Number(row.maxTimeoutSeconds);
  if (!Number.isFinite(retrieved) || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
    throw coded("the challenge has no usable freshness window", "stale_challenge");
  }
  const expiresAt = new Date(retrieved + timeout * 1000).toISOString();
  return exclusive(dir, (api) => {
    const events = api.read();
    if (invoiceSeen(events, invoiceId)) {
      throw coded("this invoice was already admitted and is not a replay ticket", "NO_RETRY");
    }
    const event = {
      type: "challenge.admitted",
      counted: false,
      at: clock,
      resource_url: resource,
      pay_to: row.payTo,
      network: "xrpl:1",
      amount: row.amount,
      source_tag: tag,
      invoice_id: invoiceId,
      retrieved_at: new Date(retrieved).toISOString(),
      max_timeout_seconds: timeout,
      expires_at: expiresAt,
      payable: false,
      paid: false,
      proof_sent: false,
      discovery_rewritten: false,
      new_candidate: false,
      within_timeout: Date.parse(clock) <= Date.parse(expiresAt),
    };
    api.append(event);
    return { admitted: true, payable: false, event };
  });
}

function admitFile(dir, file, now) {
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  return admitFreshChallenge(dir, body, now);
}

if (require.main === module) {
  const home = process.env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const dir = process.env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger");
  const file = process.env.FOUNDRY_MISSION_CHALLENGE_FILE;
  if (!file) {
    process.stderr.write("CHALLENGE\n");
    process.exit(1);
  }
  try {
    const result = admitFile(dir, file);
    const events = readEvents(dir);
    process.stdout.write(`${JSON.stringify({
      admitted: result.admitted,
      payable: false,
      invoice_id: result.event.invoice_id,
      amount: result.event.amount,
      discovery_rewritten: false,
      events: events.length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "TX"}\n`);
    process.exit(1);
  }
}

module.exports = {
  REVIEWED_PAYTO,
  admitFreshChallenge,
  admitFile,
};
