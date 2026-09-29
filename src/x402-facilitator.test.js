"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const rules = require("../web/lib/x402-rules");
const facilitator = require("../web/lib/x402-facilitator");
const guard = require("./x402-outbound-guard");

const HASH = "A".repeat(64);
const INVOICE = "af-reserve-audit-test1";
const TESTNET = "https://xrpl-facilitator-testnet.t54.ai";
const MAINNET = "https://xrpl-facilitator-mainnet.t54.ai";
const PAYER = "rBuyerExamplexxxxxxxxxxxxxxxxxxxxx";

function sku() {
  return rules.getSku("reserve-audit");
}

function payment(overrides) {
  const row = sku();
  return Object.assign(
    {
      hash: HASH,
      validated: true,
      TransactionType: "Payment",
      Account: PAYER,
      Destination: rules.PAY_TO,
      Amount: row.drops,
      SourceTag: row.sourceTag,
      LastLedgerSequence: 21000000,
      NetworkID: 1,
      Memos: [
        {
          Memo: {
            MemoData: Buffer.from(INVOICE, "utf8").toString("hex").toUpperCase(),
          },
        },
      ],
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: row.drops },
      ledger_index: 211,
    },
    overrides || {}
  );
}

function headerFor(payload, acceptedOverrides) {
  const row = sku();
  const required = rules.buildPaymentRequired({
    sku: row,
    resourceUrl: "https://desk.example/api/x402/reserve-audit",
    invoiceId: INVOICE,
  });
  const accepted = Object.assign({}, required.accepts[0], acceptedOverrides || {});
  return rules.encodeHeader({
    x402Version: 2,
    accepted,
    payload,
  });
}

function boomFetch() {
  return async () => {
    throw new Error("facilitator fetch should not run");
  };
}

describe("facilitator host gate", () => {
  it("accepts only the T54 testnet origin", () => {
    const parsed = facilitator.parseFacilitatorUrl(`${TESTNET}/`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.host, "xrpl-facilitator-testnet.t54.ai");
    assert.equal(parsed.origin, TESTNET);
    const dual = facilitator.resolveFacilitator({ XRPL_FACILITATOR_URL: TESTNET, XRPL_NETWORK: "xrpl:1" });
    assert.equal(dual.mode, "dual");
    assert.equal(dual.networkId, 1);
    const pub = facilitator.publicFacilitator({ XRPL_FACILITATOR_URL: TESTNET });
    assert.equal(pub.mode, "dual");
    assert.equal(pub.host, "xrpl-facilitator-testnet.t54.ai");
    assert.equal(pub.network, "xrpl:1");
    assert.equal(pub.networkId, 1);
    assert.equal(pub.settles, false);
    assert.equal(pub.verifyOnly, true);
    assert.equal(pub.remoteVerify, true);
    const narrowed = facilitator.facilitatorEnv({
      XRPL_FACILITATOR_URL: TESTNET,
      XRPL_NETWORK: "xrpl:1",
      D0_SEED: "sEd" + "V".repeat(20),
    });
    assert.deepEqual(Object.keys(narrowed).sort(), ["XRPL_FACILITATOR_URL", "XRPL_NETWORK"]);
    assert.equal(JSON.stringify(narrowed).includes("sEd"), false);
  });

  it("refuses mainnet facilitator URLs and network id 0", () => {
    const hosts = [
      MAINNET,
      "https://xrpl-facilitator-mainnet.t54.ai/verify",
      "http://xrpl-facilitator-testnet.t54.ai",
      "https://xrpl-facilitator-testnet.t54.ai.evil.example",
      "https://evil.xrpl-facilitator-testnet.t54.ai",
      "https://s1.ripple.com",
      "https://xrpl-x402.t54.ai",
    ];
    for (const host of hosts) {
      const parsed = facilitator.parseFacilitatorUrl(host);
      assert.equal(parsed.ok, false, host);
      assert.equal(parsed.code, "invalid_facilitator");
      const resolved = facilitator.resolveFacilitator({ XRPL_FACILITATOR_URL: host });
      assert.equal(resolved.ok, false, host);
    }
    const network = facilitator.resolveFacilitator({
      XRPL_FACILITATOR_URL: TESTNET,
      XRPL_NETWORK: "xrpl:0",
    });
    assert.equal(network.ok, false);
    assert.equal(network.code, "invalid_network");
    const zero = facilitator.resolveFacilitator({ XRPL_NETWORK: "0" });
    assert.equal(zero.code, "invalid_network");
    const devnetNetwork = facilitator.resolveFacilitator({
      XRPL_FACILITATOR_URL: TESTNET,
      XRPL_NETWORK: "xrpl:2",
    });
    assert.equal(devnetNetwork.ok, false);
    assert.equal(devnetNetwork.code, "invalid_network");
    const endpoint = facilitator.verifyEndpoint(MAINNET);
    assert.equal(endpoint.ok, false);
    assert.equal(endpoint.code, "invalid_facilitator");
  });
});

