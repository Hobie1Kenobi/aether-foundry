"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../../director/anchors");
const missionConfig = require("../../missions/config");
const { control, view } = require("../../missions/engine");
const bounds = require("./bounds");
const { decide } = require("./director");
const engine = require("./engine");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-09T03:30:00.000Z";
const FIXTURES = path.join(__dirname, "fixtures/w1-2026-11-09");

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "w1-live-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
    JSON.stringify({ type: "mission.upsert", at: NOW, mission: { id: "msn5b5c3223e5e88526", hold: "uncertain", signed: true, updated_at: NOW } }),
    JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747" } }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
  ].join("\n")}\n`);
  return ledger;
}

function fixtureClient(state) {
  const serverInfo = readFixture("server_info.json");
  const accountInfo = readFixture("account_info.json");
  const accountLines = readFixture("account_lines.json");
  const accountOffers = readFixture("account_offers.json");
  const ammInfo = readFixture("amm_info.json");
  const bookBids = readFixture("book_bids.json");
  const bookAsks = readFixture("book_asks.json");
  const fee = readFixture("fee.json");
  return {
    mode: "injected",
    sign: async (tx) => {
      state.signs += 1;
      state.lastTx = tx;
      return {
        tx_blob: xrpl.encode(Object.assign({}, tx, {
          SigningPubKey: `ED${"AA".repeat(32)}`,
          TxnSignature: "00".repeat(64),
        })),
      };
    },
    submit: async () => {
      state.submits += 1;
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") return serverInfo;
        if (req.command === "account_info") return accountInfo;
        if (req.command === "account_lines") return accountLines;
        if (req.command === "account_offers") return accountOffers;
        if (req.command === "amm_info") return ammInfo;
        if (req.command === "fee") return fee;
        if (req.command === "book_offers") {
          const gets = req.taker_gets;
          return gets && gets.currency === "XRP" ? bookBids : bookAsks;
        }
        if (req.command === "tx") return { result: { validated: false, error: "txnNotFound" } };
        throw new Error(req.command);
      },
    },
  };
}

function env() {
  return {
    FOUNDRY_DEX_EXECUTE: "yes",
    FOUNDRY_DEX_ROLE: "W1",
    FOUNDRY_DEX_NETWORK: "xrpl:1",
    FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W1.address,
    FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
    FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
    FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
    FOUNDRY_DEX_AXELAR_DROPS: "0",
    FOUNDRY_W1_DEX_LIVE: "yes",
    FOUNDRY_W1_DEX_WS: "wss://testnet.xrpl-labs.com",
    FOUNDRY_W1_DEX_ACCOUNT_FILE: "/tmp/w1.json",
  };
}

describe("w1 live public replay", () => {
  it("reaches the bankroll on the published Testnet shape and signs nothing", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "w1-live-journal-"));
    const state = { signs: 0, submits: 0, lastTx: null };
    const row = await decide(env(), { now: NOW, ledger, journal }, fixtureClient(state));
    assert.notEqual(row.error_code, "OFFER");
    assert.notEqual(row.error_code, "VALUATION");
    assert.equal(row.decision, "research");
    assert.equal(row.sole_lp, true);
    assert.equal(row.traded, false);
    assert.equal(row.risk_increasing, false);
    assert.equal(row.offer_lock_drops, "2275000");
    assert.equal(row.lp_xrp_drops, "51783389");
    assert.equal(row.base_reserve_drops, "1000000");
    assert.equal(row.reserve_drops, "1600000");
    assert.equal(row.bankroll_used_drops, "56658389");
    assert.equal(row.bankroll_remaining_drops, "0");
    assert.equal(state.signs, 0);
  });

  it("can cancel an AETH-selling offer without treating it as an XRP lock", async () => {
    const ledger = home();
    const id = "msnaethsell0000001";
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id,
        kind: "w1-dex-offer",
        status: "dex_open",
        hold: "uncertain",
        sequence: 21093737,
        outstanding_drops: "10",
        realized_loss_drops: "0",
        fee_drops: "10",
        account: anchors.WALLETS.W1.address,
        updated_at: NOW,
      },
    })}\n`);
    const state = { signs: 0, submits: 0, lastTx: null };
    const result = await engine.cancel(ledger, { now: NOW, mission_id: id }, fixtureClient(state));
    assert.notEqual(result.status, undefined);
    assert.equal(state.lastTx.TransactionType, "OfferCancel");
    assert.equal(state.lastTx.OfferSequence, 21093737);
    assert.equal(state.signs, 1);
    const saved = view(ledger, NOW).missions[id];
    assert.equal(saved.cancel_tx.OfferSequence, 21093737);
  });
});
