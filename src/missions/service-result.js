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
  const code = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.code : "";
  const error = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.error : "";
  const known = diagnosticToken(code) || diagnosticToken(error);
  if (known) return known;
  if (httpStatus === 200) return "unusable_body";
  if (!parsed) return "unparsed";
  return "refused";
}

// Exact public protocol codes. A prefix, suffix, or unknown lowercase token
// is not public data. The dynamic simulation failure string is omitted
// because it appends an engine result.
const DIAGNOSTIC_CODES = new Set([
  "refused",
  "unparsed",
  "unusable_body",
  "verify_failed",
  "seller_verify_failed",
  "payment_requirements_mismatch",
  "payment_not_on_ledger",
  "payment_not_validated",
  "invalid_exact_xrpl_asset_transfer_method",
  "invalid_exact_xrpl_asset_transfer_method_mismatch",
  "invalid_exact_xrpl_payload_signing_pub_key",
  "invalid_exact_xrpl_payload_signature",
  "invalid_exact_xrpl_payload_transaction_type",
  "invalid_exact_xrpl_facilitator_error",
  "invalid_exact_xrpl_network_mismatch",
  "invalid_exact_xrpl_asset_mismatch",
  "invalid_exact_xrpl_amount_mismatch",
  "invalid_exact_xrpl_pay_to_mismatch",
  "invalid_exact_xrpl_max_timeout_mismatch",
  "invalid_exact_xrpl_fees_sponsored_unsupported",
  "invalid_exact_xrpl_invoice_mismatch",
  "invalid_exact_xrpl_destination_tag_mismatch",
  "invalid_exact_xrpl_iou_issuer_missing",
  "invalid_exact_xrpl_iou_issuer_mismatch",
  "invalid_exact_xrpl_payload_destination_mismatch",
  "invalid_exact_xrpl_destination_tag_malformed",
  "invalid_exact_xrpl_payload_destination_tag_mismatch",
  "invalid_exact_xrpl_payload_delegate_not_allowed",
  "invalid_exact_xrpl_payload_multisig_not_supported",
  "invalid_exact_xrpl_payload_network_id_for_standard_network",
  "invalid_exact_xrpl_payload_network_id_mismatch",
  "invalid_exact_xrpl_payload_amount_xrp",
  "invalid_exact_xrpl_payload_amount_mismatch",
  "invalid_exact_xrpl_payload_sendmax_not_allowed",
  "invalid_exact_xrpl_payload_paths_not_allowed",
  "invalid_exact_xrpl_payload_delivermin_not_allowed",
  "invalid_exact_xrpl_payload_partial_payment_not_allowed",
  "invalid_exact_xrpl_payload_iou_amount",
  "invalid_exact_xrpl_payload_iou_currency_mismatch",
  "invalid_exact_xrpl_payload_iou_issuer_mismatch",
  "invalid_exact_xrpl_payload_iou_value_mismatch",
  "invalid_exact_xrpl_payload_sendmax_required",
  "invalid_exact_xrpl_payload_sendmax_iou_mismatch",
  "invalid_exact_xrpl_payload_sendmax_too_low",
  "invalid_exact_xrpl_payload_memos_not_allowed",
  "invalid_exact_xrpl_payload_invoice_missing",
  "invalid_exact_xrpl_payload_invoice_id_mismatch",
  "invalid_exact_xrpl_payload_fee_missing",
  "invalid_exact_xrpl_payload_fee_too_high",
  "invalid_exact_xrpl_payload_lastledgersequence_missing",
  "invalid_exact_xrpl_payload_expired",
  "invalid_exact_xrpl_payload_lastledgersequence_too_large",
  "invalid_exact_xrpl_payload_ticket_sequence_not_allowed",
  "invalid_exact_xrpl_payload_sequence_missing",
  "invalid_exact_xrpl_payload_sequence_must_be_zero",
  "invalid_exact_xrpl_payload_ticket_sequence_missing",
  "invalid_exact_xrpl_payload_signer_not_authorized",
  "invalid_exact_xrpl_payload_sequence_not_current",
  "invalid_exact_xrpl_payload_ticket_not_available",
  "seller_not_paid",
  "seller_timeout",
  "transaction_failed",
  "duplicate_settlement",
  "verification_failed",
]);

function diagnosticToken(value) {
  return typeof value === "string" && DIAGNOSTIC_CODES.has(value) ? value : null;
}

function boundedSellerReason(value) {
  const exact = diagnosticToken(value);
  if (exact) return exact;
  if (typeof value === "string" && value.startsWith("transaction_failed:")) return "transaction_failed";
  return null;
}

function sanitizeDiagnostic(parsed) {
  const found = { reason: null, invalid_reason: null, error_reason: null };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return found;
  found.reason = diagnosticToken(parsed.reason);
  found.invalid_reason = diagnosticToken(parsed.invalidReason);
  found.error_reason = diagnosticToken(parsed.errorReason);
  return found;
}

module.exports = {
  HOST,
  supportsResource,
  validatePurchasedService,
  boundedErrorCode,
  diagnosticToken,
  boundedSellerReason,
  sanitizeDiagnostic,
};
