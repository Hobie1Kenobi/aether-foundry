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
    const amm = CAPABILITIES.find((row) => row.id === "xrpl.amm.create");
    assert.equal(payment.cls, "real_testnet");
    assert.equal(payment.armed, false);
    assert.equal(offer.cls, "unsupported");
    assert.equal(amm.cls, "unsupported");
    const bridge = axelarAdapter();
    assert.equal(bridge.writes_enabled, false);
    assert.equal(bridge.gas_budget_drops, "0");
    assert.equal(bridge.gas_budget_wei, "0");
    assert.equal(bridge.direct_l1_bridge, false);
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
    assert.throws(() => propose({ now: NOW, role: "procurement", seller, payment_drops: "10", network_fee_drops: "10", state: { killed: true } }), (error) => error.code === "killed");
  });
});
