"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const missionConfig = require("../missions/config");
const { control } = require("../missions/engine");
const { CAPABILITIES, axelarAdapter, activationCriteria, PERMANENT_HOLD } = require("./capabilities");
const { propose } = require("./schedule");
const { prepareOffer, prepareCancel, observeOffer, kill, load, TF_PASSIVE } = require("./offer");
const { tick } = require("./worker");
const runtimePolicy = require("../runtime/policy");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-08T18:00:00.000Z";

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "biz-"));
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

describe("business schedule", () => {
  it("classifies capabilities and keeps Axelar at zero", () => {
    const payment = CAPABILITIES.find((row) => row.id === "xrpl.payment.exact");
    const offer = CAPABILITIES.find((row) => row.id === "xrpl.dex.offer");
    const amm = CAPABILITIES.find((row) => row.id === "xrpl.amm.lp");
    const staking = CAPABILITIES.find((row) => row.id === "xrpl.staking");
    assert.equal(payment.cls, "real_testnet");
    assert.equal(payment.armed, false);
    assert.equal(offer.cls, "real_testnet");
    assert.equal(offer.submits, false);
    assert.equal(offer.enabled, false);
    assert.equal(amm.cls, "candidate");
    assert.equal(amm.pool_state_verified, false);
    assert.equal(amm.fees_are_apr, false);
    assert.equal(staking.available, false);
    assert.equal(staking.amendment_probe_required, true);
    const bridge = axelarAdapter();
    assert.equal(bridge.writes_enabled, false);
    assert.equal(bridge.gas_budget_drops, "0");
    assert.equal(bridge.gas_budget_wei, "0");
    assert.equal(bridge.available, true);
    assert.equal(bridge.implemented, false);
    assert.equal(bridge.authorized, false);
    assert.equal(bridge.enabled, false);
    assert.equal(bridge.direct_l1_path_documented, true);
    assert.equal(bridge.direct_l1_path_implemented, false);
    assert.equal(bridge.w8_present, false);
    assert.equal(bridge.gas_example_is_permission, false);
    assert.equal(bridge.testnet_gateway, "rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2");
    assert.deepEqual(bridge.chain_names, ["xrpl", "xrpl-evm"]);
    assert.equal(bridge.evm_consensus, "proof_of_authority");
    assert.equal(bridge.evm_chain_id_restated_on_contracts_page, false);
    assert.equal(bridge.documented_gas_example_drops.its_gas, "100000");
    assert.equal(bridge.documented_gas_example_drops.gmp_amount_all_gas, "1000000");
    assert.equal(bridge.foundry_diagnostic_uses_that_rpc, false);
    assert.equal(bridge.native_xrp_staking, false);
    const gates = activationCriteria().join(" ");
    assert.equal(gates.includes("asleep"), true);
    assert.equal(gates.includes("1747"), true);
    assert.equal(gates.includes("W0"), true);
    assert.equal(gates.includes("zero gas"), true);
  });

  it("proposes one procurement plan inside the shared cap and does not write", () => {
    const ledger = home();
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"));
    const seller = xrpl.Wallet.generate().address;
    const first = propose({
      now: NOW,
      ledger,
      role: "procurement",
      seller,
      payment_drops: "10",
      network_fee_drops: "10",
    });
    const second = propose({
      now: NOW,
      ledger,
      role: "procurement",
      seller,
      payment_drops: "10",
      network_fee_drops: "10",
    });
    assert.equal(first.id, second.id);
    assert.equal(first.signed, false);
    assert.equal(first.submitted, false);
    assert.equal(first.armed, false);
    assert.equal(first.budget.budget_drops, "20");
    assert.equal(first.accounting.day_used_drops, "1747");
    assert.equal(first.exposure_drops, "20");
    assert.equal(fs.readFileSync(path.join(ledger, "events.jsonl")).equals(before), true);
    assert.throws(() => propose({ now: NOW, role: "procurement", seller: anchors.WALLETS.W0.address, payment_drops: "10", network_fee_drops: "10" }), (error) => error.code === "W0");
    assert.throws(() => propose({ now: NOW, network: "xrpl:0", role: "procurement", seller, payment_drops: "10", network_fee_drops: "10" }), (error) => error.code === "MAINNET");
  });

  it("counts the legacy hold and refuses unsupported roles", () => {
    const ledger = home();
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "budget.uncertain",
      at: NOW,
      mission_id: PERMANENT_HOLD,
      day: "2026-11-06",
      drops: "4998243",
      settlement: "submit_unknown",
      live: true,
    })}\n`);
    const seller = xrpl.Wallet.generate().address;
    assert.throws(
      () => propose({ now: "2026-11-09T18:00:00.000Z", ledger, role: "procurement", seller, payment_drops: "10", network_fee_drops: "10" }),
      (error) => error.code === "CAP"
    );
    const books = propose({ now: NOW, ledger, role: "risk-accounting" });
    assert.equal(books.execution, false);
    assert.equal(books.accounting.day_used_drops, "4999990");
    for (const role of ["treasury", "trading", "liquidity", "bridge"]) {
      const plan = propose({ now: NOW, role, seller });
      assert.equal(plan.execution, false);
      assert.equal(plan.armed, false);
      assert.equal(plan.exposure_drops, "0");
      assert.equal(plan.axelar.gas_budget_drops, "0");
    }
    assert.equal(propose({ now: NOW, role: "bridge" }).code, "AXELAR_DISABLED");
    assert.equal(propose({ now: NOW, role: "trading" }).code, "DISABLED");
    assert.throws(() => propose({ now: NOW, role: "procurement", seller, payment_drops: "10", network_fee_drops: "10", state: { killed: true } }), (error) => error.code === "killed");
  });

  it("prepares one unsigned W1 offer and keeps it inside the shared cap", () => {
    const ledger = home();
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"));
    const offerHome = fs.mkdtempSync(path.join(os.tmpdir(), "offers-"));
    const aeth = { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "1" };
    const foreign = xrpl.Wallet.generate().address;
    const baseOffer = {
      now: NOW,
      wallet_id: "W1",
      account: anchors.WALLETS.W1.address,
      network: "xrpl:1",
      network_id: 1,
      taker_pays: "1000",
      taker_gets: aeth,
      fee_drops: "10",
      owner_reserve_drops: "200000",
      sequence: 10,
      last_ledger_sequence: 10020,
      validated_ledger: 10000,
      flags: TF_PASSIVE,
      destination: foreign,
      idempotency_key: "w1-offer-0001",
      ledger,
      day_used_drops: "0",
    };
    assert.throws(
      () => runtimePolicy.assertMissionSpend({ TransactionType: "OfferCreate", Account: "r", Destination: "r" }, {}),
      (error) => error.code === "TX"
    );
    const disabled = tick({}, { now: NOW, role: "trading", home: offerHome });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.written, false);
    assert.equal(disabled.signed, false);
    assert.equal(fs.existsSync(path.join(offerHome, "offers.jsonl")), false);
    const opened = tick({ FOUNDRY_BUSINESS_EXECUTE: "yes" }, Object.assign({ home: offerHome, role: "trading" }, baseOffer));
    assert.equal(opened.plan, undefined);
    assert.equal(opened.signed, false);
    assert.equal(opened.submitted, false);
    assert.equal(opened.offer.status, "prepared");
    assert.equal(opened.offer.network, "xrpl:1");
    assert.equal(opened.offer.activity, "demo_counterparty_not_customer_revenue");
    assert.equal(opened.offer.price_source, "operator_limit");
    assert.equal(opened.offer.book_checked, false);
    assert.equal(opened.offer.exposure_drops, "201010");
    assert.equal(opened.offer.tx.TransactionType, "OfferCreate");
    assert.equal(opened.offer.tx.Flags, TF_PASSIVE);
    assert.equal(opened.offer.tx.NetworkID, undefined);
    assert.equal(opened.offer.tx.Memos, undefined);
    assert.equal(JSON.stringify(opened.offer).includes("seed"), false);
    assert.equal(fs.readFileSync(path.join(ledger, "events.jsonl")).equals(before), true);
    const replay = tick({ FOUNDRY_BUSINESS_EXECUTE: "yes" }, Object.assign({ home: offerHome, role: "trading" }, baseOffer));
    assert.equal(replay.replay, true);
    assert.equal(replay.written, false);
    assert.equal(load(offerHome).offers[opened.offer.id].exposure_drops, "201010");
    const book = prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-book1", destination: undefined, sequence: 12 }));
    assert.equal(book.offer.activity, "book_resting_offer_not_customer_revenue");
    assert.equal(book.offer.tx.Destination, undefined);
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0002", wallet_id: "W0", account: anchors.WALLETS.W0.address })), (error) => error.code === "W0");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0003", wallet_id: "W2", account: anchors.WALLETS.W2.address })), (error) => error.code === "WALLET");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0004", destination: anchors.WALLETS.W1.address })), (error) => error.code === "WASH");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0005", network: "xrpl:0", network_id: 0 })), (error) => error.code === "MAINNET");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0006", taker_gets: { currency: "USD", issuer: foreign, value: "1" } })), (error) => error.code === "ASSET");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0007", owner_reserve_drops: undefined })), (error) => error.code === "RESERVE");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0008", taker_pays: "900000" })), (error) => error.code === "CAP");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0009", ledger: undefined, day_used_drops: "4900000" })), (error) => error.code === "CAP");
    const seen = observeOffer(offerHome, { now: NOW, offer_id: opened.offer.id, open_offers: [{ seq: 10, account: anchors.WALLETS.W1.address }] });
    assert.equal(seen.offer.status, "open");
    const expired = observeOffer(offerHome, { now: "2026-11-09T18:00:00.000Z", offer_id: opened.offer.id, expired: true });
    assert.equal(expired.offer.status, "unresolved");
    assert.equal(expired.exposure_drops, "402020");
    const blockedCancel = tick({}, { now: NOW, role: "trading", action: "cancel", home: offerHome, offer_id: opened.offer.id });
    assert.equal(blockedCancel.enabled, false);
    assert.equal(blockedCancel.written, false);
    const cancel = tick({ FOUNDRY_BUSINESS_EXECUTE: "yes" }, {
      now: NOW,
      home: offerHome,
      role: "trading",
      action: "cancel",
      offer_id: opened.offer.id,
      fee_drops: "10",
      sequence: 11,
      ledger,
    });
    assert.equal(cancel.offer.cancel_tx.TransactionType, "OfferCancel");
    assert.equal(cancel.offer.exposure_drops, "201010");
    const still = observeOffer(offerHome, { now: NOW, offer_id: opened.offer.id, cancelled: true });
    assert.equal(still.offer.status, "cancel_prepared");
    assert.equal(still.exposure_drops, "402020");
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-house", destination: anchors.WALLETS.W3.address })), (error) => error.code === "WASH");
    const gone = observeOffer(offerHome, { now: NOW, offer_id: opened.offer.id, cancelled: true, validated_hash: "AB".repeat(32) });
    assert.equal(gone.offer.status, "cancelled");
    const filled = observeOffer(offerHome, { now: NOW, offer_id: book.offer.id, filled: true, validated_hash: "CD".repeat(32) });
    assert.equal(filled.offer.status, "filled");
    assert.equal(filled.exposure_drops, "0");
    assert.equal(load(offerHome).killed, false);
    kill(offerHome, NOW);
    assert.equal(load(offerHome).killed, true);
    assert.throws(() => prepareOffer(offerHome, Object.assign({}, baseOffer, { idempotency_key: "w1-offer-0010" })), (error) => error.code === "killed");
    const quiet = tick({ FOUNDRY_BUSINESS_EXECUTE: "yes", FOUNDRY_BUSINESS_KILL: "yes" }, Object.assign({ home: offerHome, role: "trading" }, baseOffer, { idempotency_key: "w1-offer-0011" }));
    assert.equal(quiet.written, false);
    assert.equal(quiet.signed, false);
  });
});
