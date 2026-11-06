"use strict";

/**
 * The unsigned public OpenAPI is titled mainnet and lists xrpl:0. That is not
 * authorization. A purchase still needs a live x402 version 2 xrpl:1 challenge.
 * The reviewed resource is the exact sanctions address URL the operator
 * retained. A host suffix, a path prefix, or a different address query is
 * not that resource. data:{} is not a useful result. The OpenAPI does not
 * mark fields required and its title says mainnet; neither authorizes xrpl:0.
 * A useful result needs data.listed as a boolean and data.query.address
 * equal to the address in that URL. A fresh x402 v2 xrpl:1 challenge is
 * still required before any signature. The retained invoice is not a replay.
 */

const HOST = "api.stablecoingateways.com";
const REVIEWED_PATH = "/v1/sanctions/address";
const REVIEWED_ADDRESS = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";

function reviewedAddress(resourceUrl) {
  const url = new URL(resourceUrl);
  return url.searchParams.get("address") || "";
}

function resourcePath(resourceUrl) {
  let url;
  try {
    url = new URL(resourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname !== HOST) return null;
  if (url.pathname !== REVIEWED_PATH) return null;
  if (reviewedAddress(resourceUrl) !== REVIEWED_ADDRESS) return null;
  return url.pathname;
}

function supportsResource(resourceUrl) {
  return resourcePath(resourceUrl) !== null;
}

function validatePurchasedService(resourceUrl, httpStatus, parsed) {
  const pathname = resourcePath(resourceUrl);
  if (!pathname) return { ok: false, useful: false, code: "unsupported_delivery" };
  if (httpStatus !== 200 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, useful: false, code: "delivery_failed" };
  }
  const data = parsed.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, useful: false, code: "incomplete_result" };
  }
  const address = reviewedAddress(resourceUrl);
  if (typeof data.listed !== "boolean" || !data.query || typeof data.query.address !== "string" || data.query.address !== address) {
    return { ok: false, useful: false, code: "incomplete_result" };
  }
  return { ok: true, useful: true, schema: "stablecoingateways/v1/sanctions/address" };
}

function boundedErrorCode(parsed, httpStatus) {
  const raw = parsed && typeof parsed === "object" ? (parsed.code || parsed.error) : "";
  if (typeof raw === "string" && /^[a-z0-9_]{1,40}$/.test(raw)) return raw;
  if (httpStatus === 200) return "unusable_body";
  if (!parsed) return "unparsed";
  return "refused";
}

module.exports = {
  HOST,
  supportsResource,
  validatePurchasedService,
  boundedErrorCode,
};
