"use strict";

/**
 * Offline calls to @x402/xrpl ExactXrplScheme.verify. No seller request
 * and no ledger socket: ledger hooks are stubs. The captured unpaid
 * challenge shape is the 2026-11-06 sanctions 402: extra has invoiceId
 * and sourceTag only.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const xrpl = require("xrpl");
const { ExactXrplScheme } = require("@x402/xrpl/exact/facilitator");

const PAYTO = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const INVOICE = "1794006938-fe412727f5ca4d9a-d1750-eddf9cb870422f522a2df7b2";
const INVOICE_FIELD = crypto.createHash("sha256").update(INVOICE, "utf8").digest("hex").toUpperCase();

function scheme() {
  return new ExactXrplScheme({
    getCurrentLedgerIndex: async () => 22121500,
    getAccountSequence: async () => 22121127,
    getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
    simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
  });
}

function accept(extra) {
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: "XRP",
    amount: "1750",
    payTo: PAYTO,
    maxTimeoutSeconds: 600,
    extra,
  };
}

function payload(blob, extra) {
  return {
    x402Version: 2,
    accepted: accept(extra),
    payload: { signedTxBlob: blob },
  };
}

describe("@x402/xrpl exact verify offline", () => {
  it("rejects the live 402 echo and a NetworkID, and accepts the scheme shape", async () => {
    const wallet = xrpl.Wallet.generate();
    const common = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: PAYTO,
      Amount: "1750",
      Fee: "10",
      Sequence: 22121127,
      LastLedgerSequence: 22121554,
      SourceTag: 26100014,
      InvoiceID: INVOICE_FIELD,
    };
    const withNetwork = wallet.sign(Object.assign({ NetworkID: 1 }, common));
    const omitted = wallet.sign(common);
    assert.equal(Object.prototype.hasOwnProperty.call(xrpl.decode(omitted.tx_blob), "NetworkID"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(xrpl.decode(omitted.tx_blob), "Memos"), false);
    const liveExtra = { invoiceId: INVOICE, sourceTag: 26100014 };
    const fixedExtra = Object.assign({ areFeesSponsored: false }, liveExtra);
    const verifier = scheme();
    const echoed = await verifier.verify(payload(withNetwork.tx_blob, liveExtra), accept(liveExtra));
    assert.equal(echoed.isValid, false);
    assert.equal(echoed.invalidReason, "invalid_exact_xrpl_fees_sponsored_unsupported");
    const tagged = await verifier.verify(payload(withNetwork.tx_blob, fixedExtra), accept(fixedExtra));
    assert.equal(tagged.isValid, false);
    assert.equal(tagged.invalidReason, "invalid_exact_xrpl_payload_network_id_for_standard_network");
    const passed = await verifier.verify(payload(omitted.tx_blob, fixedExtra), accept(fixedExtra));
    assert.equal(passed.isValid, true);
    assert.equal(passed.payer, wallet.address);
    assert.equal(omitted.tx_blob.includes(wallet.seed), false);
  });
});
