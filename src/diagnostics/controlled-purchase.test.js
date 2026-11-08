"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("../missions/config");
const { control, view } = require("../missions/engine");
const { startSeller, SANCTIONS_PAYEE } = require("./controlled-seller");
const { PERMANENT_HOLD, PHRASE, officialScheme, runControlledPurchase } = require("./controlled-purchase");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const DIAG_TOKEN = "diagnostic-token-32-characters-min";

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diag-purchase-"));
  const ledger = path.join(home, "ledger");
  fs.mkdirSync(ledger);
  fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
  return { home, ledger };
}

function seedLegacy(ledger, drops) {
  const mission = {
    id: PERMANENT_HOLD,
    status: "uncertain",
    hold: "unsubmitted",
    budget: { budget_drops: "1747", payment_drops: "1737", network_fee_drops: "10" },
    day: "2026-11-06",
    retry_blocked: true,
    signed: true,
    seller: SANCTIONS_PAYEE,
    claim: { account: "rLegacySequenceHoldAccount1", amount: "1737", fee: "10" },
    updated_at: NOW,
  };
  const lines = [
    { type: "mission.upsert", at: NOW, mission },
    { type: "budget.reserved", at: NOW, mission_id: mission.id, day: "2026-11-06", budget_drops: "1747", components: mission.budget },
    { type: "budget.uncertain", at: NOW, mission_id: mission.id, day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true },
  ];
  if (drops) {
    lines.push({
      type: "budget.spent",
      at: NOW,
      mission_id: "msnspent0000000001",
      day: "2026-11-06",
      drops,
      live: false,
    });
  }
  fs.appendFileSync(path.join(ledger, "events.jsonl"), lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function env(home, ledger, seller, extra) {
  return Object.assign({
    FOUNDRY_MISSION_HOME: home,
    FOUNDRY_MISSION_LEDGER: ledger,
    FOUNDRY_DIAGNOSTIC_PHRASE: PHRASE,
    FOUNDRY_DIAGNOSTIC_TOKEN: DIAG_TOKEN,
    FOUNDRY_DIAGNOSTIC_SELLER: seller,
    FOUNDRY_DIAGNOSTIC_PAYMENT_DROPS: "10",
    FOUNDRY_DIAGNOSTIC_FEE_DROPS: "10",
  }, extra || {});
}

function proof(payTo, found) {
  return async (url, init) => {
    assert.equal(url, "https://testnet.xrpl-labs.com");
    const body = JSON.parse(init.body);
    assert.equal(body.method, "tx");
    if (!found) return new Response(JSON.stringify({ result: { error: "txnNotFound", validated: false } }), { status: 200 });
    return new Response(JSON.stringify({
      result: {
        validated: true,
        hash: body.params[0].transaction,
        Destination: payTo,
        Amount: "10",
        meta: { TransactionResult: "tesSUCCESS" },
      },
    }), { status: 200 });
  };
}

function schemeFor(hashBox) {
  return {
    hook_source: "official_default",
    scheme: {
      settle: async (payload) => {
        const blob = payload.payload.signedTxBlob;
        hashBox.hash = xrpl.hashes.hashSignedTx(blob).toUpperCase();
        return { success: true, transaction: hashBox.hash };
      },
    },
  };
}

describe("controlled purchase", () => {
  it("previews the shared cap and does not write", async () => {
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(ledger);
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"));
    const seller = await startSeller();
    try {
      const vendor = await fetch(`${seller.url}?shape=vendor`);
      const vendorBody = JSON.parse(Buffer.from(vendor.headers.get("payment-required"), "base64").toString("utf8"));
      assert.equal(Object.prototype.hasOwnProperty.call(vendorBody.accepts[0].extra, "areFeesSponsored"), false);
      const official = await fetch(`${seller.url}?shape=official`);
      const officialBody = JSON.parse(Buffer.from(official.headers.get("payment-required"), "base64").toString("utf8"));
      assert.equal(officialBody.accepts[0].extra.areFeesSponsored, false);
      const report = await runControlledPurchase(env(home, ledger, seller.url), { now: NOW });
      assert.equal(report.live, false);
      assert.equal(report.settled, false);
      assert.equal(report.official_settle, "not_run");
      assert.equal(report.daily_used, "1747");
      assert.equal(report.legacy_hold, PERMANENT_HOLD);
      assert.equal(fs.readFileSync(path.join(ledger, "events.jsonl")).equals(before), true);
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), false);
      assert.equal(fs.existsSync(path.join(home, "lease-history.jsonl")), false);
      assert.equal(fs.existsSync(path.join(home, "allowlist.json")), false);
    } finally {
      await seller.close();
    }
  });

  it("refuses a reset ledger, a woken worker, the sanctions host, and a cap breach", async () => {
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const seller = "http://127.0.0.1:8794/paid";
    await assert.rejects(() => runControlledPurchase(env(home, ledger, seller), { now: NOW }), (error) => error.code === "CAP");
    seedLegacy(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: false }));
    await assert.rejects(() => runControlledPurchase(env(home, ledger, seller), { now: NOW }), (error) => error.code === "ASLEEP");
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    await assert.rejects(
      () => runControlledPurchase(env(home, ledger, "https://api.stablecoingateways.com/paid"), { now: NOW }),
      (error) => error.code === "HOST"
    );
    await assert.rejects(
      () => runControlledPurchase(env(home, ledger, seller, { FOUNDRY_MISSION_EXECUTE: "yes" }), { now: NOW }),
      (error) => error.code === "AUTH"
    );
    seedLegacy(ledger, "4998253");
    await assert.rejects(() => runControlledPurchase(env(home, ledger, seller), { now: NOW }), (error) => error.code === "CAP");
    assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), false);
  });

  it("keeps the legacy hold and blocks a second attempt after a crash or an unproven settle", async () => {
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(ledger);
    const seller = await startSeller();
    const legacy = JSON.stringify(view(ledger, NOW).missions[PERMANENT_HOLD]);
    const payer = xrpl.Wallet.generate();
    try {
      await assert.rejects(
        () => runControlledPurchase(env(home, ledger, seller.url, { FOUNDRY_DIAGNOSTIC_LIVE: "yes" }), {
          now: NOW,
          wallet: payer,
          validatedLedger: 10000,
          sequence: 10,
          fetch: async () => { throw Object.assign(new Error("timeout"), { code: "ABORT" }); },
        }),
        (error) => error.code === "ABORT"
      );
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), true);
      assert.equal(JSON.stringify(view(ledger, NOW).missions[PERMANENT_HOLD]), legacy);
      await assert.rejects(
        () => runControlledPurchase(env(home, ledger, seller.url, { FOUNDRY_DIAGNOSTIC_LIVE: "yes" }), { now: NOW, wallet: payer }),
        (error) => error.code === "NO_RETRY"
      );
    } finally {
      await seller.close();
    }

    const second = tmpHome();
    control(second.ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(second.ledger);
    const seller2 = await startSeller();
    const legacy2 = JSON.stringify(view(second.ledger, NOW).missions[PERMANENT_HOLD]);
    const hashBox = {};
    try {
      const unproven = await runControlledPurchase(env(second.home, second.ledger, seller2.url, { FOUNDRY_DIAGNOSTIC_LIVE: "yes" }), {
        now: NOW,
        wallet: payer,
        validatedLedger: 10000,
        sequence: 10,
        scheme: schemeFor(hashBox),
        proofFetch: proof(seller2.payTo, false),
      });
      assert.equal(unproven.settled, false);
      assert.equal(unproven.official_settle, "not_proven");
      assert.equal(unproven.reason, "not_validated");
      const mission = view(second.ledger, NOW).missions[unproven.mission_id];
      assert.equal(mission.hold, "uncertain");
      assert.equal(mission.seller, seller2.payTo);
      assert.notEqual(mission.seller, SANCTIONS_PAYEE);
      assert.equal(JSON.stringify(view(second.ledger, NOW).missions[PERMANENT_HOLD]), legacy2);
      await assert.rejects(
        () => runControlledPurchase(env(second.home, second.ledger, seller2.url, { FOUNDRY_DIAGNOSTIC_LIVE: "yes" }), { now: NOW, wallet: payer }),
        (error) => error.code === "NO_RETRY"
      );
      const text = JSON.stringify(unproven);
      assert.equal(text.includes(payer.seed), false);
      assert.equal(text.includes("signedTxBlob"), false);
    } finally {
      await seller2.close();
    }
  });

  it("settles only after an independent validated ledger proof", async () => {
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(ledger);
    const seller = await startSeller();
    const payer = xrpl.Wallet.generate();
    const hashBox = {};
    const empty = officialScheme();
    assert.equal(empty.hook_source, "official_default");
    assert.deepEqual(empty.scheme.options, {});
    try {
      await assert.rejects(
        () => runControlledPurchase(env(home, ledger, seller.url, { FOUNDRY_DIAGNOSTIC_LIVE: "yes" }), {
          now: NOW,
          wallet: payer,
          validatedLedger: 10000,
          sequence: 10,
          scheme: { hook_source: "injected", scheme: { settle: async () => ({ success: true, transaction: "ab".repeat(32) }) } },
        }),
        (error) => error.code === "VERIFY"
      );
      const parked = view(ledger, NOW);
      const created = Object.values(parked.missions).find((mission) => mission.id !== PERMANENT_HOLD);
      assert.equal(created.hold, "uncertain");
      assert.equal(parked.missions[PERMANENT_HOLD].hold, "uncertain");
    } finally {
      await seller.close();
    }

    const fresh = tmpHome();
    control(fresh.ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(fresh.ledger);
    const seller2 = await startSeller();
    try {
      const proven = await runControlledPurchase(env(fresh.home, fresh.ledger, seller2.url, { FOUNDRY_DIAGNOSTIC_LIVE: "yes" }), {
        now: NOW,
        wallet: payer,
        validatedLedger: 10000,
        sequence: 11,
        scheme: schemeFor(hashBox),
        proofFetch: proof(seller2.payTo, true),
      });
      assert.equal(proven.settled, true);
      assert.equal(proven.ledger_proof, "validated");
      assert.equal(proven.official_settle, "supplied_scheme");
      const state = view(fresh.ledger, NOW);
      assert.equal(state.missions[proven.mission_id].hold, "spent");
      assert.equal(state.missions[PERMANENT_HOLD].hold, "uncertain");
      assert.equal(state.days["2026-11-06"].uncertain, "1747");
      assert.equal(state.days["2026-11-06"].spent, "20");
      assert.equal(JSON.stringify(proven).includes(payer.seed), false);
    } finally {
      await seller2.close();
    }
  });
});
