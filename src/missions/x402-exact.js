"use strict";

/**
 * Offline checks from the public XRPL exact verifiers.
 * t54 accepts a memo or InvoiceID = SHA-256(invoiceId):
 * https://xrpl-x402.t54.ai/docs/xrpl-scheme
 * r402-xrpl rejects any Memos field and requires that InvoiceID:
 * https://docs.rs/r402-xrpl/latest/src/r402_xrpl/exact/facilitator/verify.rs.html
 * A memo-only Payment fails the stricter verifier. This does not call a seller.
 */

const { invoiceIdField } = require("./x402-deliver");

function fail(code) {
  return { ok: false, code };
}

function exactXrplPayment(tx, requirements) {
  if (!tx || tx.TransactionType !== "Payment") return fail("not_payment");
  if (tx.Memos != null) return fail("memos_not_allowed");
  if (tx.NetworkID != null) return fail("network_id_present");
  if (tx.Destination !== requirements.payTo) return fail("destination");
  if (tx.Amount != null && tx.DeliverMax != null) return fail("amount_and_delivermax");
  const amount = tx.Amount != null ? tx.Amount : tx.DeliverMax;
  if (String(amount) !== String(requirements.amount)) return fail("amount");
  if (tx.SendMax != null || tx.Paths != null || tx.DeliverMin != null) return fail("forbidden_field");
  if (!Number.isInteger(tx.LastLedgerSequence)) return fail("last_ledger_sequence");
  if (Number(tx.SourceTag) !== Number(requirements.sourceTag)) return fail("source_tag");
  const expected = invoiceIdField(requirements.invoiceId);
  if (typeof tx.InvoiceID !== "string") return fail("invoice_missing");
  if (tx.InvoiceID.toUpperCase() !== expected) return fail("invoice_id_mismatch");
  return { ok: true, invoiceIdField: expected };
}

module.exports = {
  exactXrplPayment,
};
