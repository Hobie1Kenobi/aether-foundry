"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const missionConfig = require("../missions/config");
const { control, view } = require("../missions/engine");
const policy = require("../missions/policy");
const runtimePolicy = require("../runtime/policy");
const bounds = require("./dex/bounds");
const { tick } = require("./worker");
const { axelarAdapter, PERMANENT_HOLD } = require("./capabilities");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-08T18:00:00.000Z";
const AETH = { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "1" };

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-"));
  const ledger = path.join(dir, "ledger");
  fs.mkdirSync(ledger);
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  const mission = {
    id: PERMANENT_HOLD,
    hold: "uncertain",
    signed: true,
    seller: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs",
    updated_at: NOW,
  };
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
    JSON.stringify({ type: "mission.upsert", at: NOW, mission }),
    JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: mission.id, day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747" } }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: mission.id, day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
  ].join("\n")}\n`);
  return ledger;
}

function roleEnv(extra) {
  return Object.assign({
    FOUNDRY_DEX_EXECUTE: "yes",
    FOUNDRY_DEX_ROLE: "W1",
    FOUNDRY_DEX_NETWORK: "xrpl:1",
    FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W1.address,
    FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
    FOUNDRY_DEX_MAX_LOCKED_DROPS: bounds.MAX_LOCKED_DROPS.toString(),
    FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
    FOUNDRY_DEX_AXELAR_DROPS: "0",
  }, extra || {});
}

function world() {
  return {
    seq: 10000,
    sequence: 10,
    balance: "20000000",
    ownerCount: 0,
    complete: "1-20000",
    networkId: 1,
    validatedAccount: true,
    reserveBase: 1,
    reserveInc: 0.2,
    fee: "10",
    offers: [{ seq: 10 }],
    signs: 0,
    submits: 0,
    lookup: null,
  };
}

function clients(state) {
  return {
    mode: "injected",
    sign: async (tx) => {
      state.signs += 1;
      if (state.signError) throw Object.assign(new Error("sign failed"), { code: state.signError });
      const blob = xrpl.encode(Object.assign({}, tx, {
        SigningPubKey: `ED${"AA".repeat(32)}`,
        TxnSignature: "00".repeat(64),
      }));
      return { tx_blob: blob };
    },
    submit: async () => {
      state.submits += 1;
      if (state.submitError) throw Object.assign(new Error("submit failed"), { code: state.submitError });
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") {
          return { result: { info: {
            network_id: state.networkId,
            complete_ledgers: state.complete,
            validated_ledger: { seq: state.seq, reserve_base_xrp: state.reserveBase, reserve_inc_xrp: state.reserveInc },
          } } };
        }
        if (req.command === "account_info") {
          return { result: {
            validated: state.validatedAccount,
            ledger_index: state.seq,
            account_data: {
              Account: anchors.WALLETS.W1.address,
              Sequence: state.sequence,
              Balance: state.balance,
              OwnerCount: state.ownerCount,
            },
          } };
        }
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: state.fee } } };
        if (req.command === "tx") return state.lookup ? state.lookup(req) : { result: { error: "txnNotFound" } };
        if (req.command === "account_offers") {
          return { result: { validated: true, account: anchors.WALLETS.W1.address, offers: state.offers } };
        }
        throw new Error(req.command);
      },
    },
  };
}

function used(ledger) {
  return policy.dayUsed(view(ledger, NOW), policy.chicagoDay(NOW)).toString();
}

function createResult(tx, hash, remainingGets) {
  const nodes = [{ ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: tx.Account } } }];
  if (remainingGets != null) {
    nodes.push({ CreatedNode: { LedgerEntryType: "Offer", NewFields: {
      Account: tx.Account,
      Sequence: tx.Sequence,
      TakerPays: tx.TakerPays,
      TakerGets: remainingGets,
    } } });
  }
  return { result: { validated: true, hash, ledger_index: 10001, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: nodes }, tx_json: tx } };
}

describe("dex adapter", () => {
  it("stays inactive and refuses a live socket or a caller-chosen wallet", async () => {
    const ledger = home();
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"));
    const state = world();
    const idle = await tick({}, { now: NOW, ledger, role: "trading", idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH }, clients(state));
    assert.equal(idle.activated, false);
    assert.equal(idle.execution_ready, false);
    assert.equal(idle.signed, false);
    assert.equal(idle.written, false);
    assert.equal(fs.readFileSync(path.join(ledger, "events.jsonl")).equals(before), true);
    const unconfigured = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH });
    assert.equal(unconfigured.code, "NO_CLIENT");
    assert.equal(unconfigured.signed, false);
    const raised = await tick(roleEnv({ FOUNDRY_DEX_MAX_LOCKED_DROPS: "900000" }), { now: NOW, ledger, idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH }, clients(state));
    assert.equal(raised.activated, false);
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH }, Object.assign(clients(state), { url: "wss://testnet.xrpl-labs.com" })), (error) => error.code === "LIVE");
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH, destination: "rpt1eK9nC8pQ2fY4mZ", account: anchors.WALLETS.W0.address }, clients(state)), (error) => error.code === "CALLER");
    assert.equal(state.signs, 0);
    assert.throws(
      () => runtimePolicy.assertMissionSpend({ TransactionType: "OfferCreate", Account: "r", Destination: "r" }, {}),
      (error) => error.code === "TX"
    );
    assert.equal(axelarAdapter().gas_budget_drops, "0");
    assert.equal(axelarAdapter().enabled, false);
  });

  it("reserves, signs, and submits one W1 book offer against the shared cap", async () => {
    const ledger = home();
    const state = world();
    const opened = await tick(roleEnv(), {
      now: NOW,
      ledger,
      idempotency_key: "w1-offer-0001",
      taker_gets: "1000",
      taker_pays: AETH,
    }, clients(state));
    assert.equal(opened.live, false);
    assert.equal(opened.execution_ready, false);
    assert.equal(opened.signed, true);
    assert.equal(opened.submitted, true);
    assert.equal(opened.written, true);
    assert.equal(opened.account, anchors.WALLETS.W1.address);
    assert.equal(opened.issuer, anchors.WALLETS.W0.address);
    assert.notEqual(opened.tx.Account, anchors.WALLETS.W0.address);
    assert.equal(opened.tx.TransactionType, "OfferCreate");
    assert.equal(opened.tx.Flags, bounds.TF_PASSIVE);
    assert.equal(opened.tx.Sequence, 10);
    assert.equal(opened.tx.LastLedgerSequence, 10020);
    assert.equal(opened.tx.Fee, "10");
    assert.equal(opened.tx.Destination, undefined);
    assert.equal(opened.tx.NetworkID, undefined);
    assert.equal(opened.outstanding_drops, "201010");
    assert.equal(opened.activity, "book_resting_offer_not_customer_revenue");
    assert.equal(used(ledger), "202757");
    assert.equal(state.signs, 1);
    assert.equal(state.submits, 1);
    const again = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH }, clients(state));
    assert.equal(again.replay, true);
    assert.equal(again.written, false);
    assert.equal(state.signs, 1);
    assert.equal(state.submits, 1);
    state.sequence = 11;
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "budget.uncertain",
      at: NOW,
      mission_id: "msnffffffffffffffff",
      day: "2026-11-07",
      drops: "4000000",
      settlement: "submit_unknown",
      live: false,
    })}\n`);
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0002", taker_gets: "600000", taker_pays: AETH }, clients(state)), (error) => error.code === "CAP");
    assert.equal(state.signs, 1);
    state.balance = "1201000";
    state.sequence = 12;
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger: home(), idempotency_key: "w1-offer-0003", taker_gets: "1000", taker_pays: AETH }, clients(state)), (error) => error.code === "SPENDABLE");
  });

  it("reconciles a partial fill from metadata and keeps the remainder until a matching cancel", async () => {
    const ledger = home();
    const state = world();
    const opened = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0001", taker_gets: "1000", taker_pays: AETH }, clients(state));
    state.lookup = () => createResult(opened.tx, "AA".repeat(32), "400");
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id, filled: true, validated_hash: opened.signed_hash }, clients(state)), (error) => error.code === "CALLER");
    state.lookup = () => createResult(opened.tx, opened.signed_hash, "400");
    state.offers = [];
    const conflict = await tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id }, clients(state));
    assert.equal(conflict.status, "dex_unresolved");
    assert.equal(conflict.outstanding_drops, "201010");
    state.offers = [{ seq: 10 }];
    const partial = await tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id }, clients(state));
    assert.equal(partial.status, "dex_partial");
    assert.equal(partial.outstanding_drops, "200400");
    assert.equal(partial.live, false);
    state.sequence = 11;
    state.offers = [{ seq: 10 }];
    state.lookup = (req) => ({
      result: {
        validated: true,
        hash: req.transaction,
        meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [{ ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: anchors.WALLETS.W1.address } } }] },
        tx_json: {
          TransactionType: "OfferCancel",
          Account: anchors.WALLETS.W1.address,
          OfferSequence: 10,
          Sequence: 11,
          Fee: "10",
          LastLedgerSequence: 10020,
        },
      },
    });
    const unmatched = await tick(roleEnv(), { now: NOW, ledger, action: "cancel", mission_id: opened.id }, clients(state));
    assert.equal(unmatched.status, "dex_unresolved");
    assert.equal(unmatched.proof_reason, "offer_not_deleted");
    assert.equal(view(ledger, NOW).missions[opened.id].outstanding_drops, "200400");
  });

  it("releases a cancelled offer only when the validated metadata deletes it", async () => {
    const ledger = home();
    const state = world();
    const opened = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0004", taker_gets: "1000", taker_pays: AETH }, clients(state));
    state.lookup = () => createResult(opened.tx, opened.signed_hash, "1000");
    const resting = await tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id }, clients(state));
    assert.equal(resting.status, "dex_open");
    assert.equal(resting.outstanding_drops, "201000");
    state.sequence = 11;
    state.offers = [];
    state.lookup = (req) => ({
      result: {
        validated: true,
        hash: req.transaction,
        meta: {
          TransactionResult: "tesSUCCESS",
          AffectedNodes: [
            { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: anchors.WALLETS.W1.address } } },
            { DeletedNode: { LedgerEntryType: "Offer", FinalFields: { Account: anchors.WALLETS.W1.address, Sequence: 10, TakerGets: "1000", TakerPays: AETH } } },
          ],
        },
        tx_json: {
          TransactionType: "OfferCancel",
          Account: anchors.WALLETS.W1.address,
          OfferSequence: 10,
          Sequence: 11,
          Fee: "10",
          LastLedgerSequence: state.seq + bounds.LEDGER_WINDOW,
        },
      },
    });
    const gone = await tick(roleEnv(), { now: NOW, ledger, action: "cancel", mission_id: opened.id }, clients(state));
    assert.equal(gone.status, "dex_cancelled");
    assert.equal(gone.outstanding_drops, "0");
    assert.equal(gone.tx.Account, anchors.WALLETS.W1.address);
    assert.equal(used(ledger), "1767");
    const replay = await tick(roleEnv(), { now: NOW, ledger, action: "cancel", mission_id: opened.id }, clients(state));
    assert.equal(replay.replay, true);
  });

  it("does not release an unfound or expired offer without a covered ledger window", async () => {
    const ledger = home();
    const state = world();
    const opened = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0005", taker_gets: "1000", taker_pays: AETH }, clients(state));
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id, expired: true }, clients(state)), (error) => error.code === "CALLER");
    state.lookup = () => ({ result: { error: "txnNotFound" } });
    state.complete = "32570-40000";
    const hidden = await tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id }, clients(state));
    assert.equal(hidden.outstanding_drops, "201010");
    state.complete = "1-20000";
    state.seq = 10020;
    const openWindow = await tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id }, clients(state));
    assert.equal(openWindow.outstanding_drops, "201010");
    state.seq = 10021;
    const absent = await tick(roleEnv(), { now: NOW, ledger, action: "reconcile", mission_id: opened.id }, clients(state));
    assert.equal(absent.status, "dex_absent");
    assert.equal(absent.outstanding_drops, "0");
    assert.equal(used(ledger), "1747");
  });

  it("keeps one reservation across a submit failure and a restart", async () => {
    const ledger = home();
    const state = world();
    state.submitError = "SUBMIT";
    const unknown = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0006", taker_gets: "1000", taker_pays: AETH }, clients(state));
    assert.equal(unknown.status, "dex_unknown");
    assert.equal(unknown.submitted, false);
    assert.equal(unknown.outstanding_drops, "201010");
    assert.equal(state.submits, 1);
    state.submitError = null;
    const restart = await tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0006", taker_gets: "1000", taker_pays: AETH }, clients(state));
    assert.equal(restart.replay, true);
    assert.equal(state.signs, 1);
    assert.equal(state.submits, 1);
    assert.equal(used(ledger), "202757");
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({ type: "control.kill", at: NOW })}\n`);
    state.sequence = 11;
    await assert.rejects(() => tick(roleEnv(), { now: NOW, ledger, idempotency_key: "w1-offer-0007", taker_gets: "1000", taker_pays: AETH }, clients(state)), (error) => error.code === "killed");
    assert.equal(used(ledger), "202757");
  });
});
