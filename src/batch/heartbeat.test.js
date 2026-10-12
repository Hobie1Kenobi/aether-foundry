"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const policy = require("../runtime/policy");
const signer = require("../runtime/signer");
const heartbeat = require("./heartbeat");

const ROOT = path.resolve(__dirname, "..", "..");
const NOW = new Date("2026-10-12T14:29:00.000Z");
const TOKEN = "test-signer-token-ok";

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function enabledState() {
  return {
    watched: {
      batch: {
        atomic_enabled: true,
        amendments: [
          { name: "BatchV1_1", enabled: true, supported: true, hash: "A".repeat(64) },
          { name: "fixBatchV1_2", enabled: true, supported: true, hash: "B".repeat(64) },
          { name: "TicketBatch", enabled: true, supported: true, hash: "C".repeat(64) },
        ],
      },
    },
  };
}

function offerFor(nftId, offerId, drops) {
  return {
    LedgerEntryType: "NFTokenOffer",
    Flags: 1,
    Owner: anchors.WALLETS.W2.address,
    Destination: anchors.WALLETS.W1.address,
    Amount: drops || policy.BATCH_HEARTBEAT.offer_drops,
    NFTokenID: nftId,
    index: offerId,
  };
}

function filledBatch(overrides) {
  const nftId = heartbeat.nftokenId();
  const offerId = heartbeat.placeholderOfferId();
  const tx = heartbeat.fillBatch(heartbeat.buildBatch({
    offerId,
    depositDrops: policy.BATCH_HEARTBEAT.deposit_drops,
    now: NOW,
  }), { sequence: 40, fee: "40", lastLedger: 21481382 });
  return { tx, nftId, offerId, sellOffer: offerFor(nftId, offerId) };
}

function agentEnv() {
  return { FOUNDRY_AGENT_SIGN: "yes", FOUNDRY_SIGNER_TOKEN: TOKEN };
}

describe("batch heartbeat build", () => {
  it("builds one all-or-nothing Batch with three inners and no W0 signer", () => {
    const { tx, nftId, offerId } = filledBatch();
    const checked = policy.assertBatchHeartbeat(tx, {
      state: enabledState(),
      sellOffer: offerFor(nftId, offerId),
      networkId: 1,
      history: [],
      now: NOW,
    });
    assert.equal(tx.TransactionType, "Batch");
    assert.equal(tx.Account, anchors.WALLETS.W1.address);
    assert.equal(tx.Flags, 65536);
    assert.equal(tx.BatchSigners, undefined);
    assert.equal(tx.RawTransactions.length, 3);
    const types = tx.RawTransactions.map((row) => row.RawTransaction.TransactionType);
    assert.deepEqual(types, ["NFTokenAcceptOffer", "AMMDeposit", "DIDSet"]);
    const sequences = tx.RawTransactions.map((row) => row.RawTransaction.Sequence);
    assert.deepEqual(sequences, [41, 42, 43]);
    assert.equal(tx.RawTransactions[1].RawTransaction.Amount, "1000000");
    assert.equal(tx.RawTransactions[1].RawTransaction.Asset.currency, "XRP");
    assert.equal(tx.RawTransactions[1].RawTransaction.Asset2.issuer, anchors.WALLETS.W0.address);
    const uri = Buffer.from(tx.RawTransactions[2].RawTransaction.URI, "hex").toString("utf8");
    assert.equal(uri, heartbeat.didUri("2026-10-12T14:29:00.000Z"));
    assert.equal(checked.offerDrops, "10000");
    assert.equal(checked.depositDrops, "1000000");
    const parsed = require("xrpl").parseNFTokenID(nftId);
    assert.equal(parsed.Taxon, 20261012);
    assert.equal(parsed.Issuer, anchors.WALLETS.W2.address);
    assert.equal(parsed.Flags, 9);
  });

  it("refuses a generic Batch, W0, a wide deposit, and a closed gate", () => {
    const { tx, nftId, offerId } = filledBatch();
    const base = {
      env: agentEnv(),
      wallet: "W1",
      tx,
      intent: "batch_heartbeat",
      networkId: 1,
      account: signer.richAccount(),
      history: [],
      motions: [],
      now: NOW,
      sellOffer: offerFor(nftId, offerId),
      offerAmount: "10000",
      state: enabledState(),
    };
    assert.equal(policy.assertAgentRequest(base).wallet.id, "W1");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, base, { intent: "agent-sign" })), "BATCH");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, base, {
      state: { watched: { batch: { atomic_enabled: false } } },
    })), "BATCH");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, base, { networkId: 2 })), "MAINNET");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, base, { networkId: 0 })), "MAINNET");
    const wide = heartbeat.fillBatch(heartbeat.buildBatch({
      offerId,
      depositDrops: "2000001",
      now: NOW,
    }), { sequence: 40, fee: "40" });
    throwsCode(() => policy.assertBatchHeartbeat(wide, {
      state: enabledState(),
      sellOffer: offerFor(nftId, offerId),
      networkId: 1,
      history: [],
      now: NOW,
    }), "CAP");
    const w0 = JSON.parse(JSON.stringify(tx));
    w0.RawTransactions[2].RawTransaction.Account = anchors.WALLETS.W0.address;
    throwsCode(() => policy.assertBatchHeartbeat(w0, {
      state: enabledState(),
      sellOffer: offerFor(nftId, offerId),
      networkId: 1,
      history: [],
      now: NOW,
    }), "W0");
    const flagged = JSON.parse(JSON.stringify(tx));
    flagged.Flags = 131072;
    throwsCode(() => policy.assertBatchHeartbeat(flagged, {
      state: enabledState(),
      sellOffer: offerFor(nftId, offerId),
      networkId: 1,
      history: [],
      now: NOW,
    }), "TX");
    const priced = offerFor(nftId, offerId, "100001");
    throwsCode(() => policy.assertBatchHeartbeat(tx, {
      state: enabledState(),
      sellOffer: priced,
      networkId: 1,
      history: [],
      now: NOW,
    }), "CAP");
    throwsCode(() => policy.assertBatchHeartbeat(tx, {
      state: enabledState(),
      sellOffer: offerFor(nftId, offerId),
      networkId: 1,
      history: [{ action: "batch_heartbeat", ts: "2026-10-12T01:00:00.000Z" }],
      now: NOW,
    }), "DAY");
    throwsCode(() => policy.assertSigningTx({
      TransactionType: "Batch",
      Account: anchors.WALLETS.W1.address,
    }, enabledState()), "BATCH");
  });
});

