"use strict";

/**
 * Exact-Payment verifier for the foreign agent shop.
 * Reads a validated Testnet tx. Does not sign and does not submit.
 */

const xrpl = require("xrpl");
const rules = require("../../web/lib/x402-rules");
const pub = require("./foreign-public");

const TF_PARTIAL_PAYMENT = 0x00020000;

function fail(code, error, extra) {
  return Object.assign({ ok: false, code, error }, extra || {});
}

function xrpDrops(field) {
  return typeof field === "string" && /^[0-9]+$/.test(field) ? field : null;
}

function metaOf(tx) {
  if (tx.meta && typeof tx.meta === "object") return tx.meta;
  if (tx.metaData && typeof tx.metaData === "object") return tx.metaData;
  return {};
}

function hashSignedTx(blob) {
  let decoded;
  try {
    decoded = xrpl.decode(blob);
  } catch {
    throw new Error("invalid_tx_blob");
  }
  if (!decoded || decoded.TransactionType !== "Payment") throw new Error("not_payment_tx");
  return xrpl.hashes.hashSignedTx(blob);
}

function resolveProofHash(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const explicit = String(body.transaction || body.txHash || body.hash || "")
    .trim()
    .toUpperCase();
  const blob = typeof body.signedTxBlob === "string" ? body.signedTxBlob.trim() : "";
  let blobHash = "";
  if (blob) {
    try {
      blobHash = String(hashSignedTx(blob) || "")
        .trim()
        .toUpperCase();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "not_payment_tx") {
        return fail("not_payment_tx", "signedTxBlob is not a Payment");
      }
      return fail("invalid_tx_blob", "signedTxBlob is not a signed XRPL transaction");
    }
  }
  if (explicit && blobHash && explicit !== blobHash) {
    return fail("payment_requirements_mismatch", "transaction hash does not match signedTxBlob");
  }
  const txHash = explicit || blobHash;
  if (!/^[0-9A-F]{64}$/.test(txHash)) {
    return fail(
      "invalid_payload",
      "PAYMENT-SIGNATURE needs payload.transaction or payload.signedTxBlob"
    );
  }
  return { ok: true, txHash };
}

function bindsInvoice(tx, invoiceId) {
  if (rules.memoTexts(tx).some((text) => text === invoiceId)) return true;
  const id = typeof tx.InvoiceID === "string" ? tx.InvoiceID.toUpperCase() : "";
  return id.length === 64 && id === rules.sha256Hex(invoiceId);
}

function parseSignature(headerValue) {
  let decoded;
  try {
    decoded = rules.decodeHeader(headerValue);
  } catch {
    return fail("invalid_payload", "PAYMENT-SIGNATURE is not base64 JSON");
  }
  if (!decoded || typeof decoded !== "object") {
    return fail("invalid_payload", "PAYMENT-SIGNATURE JSON must be an object");
  }
  if (decoded.x402Version !== 2) {
    return fail("invalid_payload", "x402Version must be 2");
  }
  if (
    decoded.network === pub.MAINNET ||
    (decoded.accepted && decoded.accepted.network === pub.MAINNET) ||
    (decoded.accepted && decoded.accepted.network === "xrpl-mainnet")
  ) {
    return fail("invalid_network", "mainnet xrpl:0 is refused");
  }
  const accepted = decoded.accepted;
  if (!accepted || typeof accepted !== "object") {
    return fail("payment_requirements_mismatch", "accepted is required");
  }
  if (accepted.scheme !== "exact") {
    return fail("payment_requirements_mismatch", "scheme must be exact");
  }
  if (accepted.network !== pub.NETWORK) {
    return fail("invalid_network", "network must be xrpl:1 (XRPL Testnet)");
  }
  if (accepted.asset !== "XRP") {
    return fail("payment_requirements_mismatch", "asset must be XRP");
  }
  if (accepted.payTo !== pub.FOREIGN_ADDRESS) {
    return fail("destination_mismatch", "payTo must be the foreign agent shop");
  }
  if (accepted.amount !== pub.SKU.drops) {
    return fail("amount_mismatch", "amount must be the foreign SKU price in drops");
  }
  const extra = accepted.extra && typeof accepted.extra === "object" ? accepted.extra : {};
  if (Number(extra.sourceTag) !== pub.SKU.sourceTag) {
    return fail("source_tag_mismatch", "sourceTag does not match the foreign SKU");
  }
  if (
    typeof extra.invoiceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{3,79}$/.test(extra.invoiceId)
  ) {
    return fail("invoice_binding_missing", "extra.invoiceId is missing");
  }
  const payload = decoded.payload && typeof decoded.payload === "object" ? decoded.payload : {};
  const proof = resolveProofHash(payload);
  if (!proof.ok) return Object.assign(proof, { invoiceId: extra.invoiceId });
  return {
    ok: true,
    txHash: proof.txHash,
    invoiceId: extra.invoiceId,
  };
}

