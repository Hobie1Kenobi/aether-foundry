"use strict";

/**
 * Success bodies are the documented Stablecoin Gateways HTTP 200 envelope:
 * a JSON object whose `data` property is an object. The public OpenAPI
 * (fetched unsigned) titles the API mainnet and also lists xrpl:0, which
 * this validator does not authorize. Only https://api.stablecoingateways.com
 * and the documented /v1 paths are accepted, and only for a data object.
 * Any other resource, including HTTP 200 with no `code` field, is not a purchase.
 */

const HOST = "api.stablecoingateways.com";
const PATHS = new Set([
  "/v1/domain-facts",
  "/v1/sec/company-facts",
  "/v1/sanctions/screen",
  "/v1/page-to-markdown",
  "/v1/business-days",
  "/v1/fx/rates",
  "/v1/lei",
  "/v1/recalls",
  "/v1/us/rates-macro",
  "/v1/whois",
  "/v1/fx/convert",
  "/v1/merchant-check",
  "/v1/sanctions/address",
  "/v1/counterparty-check",
]);

function supportsResource(resourceUrl) {
  let url;
  try {
    url = new URL(resourceUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === HOST && PATHS.has(url.pathname);
}

function validatePurchasedService(resourceUrl, httpStatus, parsed) {
  if (!supportsResource(resourceUrl)) return { ok: false, code: "unsupported_delivery" };
  if (httpStatus !== 200 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "delivery_failed" };
  }
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return { ok: false, code: "delivery_failed" };
  }
  return { ok: true, schema: "stablecoingateways.data/1" };
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
