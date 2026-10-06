"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("./protocol");

const NOW_NONCE = "abc12345";

function envelope(type, extra) {
  return Object.assign({
    v: 1,
    t: type,
    from: "aether-scout",
    net: "xrpl:1",
    nonce: NOW_NONCE,
  }, extra);
}

describe("protocol envelopes", () => {
  it("round-trips a hello memo", () => {
    const body = protocol.validateEnvelope(envelope(protocol.HELLO, {
      from: "aether-scout",
      repo: "https://github.com/example/peer",
      x402: "https://peer.example/api/x402",
    }));
    const tx = protocol.paymentTx({
      account: protocol.W5,
      destination: protocol.W3,
      body,
    });
    assert.equal(tx.Amount, "1");
    assert.equal(tx.Memos.length, 1);
    const frame = protocol.frameFromEntry({
      hash: protocol.syntheticHash("A"),
      ledger_index: 7,
      validated: true,
      meta: { TransactionResult: "tesSUCCESS" },
      tx_json: tx,
    }, { synthetic: true });
    assert.equal(frame.t, protocol.HELLO);
    assert.equal(frame.body.repo, body.repo);
    assert.equal(frame.body.net, "xrpl:1");
    assert.equal(frame.synthetic, true);
    assert.equal(frame.ledger_claim, false);
    assert.equal(frame.peer, protocol.W5);
  });

  it("refuses mainnet, a bad version, and an oversized memo", () => {
    assert.throws(() => protocol.assertNet("xrpl:0"), /mainnet/);
    assert.throws(() => protocol.validateEnvelope(envelope(protocol.HELLO, { net: "xrpl:0" })), /mainnet/);
    assert.throws(() => protocol.validateEnvelope(envelope(protocol.HELLO, { v: 2 })), /version/);
    assert.throws(() => protocol.validateEnvelope(envelope(protocol.HELLO, {
      repo: "r".repeat(181),
    })), /repo/);
    const fat = {
      v: 1,
      t: protocol.HELLO,
      from: "aether-scout",
      net: "xrpl:1",
      nonce: NOW_NONCE,
      repo: `https://github.com/example/${"a".repeat(500)}`,
    };
    assert.throws(() => protocol.encodeMemo(protocol.HELLO, fat), /900/);
  });

  it("refuses NetworkID 0 and a payment that is not 1 drop", () => {
    const body = protocol.validateEnvelope(envelope(protocol.HELLO, { from: "aether-scout" }));
    assert.throws(() => protocol.paymentTx({
      account: protocol.W5,
      destination: protocol.W3,
      body,
      networkId: 0,
    }), /NetworkID 0/);
    const tx = protocol.paymentTx({ account: protocol.W5, destination: protocol.W3, body });
    tx.Amount = "2";
    const frame = protocol.frameFromEntry({
      hash: protocol.syntheticHash("B"),
      ledger_index: 8,
      validated: true,
      meta: { TransactionResult: "tesSUCCESS" },
      tx_json: tx,
    });
    assert.equal(frame, null);
  });

  it("hashes a transcript without treating it as a ledger hash", () => {
    const turns = [
      { role: "scout", text: "hello" },
      { role: "scribe", text: "testnet" },
    ];
    const first = protocol.transcriptSha256(turns);
    const second = protocol.transcriptSha256(turns);
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(protocol.transcriptSha256([{ role: "scout", text: "other" }]), first);
  });

  it("accepts a legacy hello that only has repo and x402", () => {
    const payload = { repo: "https://github.com/example/peer", x402: "https://peer.example/x402" };
    const entry = {
      hash: protocol.syntheticHash("C"),
      ledger_index: 9,
      validated: true,
      meta: { TransactionResult: "tesSUCCESS" },
      tx_json: {
        TransactionType: "Payment",
        Account: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
        Destination: protocol.W3,
        Amount: "1",
        Memos: [{
          Memo: {
            MemoType: protocol.hexOf(protocol.HELLO),
            MemoFormat: protocol.hexOf("application/json"),
            MemoData: protocol.hexOf(JSON.stringify(payload)),
          },
        }],
      },
    };
    const frame = protocol.frameFromEntry(entry, { synthetic: true });
    assert.equal(frame.legacy, true);
    assert.equal(frame.body.repo, payload.repo);
    assert.equal(frame.body.x402, payload.x402);
  });
});