function assessForeignPayment({ tx, invoiceId, expectedHash }) {
  const sku = pub.SKU;
  if (!tx || typeof tx !== "object") return fail("rpc_error", "tx lookup returned nothing");
  const hash = String(tx.hash || "").toUpperCase();
  if (hash !== String(expectedHash || "").toUpperCase()) {
    return fail("payment_requirements_mismatch", "settled hash does not match the proof");
  }
  if (tx.validated !== true) {
    return fail("payment_not_validated", "transaction is not in a validated ledger");
  }
  const meta = metaOf(tx);
  if (meta.TransactionResult !== "tesSUCCESS") {
    return fail("payment_not_validated", "transaction result is not tesSUCCESS");
  }
  if (tx.TransactionType !== "Payment") {
    return fail("not_payment_tx", "transaction is not a Payment");
  }
  if (tx.NetworkID != null && Number(tx.NetworkID) !== 1) {
    return fail("invalid_network", "NetworkID must be 1 for XRPL Testnet");
  }
  if (tx.Destination !== pub.FOREIGN_ADDRESS) {
    return fail("destination_mismatch", "Destination is not the foreign agent shop");
  }
  if (tx.Amount && typeof tx.Amount === "object") {
    return fail("amount_mismatch", "IOU or cross-currency Amount is not exact XRP");
  }
  if (Array.isArray(tx.Paths) && tx.Paths.length > 0) {
    return fail("amount_mismatch", "path payments are not exact XRP");
  }
  const amount = xrpDrops(tx.Amount);
  const deliverMax = xrpDrops(tx.DeliverMax);
  if (tx.DeliverMax && typeof tx.DeliverMax === "object") {
    return fail("amount_mismatch", "DeliverMax is not XRP drops");
  }
  if (!amount && !deliverMax) return fail("amount_mismatch", "Payment amount is missing");
  if (amount && amount !== sku.drops) {
    return fail("amount_mismatch", "Amount does not match the foreign SKU price");
  }
  if (deliverMax && deliverMax !== sku.drops) {
    return fail("amount_mismatch", "DeliverMax does not match the foreign SKU price");
  }
  if (tx.SendMax != null) {
    const sendMax = xrpDrops(tx.SendMax);
    if (!sendMax || sendMax !== sku.drops) {
      return fail("amount_mismatch", "SendMax is not the exact XRP amount");
    }
  }
  const flags = Number(tx.Flags || 0);
  if (flags & TF_PARTIAL_PAYMENT) return fail("amount_mismatch", "partial payments are rejected");
  const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
  if (typeof delivered === "string" && delivered !== sku.drops) {
    return fail("amount_mismatch", "delivered_amount does not match the foreign SKU price");
  }
  if (delivered && typeof delivered === "object") {
    return fail("amount_mismatch", "delivered amount is not XRP");
  }
  if (Number(tx.SourceTag) !== sku.sourceTag) {
    return fail("source_tag_mismatch", "SourceTag does not match the foreign SKU");
  }
  if (typeof tx.LastLedgerSequence !== "number") {
    return fail("missing_last_ledger_sequence", "LastLedgerSequence is required");
  }
  if (!invoiceId || !bindsInvoice(tx, invoiceId)) {
    const any = rules.memoTexts(tx).length > 0 || typeof tx.InvoiceID === "string";
    return fail(
      any ? "invoice_binding_mismatch" : "invoice_binding_missing",
      any ? "invoice binding does not match extra.invoiceId" : "Payment has no invoice binding"
    );
  }
  const payer = typeof tx.Account === "string" ? tx.Account : "";
  if (!payer) return fail("rpc_error", "Payment has no Account");
  return {
    ok: true,
    hash,
    payer,
    invoiceId,
    ledgerIndex: typeof tx.ledger_index === "number" ? tx.ledger_index : null,
    amountDrops: sku.drops,
  };
}

async function verifyForeignPayment({ header, lookupTx }) {
  const parsed = parseSignature(header);
  if (!parsed.ok) return parsed;
  let looked;
  try {
    looked = await lookupTx(parsed.txHash);
  } catch (err) {
    return fail("rpc_error", err instanceof Error ? err.message : "tx lookup failed", {
      txHash: parsed.txHash,
      invoiceId: parsed.invoiceId,
    });
  }
  if (!looked || looked.found !== true) {
    const missing = looked && (looked.code === "txnNotFound" || looked.code === "txnNotValidated");
    return fail(
      missing ? "payment_not_on_ledger" : "rpc_error",
      missing
        ? "No validated Testnet tx for this proof. This shop does not submit signed blobs."
        : (looked && looked.error) || "tx lookup failed",
      { txHash: parsed.txHash, invoiceId: parsed.invoiceId }
    );
  }
  const assessed = assessForeignPayment({
    tx: looked.tx,
    invoiceId: parsed.invoiceId,
    expectedHash: parsed.txHash,
  });
  if (!assessed.ok) {
    return Object.assign(assessed, {
      txHash: parsed.txHash,
      invoiceId: parsed.invoiceId || assessed.invoiceId,
    });
  }
  return assessed;
}

module.exports = {
  verifyForeignPayment,
  assessForeignPayment,
  parseSignature,
  hashSignedTx,
  bindsInvoice,
};