describe("batch heartbeat prepare policy", () => {
  it("allows a tiny W2 sell to W1 and still refuses a public Walk-In shape", () => {
    const nftId = heartbeat.nftokenId();
    const offer = heartbeat.buildOffer({ nftokenId: nftId, drops: "10000" });
    const mint = heartbeat.buildMint();
    const fields = {
      env: agentEnv(),
      wallet: "W2",
      networkId: 1,
      account: signer.richAccount(),
      history: [],
      motions: [],
      now: NOW,
      state: enabledState(),
      intent: "batch_heartbeat_prepare",
    };
    assert.equal(policy.assertAgentRequest(Object.assign({}, fields, { tx: offer })).wallet.id, "W2");
    assert.equal(policy.assertAgentRequest(Object.assign({}, fields, { tx: mint })).wallet.id, "W2");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, fields, {
      intent: undefined,
      tx: offer,
    })), "DEST");
    const genesis = heartbeat.nftokenId({ taxon: 20260927, flags: 8, fee: 1000, sequence: 21093718 });
    throwsCode(() => policy.assertBatchPrepare(heartbeat.buildOffer({ nftokenId: genesis, drops: "10000" })), "TX");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, fields, { networkId: 21337, tx: mint })), "MAINNET");
  });

  it("chooses mint, list, or the open W1 offer", () => {
    const bare = heartbeat.nftokenId({ sequence: 2 });
    const listed = heartbeat.nftokenId({ sequence: 3 });
    const foreign = heartbeat.nftokenId({ sequence: 4 });
    assert.equal(heartbeat.choosePrepare([], {}).action, "mint");
    assert.equal(heartbeat.choosePrepare([{ NFTokenID: bare }], {}).action, "offer");
    const ready = heartbeat.choosePrepare(
      [{ NFTokenID: listed }],
      {
        [listed]: [{
          amount: "10000",
          flags: 1,
          owner: anchors.WALLETS.W2.address,
          destination: anchors.WALLETS.W1.address,
          nft_offer_index: "D".repeat(64),
        }],
      }
    );
    assert.equal(ready.action, "ready");
    assert.equal(ready.offerId, "D".repeat(64));
    assert.throws(() => heartbeat.choosePrepare(
      [{ NFTokenID: foreign }],
      {
        [foreign]: [{
          amount: "10000",
          flags: 1,
          owner: anchors.WALLETS.W2.address,
          destination: anchors.WALLETS.W3.address,
          nft_offer_index: "E".repeat(64),
        }],
      }
    ), (error) => error.code === "OFFER");
  });
});

