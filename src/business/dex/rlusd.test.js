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
const rlusd = require("./rlusd");
const signer = require("./signer");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-09T04:00:00.000Z";
const W1FIX = path.join(__dirname, "fixtures/w1-2026-11-09");
const RLUSDFIX = path.join(__dirname, "fixtures/rlusd-2026-11-09");

function read(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
    JSON.stringify({ type: "mission.upsert", at: NOW, mission: { id: "msn5b5c3223e5e88526", hold: "uncertain", signed: true, updated_at: NOW } }),
    JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747" } }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
  ].join("\n")}\n`);
  return ledger;
}

function client(state) {
  const w1 = (name) => read(W1FIX, name);
  const rl = (name) => read(RLUSDFIX, name);
  return {
    mode: "injected",
    sign: async (tx) => {
      state.signs += 1;
      state.lastTx = tx;
      return { tx_blob: xrpl.encode(Object.assign({}, tx, { SigningPubKey: `ED${"AA".repeat(32)}`, TxnSignature: "00".repeat(64) })) };
    },
    submit: async () => {
      state.submits += 1;
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") return w1("server_info.json");
        if (req.command === "account_info") return w1("account_info.json");
        if (req.command === "account_offers") return w1("account_offers.json");
        if (req.command === "account_lines") return w1("account_lines.json");
        if (req.command === "fee") return w1("fee.json");
        if (req.command === "tx") return { result: { validated: false, error: "txnNotFound" } };
        if (req.command === "amm_info") {
          const issuer = req.asset2 && req.asset2.issuer;
          return issuer === rlusd.ISSUER ? rl("amm.json") : w1("amm_info.json");
        }
        if (req.command === "book_offers") {
          const issuer = (req.taker_pays && req.taker_pays.issuer) || (req.taker_gets && req.taker_gets.issuer);
          if (issuer === rlusd.ISSUER) {
            return req.taker_gets && req.taker_gets.currency === "XRP" ? rl("bids.json") : rl("asks.json");
          }
          return req.taker_gets && req.taker_gets.currency === "XRP" ? w1("book_bids.json") : w1("book_asks.json");
        }
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
    FOUNDRY_DEX_RLUSD: "yes",
  };
}

describe("rlusd trading", () => {
  it("rejects lookalike issuers and does not trade from W0 or W2", () => {
    assert.equal(rlusd.isRlusd({ currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "1" }), true);
    assert.equal(rlusd.isRlusd({ currency: "RLUSD", issuer: rlusd.ISSUER, value: "1.5" }), true);
    assert.equal(rlusd.isRlusd({ currency: rlusd.CURRENCY, issuer: anchors.WALLETS.W0.address, value: "1" }), false);
    assert.equal(rlusd.isRlusd({ currency: "524C555344000000000000000000000000000001", issuer: rlusd.ISSUER, value: "1" }), false);
    assert.throws(() => rlusd.planTrustLine(anchors.WALLETS.W0.address), (error) => error.code === "W0");
    const other = rlusd.planTrustLine(anchors.WALLETS.W2.address);
    assert.equal(other.submit, false);
    assert.equal(other.trading, false);
    assert.equal(rlusd.planTrustLine(anchors.WALLETS.W1.address).submit, true);
    const amm = readPool();
    const quote = rlusd.quoteBuy(amm, 1000000n);
    assert.equal(quote.sendMax, 1000000n);
    const swap = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "swap.json"), "utf8")).result;
    const swapTx = swap.tx_json || swap;
    assert.equal(swap.validated, true);
    assert.equal((swap.meta || swap.metaData).TransactionResult, "tesSUCCESS");
    assert.equal(swapTx.Amount.currency, rlusd.CURRENCY);
    assert.equal(swapTx.Amount.issuer, rlusd.ISSUER);
    assert.equal(rlusd.MAX_TRADE_DROPS.toString(), "2000000");
    const marked = rlusd.markInventory(amm, [
      { account: anchors.WALLETS.W2.address, xrp: 50000000n, rlusd: 1000000000000000n },
      { account: "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv", xrp: 3800000n, rlusd: rlusdQuote("0.3003038826") },
    ], rlusdQuote("1"));
    assert.equal(marked.proved, true);
    assert.equal(marked.xrp < 3800000n * 100n, true);
  });

  it("opens one W1 trust line on the live book and does not sign it twice", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-journal-"));
    const state = { signs: 0, submits: 0, lastTx: null };
    const first = await decide(env(), { now: NOW, ledger, journal }, client(state));
    assert.equal(first.decision, "trustline");
    assert.equal(first.learning, false);
    assert.equal(first.traded, false);
    assert.equal(first.rlusd_headroom_drops, "43341611");
    assert.equal(first.aeth_exit_proposal, null);
    assert.equal(state.signs, 1);
    assert.equal(state.lastTx.TransactionType, "TrustSet");
    assert.equal(state.lastTx.Account, anchors.WALLETS.W1.address);
    assert.equal(state.lastTx.Flags, 0x00020000);
    assert.equal(state.lastTx.LimitAmount.currency, rlusd.CURRENCY);
    assert.equal(state.lastTx.LimitAmount.issuer, rlusd.ISSUER);
    assert.equal(state.lastTx.LimitAmount.value, "10");
    const second = await decide(env(), { now: NOW, ledger, journal }, client(state));
    assert.equal(second.decision, "reconcile");
    assert.equal(state.signs, 1);
    const text = fs.readFileSync(path.join(journal, "decisions.jsonl"), "utf8");
    assert.equal(text.includes("learning\":true"), false);
    await assert.rejects(() => signer.sign({
      TransactionType: "Payment",
      Account: anchors.WALLETS.W1.address,
      Destination: anchors.WALLETS.W1.address,
      Amount: { currency: rlusd.CURRENCY, issuer: "rLookalikeIssuer111111111111111", value: "1" },
      SendMax: "1000000",
      Fee: "10",
      Sequence: 1,
      LastLedgerSequence: 20,
    }, {
      type: "Payment",
      account: anchors.WALLETS.W1.address,
      sequence: 1,
      last: 20,
      fee: "10",
      send_max: "1000000",
      deliver: "1",
    }, async () => ({ tx_blob: "00" })), (error) => error.code === "TX");
  });
});

function readPool() {
  const body = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "amm.json"), "utf8")).result.amm;
  return {
    xrp: BigInt(body.amount),
    rlusd: require("./market").scaled(body.amount2.value),
    tradingFee: body.trading_fee,
  };
}

function rlusdQuote(value) {
  return require("./market").scaled(value);
}
