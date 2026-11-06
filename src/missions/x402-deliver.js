"use strict";

const x402 = require("../x402-outbound-guard");
const { coded } = require("./ledger");

function resourceOf(item, required) {
  if (item && item.resource && typeof item.resource.url === "string") {
    return { url: item.resource.url, method: item.resource.method || "GET" };
  }
  if (required && typeof required.resource === "string") return { url: required.resource, method: "GET" };
  if (required && required.resource && typeof required.resource.url === "string") {
    return { url: required.resource.url, method: "GET" };
  }
  return null;
}

function safeExtra(extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return {};
  const out = {};
  if (extra.sourceTag != null && extra.sourceTag !== "") out.sourceTag = extra.sourceTag;
  if (typeof extra.invoiceId === "string" && extra.invoiceId.length > 0 && extra.invoiceId.length <= 128) {
    out.invoiceId = extra.invoiceId;
  }
  return out;
}

function acceptOf(chosen, amount) {
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: "XRP",
    amount,
    payTo: chosen.payTo,
    maxTimeoutSeconds: Number(chosen.maxTimeoutSeconds || 0) || null,
    extra: safeExtra(chosen.extra),
  };
}

function challengeFresh(item, accept, now) {
  const timeout = Number(accept && accept.maxTimeoutSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return { ok: false, code: "stale_challenge", rationale: "The 402 challenge has no maxTimeoutSeconds." };
  }
  if (!item || typeof item.observed_at !== "string") {
    return { ok: false, code: "stale_challenge", rationale: "The 402 challenge has no observed_at." };
  }
  const age = new Date(now).getTime() - new Date(item.observed_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > timeout * 1000) {
    return { ok: false, code: "stale_challenge", rationale: "The 402 challenge is older than maxTimeoutSeconds." };
  }
  return { ok: true };
}

function sameAccept(expected, live) {
  if (!expected || !live) return false;
  return live.scheme === "exact"
    && live.network === "xrpl:1"
    && (live.asset == null || live.asset === "XRP")
    && String(live.amount) === String(expected.amount)
    && live.payTo === expected.payTo;
}

async function preflight(built, fetchImpl) {
  if (!built || !built.resource || typeof fetchImpl !== "function") {
    return { ok: false, code: "undeliverable", rationale: "No resource probe is configured, so payTo is not a raw payment." };
  }
  let response;
  try {
    response = await fetchImpl(built.resource.url, { method: built.resource.method || "GET" });
  } catch {
    return { ok: false, code: "undeliverable", rationale: "The resource did not answer a 402 challenge." };
  }
  if (!response || response.status !== 402) {
    return { ok: false, code: "undeliverable", rationale: "The resource did not repeat an HTTP 402 challenge." };
  }
  const body = typeof response.json === "function" ? await response.json() : null;
  if (!body || body.x402Version !== 2) {
    return { ok: false, code: "unsupported_protocol", rationale: "The live challenge is not x402 version 2 on xrpl:1." };
  }
  const accepts = Array.isArray(body.accepts) ? body.accepts : [];
  if (accepts.some((row) => row && (row.network === "xrpl:0" || row.network === "xrpl-mainnet")) && !accepts.some((row) => row && row.network === "xrpl:1")) {
    return { ok: false, code: "MAINNET", rationale: "The live challenge is not an xrpl:1 accept." };
  }
  const live = accepts.find((row) => sameAccept(built.accept, row));
  if (!live) {
    return { ok: false, code: "stale_challenge", rationale: "The live 402 no longer matches the qualified xrpl:1 accept." };
  }
  return { ok: true, accept: live };
}

const crypto = require("crypto");
const RETAINED_INVOICE = "1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45";

function invoiceIdField(invoiceId) {
  return crypto.createHash("sha256").update(String(invoiceId), "utf8").digest("hex").toUpperCase();
}

function bindChallenge(accept) {
  if (!accept || accept.scheme !== "exact" || accept.network !== "xrpl:1" || accept.asset !== "XRP") {
    throw coded("live challenge is not an exact xrpl:1 XRP accept", "MAINNET");
  }
  const extra = accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  const tag = Number(extra.sourceTag);
  if (!Number.isInteger(tag) || tag < 0 || tag > 4294967295) {
    throw coded("live challenge sourceTag is missing or malformed", "TX");
  }
  const invoiceId = extra.invoiceId;
  if (typeof invoiceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/.test(invoiceId)) {
    throw coded("live challenge invoiceId is missing or malformed", "TX");
  }
  if (invoiceId === RETAINED_INVOICE) {
    throw coded("the retained invoice is not permission to replay a signed challenge", "NO_RETRY");
  }
  return {
    sourceTag: tag,
    invoiceId,
    invoiceIdField: invoiceIdField(invoiceId),
  };
}

async function deliverProof(options) {
  const opts = options || {};
  if (!opts.resource || !opts.accept || !opts.txBlob || !opts.hash) {
    throw coded("x402 delivery is missing the proof", "UNDELIVERABLE");
  }
  return x402.deliverForeignPayment({
    fetchImpl: opts.fetchImpl,
    resourceUrl: opts.resource.url,
    method: opts.resource.method,
    required: opts.required,
    accept: opts.accept,
    txBlob: opts.txBlob,
    hash: opts.hash,
    sleep: opts.sleep || (async () => {}),
    submit: opts.submit,
  });
}

module.exports = {
  resourceOf,
  acceptOf,
  challengeFresh,
  sameAccept,
  preflight,
  RETAINED_INVOICE,
  invoiceIdField,
  bindChallenge,
  deliverProof,
  buildSignaturePayload: x402.buildSignaturePayload,
};
