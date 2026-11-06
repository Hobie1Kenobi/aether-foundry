"use strict";

/**
 * The unsigned public OpenAPI is titled mainnet and lists xrpl:0. That is not
 * authorization. A purchase still needs a live x402 version 2 xrpl:1 challenge.
 * The sanitized cand-17 snapshot does not include its resource URL, so this
 * check cannot be pinned to that one pathname without inventing it. It accepts
 * only an exact https host and an exact documented pathname, never a host
 * suffix or a path prefix. data:{} is not a useful result. The OpenAPI does
 * not mark data fields required; the lists below are the identifying fields
 * named for each path, and a missing one stays incomplete.
 */

const HOST = "api.stablecoingateways.com";
const FIELDS = {
  "/v1/domain-facts": ["domain", "checked_at"],
  "/v1/sec/company-facts": ["cik", "name"],
  "/v1/sanctions/screen": ["lists", "source"],
  "/v1/page-to-markdown": ["url", "markdown"],
  "/v1/business-days": ["calendar", "op"],
  "/v1/fx/rates": ["base", "rate_date", "rates"],
  "/v1/lei": ["found"],
  "/v1/recalls": ["query", "source"],
  "/v1/us/rates-macro": ["series"],
  "/v1/whois": ["domain", "checked_at"],
  "/v1/fx/convert": ["from", "amount", "rate_date", "conversions"],
  "/v1/merchant-check": ["query", "facts"],
  "/v1/sanctions/address": ["listed", "query"],
  "/v1/counterparty-check": ["query", "facts"],
};

function resourcePath(resourceUrl) {
  let url;
  try {
    url = new URL(resourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname !== HOST) return null;
  return Object.prototype.hasOwnProperty.call(FIELDS, url.pathname) ? url.pathname : null;
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
  const missing = FIELDS[pathname].filter((key) => data[key] == null);
  if (missing.length) return { ok: false, useful: false, code: "incomplete_result" };
  return { ok: true, useful: true, schema: `stablecoingateways${pathname}` };
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
