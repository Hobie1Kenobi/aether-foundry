"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const xrpl = require("xrpl");
const { bindChallenge, invoiceIdField } = require("./x402-deliver");
const { exactXrplPayment } = require("./x402-exact");

const PAYTO = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const INVOICE = "fresh-invoice-100-aabb";

function payment(extra) {
  return Object.assign({
    TransactionType: "Payment",
    Account: "rPayerxxxxxxxxxxxxxxxxxxxxxx",
    Destination: PAYTO,
    Amount: "1753",
    Fee: "10",
    Sequence: 22121127,
    LastLedgerSequence: 22121554,
    NetworkID: 1,
    SourceTag: 26100014,
  }, extra || {});
}

describe("public exact xrpl binding", () => {
  it("binds the invoice as InvoiceID and rejects the memo-only shape", () => {
    const bound = bindChallenge({
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      extra: { sourceTag: 26100014, invoiceId: INVOICE },
    });
    assert.equal(bound.invoiceIdField, invoiceIdField(INVOICE));
    assert.equal(Object.prototype.hasOwnProperty.call(bound, "memo"), false);
    const memoOnly = payment({
      Memos: [{ Memo: { MemoData: Buffer.from(INVOICE, "utf8").toString("hex").toUpperCase() } }],
    });
    assert.equal(exactXrplPayment(memoOnly, { payTo: PAYTO, amount: "1753", sourceTag: 26100014, invoiceId: INVOICE }).code, "memos_not_allowed");
    const missing = payment({});
    assert.equal(exactXrplPayment(missing, { payTo: PAYTO, amount: "1753", sourceTag: 26100014, invoiceId: INVOICE }).code, "invoice_missing");
    const good = payment({ InvoiceID: bound.invoiceIdField });
    assert.equal(exactXrplPayment(good, { payTo: PAYTO, amount: "1753", sourceTag: 26100014, invoiceId: INVOICE }).ok, true);
  });

  it("decodes a generated signature with InvoiceID and without Memos", () => {
    const wallet = xrpl.Wallet.generate();
    const invoiceField = invoiceIdField(INVOICE);
    const signed = wallet.sign({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: PAYTO,
      Amount: "1753",
      Fee: "10",
      Sequence: 22121127,
      LastLedgerSequence: 22121554,
      NetworkID: 1,
      SourceTag: 26100014,
      InvoiceID: invoiceField,
    });
    const decoded = xrpl.decode(signed.tx_blob);
    assert.equal(decoded.InvoiceID.toUpperCase(), invoiceField);
    assert.equal(Object.prototype.hasOwnProperty.call(decoded, "Memos"), false);
    assert.equal(decoded.SourceTag, 26100014);
    assert.equal(String(decoded.Amount), "1753");
    assert.equal(exactXrplPayment(decoded, {
      payTo: PAYTO,
      amount: "1753",
      sourceTag: 26100014,
      invoiceId: INVOICE,
    }).ok, true);
    assert.equal(signed.tx_blob.includes(wallet.seed), false);
  });
});