describe("batch heartbeat dry-run", () => {
  it("prints the autofilled Batch and does not load a key or submit", async () => {
    const nftId = heartbeat.nftokenId();
    const offerId = heartbeat.placeholderOfferId();
    let loads = 0;
    const body = await heartbeat.dryRun({
      env: { CI: "true", W1_REGULAR_SEED: "present-not-used", W0_SEED: "present-not-used" },
      now: NOW,
      history: [],
      probe: {
        atomic_enabled: true,
        network_id: 1,
        rpc: "https://testnet.xrpl-labs.com",
        build_version: "3.4.1",
        ledger_index: 21481382,
        amendments: enabledState().watched.batch.amendments,
      },
      found: { action: "mint" },
      autofill: async (tx) => heartbeat.fillBatch(tx, { sequence: 40, fee: "40", lastLedger: 21481382 }),
      loadSeed() {
        loads += 1;
        return "present-not-used";
      },
    });
    assert.equal(loads, 0);
    assert.equal(body.mode, "dry-run");
    assert.equal(body.signed, false);
    assert.equal(body.submitted, false);
    assert.equal(body.key_loaded, false);
    assert.equal(body.signer, "not called");
    assert.equal(body.network_id, 1);
    assert.equal(body.wallets.w0_signs, false);
    assert.equal(body.wallets.batch, "W1");
    assert.equal(body.wallets.did, "W1");
    assert.equal(body.wallets.prepare, "W2");
    assert.equal(body.placeholder_offer, true);
    assert.equal(body.expected_spend_drops, "1010000");
    assert.equal(body.tx.TransactionType, "Batch");
    assert.equal(body.tx.RawTransactions.length, 3);
    assert.equal(JSON.stringify(body).includes("present-not-used"), false);
    assert.equal(body.prepare.mint.TransactionType, "NFTokenMint");
    assert.equal(body.prepare.offer.Destination, anchors.WALLETS.W1.address);
    assert.equal(nftId.length, 64);
    assert.equal(offerId.length, 64);
    const src = fs.readFileSync(path.join(__dirname, "heartbeat.js"), "utf8");
    assert.equal(src.includes("fromSeed"), false);
    assert.equal(src.includes("W0_SEED"), false);
    assert.equal(src.includes("aether-foundry-secrets"), false);
    assert.equal(src.includes("Wallet"), false);
  });

  it("asks the signer to dry-run the Batch without loading a key", async () => {
    const { tx, nftId, offerId } = filledBatch();
    let loads = 0;
    const outcome = await signer.evaluate({
      wallet: "W1",
      intent: "batch_heartbeat",
      dry_run: true,
      tx,
    }, {
      env: agentEnv(),
      dry: true,
      skipAuth: true,
      skipRpc: true,
      skipMotions: true,
      metrics: false,
      networkId: 1,
      account: signer.richAccount(),
      history: [],
      motions: [],
      state: enabledState(),
      sellOffer: offerFor(nftId, offerId),
      offerAmount: "10000",
      now: NOW,
      loadSeed() {
        loads += 1;
        throw new Error("key loaded");
      },
      autofill: async (value) => value,
    });
    assert.equal(loads, 0);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.dry_run, true);
    assert.equal(outcome.body.key_loaded, false);
    assert.equal(outcome.body.signed, false);
    assert.equal(outcome.body.submitted, false);
    assert.equal(outcome.body.tx.Flags, 65536);
  });

  it("refuses --live under CI before any submit", () => {
    const result = spawnSync(process.execPath, ["src/batch/heartbeat.js", "--live"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { CI: "true", FOUNDRY_SIGNER_TOKEN: TOKEN }),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI/);
    assert.equal(result.stdout, "");
  });
});

describe("batch heartbeat ledger check", () => {
  it("requires tesSUCCESS on the outer transaction and every inner", async () => {
    const { tx } = filledBatch();
    const xrpl = require("xrpl");
    const outerHash = "F".repeat(64);
    const inners = tx.RawTransactions.map((row) => ({
      hash: xrpl.hashes.hashSignedTx(row.RawTransaction).toUpperCase(),
      type: row.RawTransaction.TransactionType,
    }));
    assert.equal(new Set(inners.map((row) => row.hash)).size, 3);
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body);
      const id = String(request.params[0].transaction).toUpperCase();
      if (id === outerHash) {
        return {
          ok: true,
          json: async () => ({
            result: {
              hash: outerHash,
              ledger_index: 21482000,
              validated: true,
              meta: { TransactionResult: "tesSUCCESS" },
              tx_json: tx,
            },
          }),
        };
      }
      const hit = inners.find((row) => row.hash === id);
      const resultCode = hit && hit.type === "AMMDeposit" ? "tecUNFUNDED" : "tesSUCCESS";
      return {
        ok: true,
        json: async () => ({
          result: hit
            ? {
                hash: hit.hash,
                ledger_index: 21482000,
                validated: true,
                meta: { TransactionResult: resultCode },
              }
            : { error: "txnNotFound", status: "error" },
        }),
      };
    };
    await assert.rejects(
      () => heartbeat.verifyBatch("https://testnet.xrpl-labs.com", outerHash, fetchImpl),
      (error) => error.code === "SUBMIT" && /AMMDeposit/.test(error.message)
    );
    const okFetch = async (url, init) => {
      const request = JSON.parse(init.body);
      const id = String(request.params[0].transaction).toUpperCase();
      if (id === outerHash) return fetchImpl(url, init);
      return {
        ok: true,
        json: async () => ({
          result: {
            hash: id,
            ledger_index: 21482000,
            validated: true,
            meta: { TransactionResult: "tesSUCCESS" },
          },
        }),
      };
    };
    const verified = await heartbeat.verifyBatch("https://testnet.xrpl-labs.com", outerHash, okFetch);
    assert.equal(verified.result, "tesSUCCESS");
    assert.equal(verified.inners.length, 3);
    assert.deepEqual(verified.inners.map((row) => row.result), ["tesSUCCESS", "tesSUCCESS", "tesSUCCESS"]);
  });
});