describe("verifyDeskPayment", () => {
  it("self-verifies when the facilitator env is unset and does not fetch", async () => {
    const result = await facilitator.verifyDeskPayment({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      env: {},
      fetchImpl: boomFetch(),
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "self-verify");
    assert.equal(result.payer, PAYER);
    const bare = facilitator.publicFacilitator({});
    assert.equal(bare.mode, "self-verify");
    assert.equal(bare.host, null);
    assert.equal(bare.networkId, 1);
    assert.equal(bare.remoteVerify, false);
    assert.equal(bare.settles, false);
    const described = rules.howToPay(sku(), INVOICE);
    assert.equal(described.facilitator.mode, "self-verify");
    assert.equal(described.facilitator.settles, false);
    const still = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(still.ok, true);
  });

  it("refuses a mainnet facilitator env before any ledger read", async () => {
    const result = await facilitator.verifyDeskPayment({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      env: { XRPL_FACILITATOR_URL: MAINNET },
      fetchImpl: boomFetch(),
      lookupTx: async () => {
        throw new Error("lookup should not run");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_facilitator");
  });

  it("refuses network id other than 1 on the receipt and on the settled payment", async () => {
    const receipt = {
      success: true,
      transaction: HASH,
      network: "xrpl:0",
      facilitator: TESTNET,
      payer: PAYER,
    };
    const mainnetReceipt = await facilitator.verifyDeskPayment({
      header: headerFor({ facilitatorReceipt: receipt }),
      sku: sku(),
      env: { XRPL_FACILITATOR_URL: TESTNET },
      fetchImpl: boomFetch(),
      lookupTx: async () => {
        throw new Error("lookup should not run");
      },
    });
    assert.equal(mainnetReceipt.code, "invalid_network");

    const idZero = await facilitator.verifyDeskPayment({
      header: headerFor({
        facilitatorReceipt: Object.assign({}, receipt, { network: "xrpl:1", networkId: 0 }),
      }),
      sku: sku(),
      env: { XRPL_FACILITATOR_URL: TESTNET },
      fetchImpl: boomFetch(),
      lookupTx: async () => {
        throw new Error("lookup should not run");
      },
    });
    assert.equal(idZero.code, "invalid_network");

    const settled = await facilitator.verifyDeskPayment({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      env: {},
      fetchImpl: boomFetch(),
      lookupTx: async () => ({ found: true, tx: payment({ NetworkID: 0 }) }),
    });
    assert.equal(settled.code, "invalid_network");

    const devnet = await facilitator.verifyDeskPayment({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      env: {},
      lookupTx: async () => ({ found: true, tx: payment({ NetworkID: 2 }) }),
    });
    assert.equal(devnet.code, "invalid_network");
  });

  it("accepts a testnet facilitator receipt by reading the ledger and not by settling", async () => {
    let fetched = 0;
    const result = await facilitator.verifyDeskPayment({
      header: headerFor({
        facilitatorReceipt: {
          success: true,
          transaction: HASH,
          network: "xrpl:1",
          networkId: 1,
          payer: PAYER,
          facilitator: TESTNET,
        },
      }),
      sku: sku(),
      env: { XRPL_FACILITATOR_URL: TESTNET, XRPL_NETWORK: "xrpl:1" },
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("settled receipts are ledger reads");
      },
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "facilitator-receipt");
    assert.equal(fetched, 0);
  });

  it("calls only /verify when a dual-mode blob is not on the ledger yet", async () => {
    const calls = [];
    const result = await facilitator.verifyDeskPayment({
      header: headerFor({ signedTxBlob: "BLOB" }),
      sku: sku(),
      hashSignedTx: () => HASH,
      env: { XRPL_FACILITATOR_URL: `${TESTNET}/` },
      lookupTx: async () => ({ found: false, code: "txnNotFound" }),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (String(url).includes("/settle")) throw new Error("desk must not settle");
        assert.equal(url, `${TESTNET}/verify`);
        const body = JSON.parse(init.body);
        assert.equal(body.x402Version, 2);
        assert.equal(body.paymentPayload.payload.signedTxBlob, "BLOB");
        assert.equal(body.paymentRequirements.network, "xrpl:1");
        return { ok: true, json: async () => ({ isValid: true, payer: PAYER }) };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.code, "payment_not_on_ledger");
    assert.equal(result.facilitatorVerified, true);
    assert.equal(result.via, "facilitator-verify");
  });

  it("keeps a testnet receipt on the self-verify path when the env is unset", async () => {
    const result = await facilitator.verifyDeskPayment({
      header: headerFor({
        facilitatorReceipt: {
          success: true,
          transaction: HASH,
          network: "xrpl:1",
          payer: PAYER,
          facilitator: TESTNET,
        },
      }),
      sku: sku(),
      env: {},
      fetchImpl: boomFetch(),
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "self-verify");
  });
});

describe("desk facilitator source", () => {
  it("does not call settle or sign from the desk module", () => {
    const src = fs.readFileSync(path.join(__dirname, "../web/lib/x402-facilitator.js"), "utf8");
    assert.equal(src.includes("/settle"), false);
    assert.equal(src.includes("Wallet.sign"), false);
    assert.equal(src.includes("fromSeed"), false);
    assert.equal(src.includes(MAINNET), false);
    const labeled = new Set(facilitator.LABELED);
    const index = guard.foundryIndex();
    for (const address of index.keys()) assert.equal(labeled.has(address), true);
    assert.equal(labeled.size, index.size);
  });
});
