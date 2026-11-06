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
  const accepts = body && Array.isArray(body.accepts) ? body.accepts : [];
  const live = accepts.find((row) => sameAccept(built.accept, row));
  if (!live) {
    return { ok: false, code: "stale_challenge", rationale: "The live 402 no longer matches the qualified xrpl:1 accept." };
  }
  return { ok: true };
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
  deliverProof,
  buildSignaturePayload: x402.buildSignaturePayload,
};
