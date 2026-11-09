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
const bankroll = require("./bankroll");
const bounds = require("./dex/bounds");
const { deposit } = require("./dex/amm");
const engine = require("./dex/engine");
const { decide } = require("./dex/director");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-08T18:00:00.000Z";
const LP = "0158534100000000000000000000000000000000";
const AETH = { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "1" };

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "bank-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
    JSON.stringify({ type: "mission.upsert", at: NOW, mission: { id: "msn5b5c3223e5e88526", hold: "uncertain", signed: true, updated_at: NOW } }),
    JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747" } }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
  ].join("\n")}\n`);
  return ledger;
}

function operatorShape() {
  return {
    proved: true,
    reserveBase: 1000000n,
    reserveInc: 200000n,
    ownerCount: 8n,
    balance: 49022152n,
    offers: [
      { seq: 4, locked: 500000n },
      { seq: 5, locked: 500000n },
      { seq: 6, locked: 500000n },
      { seq: 7, locked: 775000n },
    ],
    foreign: [],
    pool: {
      xrp: 51783000n,
      balance: 100n,
      supply: 100n,
      sole: true,
      aethScaled: 1n,
      tradingFee: 500,
    },
  };
}

function clients(state) {
  return {
    mode: "injected",
    sign: async (tx) => {
      state.signs += 1;
      return { tx_blob: xrpl.encode(Object.assign({}, tx, { SigningPubKey: `ED${"AA".repeat(32)}`, TxnSignature: "00".repeat(64) })) };
    },
    submit: async () => {
      state.submits += 1;
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") {
          return { result: { info: { network_id: 1, validated_ledger: { seq: state.seq, reserve_base_xrp: state.reserveBase, reserve_inc_xrp: state.reserveInc } } } };
        }
        if (req.command === "account_info") {
          return { result: { validated: true, ledger_index: state.seq, account_data: { Account: anchors.WALLETS.W1.address, Sequence: state.sequence, Balance: state.balance, OwnerCount: state.ownerCount } } };
        }
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: state.fee } } };
        if (req.command === "amm_info") return { result: { validated: state.ammValidated !== false, ledger_index: state.seq, amm: state.amm } };
        if (req.command === "account_lines") return { result: { validated: true, account: anchors.WALLETS.W1.address, marker: null, lines: state.lines } };
        if (req.command === "account_offers") return { result: { validated: true, account: anchors.WALLETS.W1.address, ledger_index: state.seq, marker: null, offers: state.offers } };
        if (req.command === "book_offers") return { result: { validated: true, ledger_index: state.seq, marker: null, offers: state.book } };
        if (req.command === "tx") return { result: { error: "txnNotFound" } };
        throw new Error(req.command);
      },
    },
  };
}

function fresh(extra) {
  return Object.assign({
    seq: 10000,
    sequence: 10,
    balance: "200000000",
    ownerCount: 0,
    reserveBase: 1,
    reserveInc: 0.2,
    fee: "10",
    offers: [],
    book: [],
    lines: [],
    signs: 0,
    submits: 0,
    amm: {
      account: anchors.AMM,
      amount: "1000000",
      amount2: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "100" },
      lp_token: { currency: LP, issuer: anchors.AMM, value: "100" },
      trading_fee: 500,
    },
  }, extra || {});
}

describe("shared dex lp bankroll", () => {
  it("inventories the sole LP and the open quotes once", () => {
    const position = bankroll.room({ missions: {} }, operatorShape());
    assert.equal(position.uncertain, false);
    assert.equal(position.lp_xrp.toString(), "51783000");
    assert.equal(position.offer_lock.toString(), "2275000");
    assert.equal(position.reserve.toString(), "1600000");
    assert.equal(position.used.toString(), "55658000");
    assert.equal(position.remaining.toString(), "44342000");
    assert.equal(position.limit.toString(), "100000000");
    assert.equal(bankroll.spendable(operatorShape()).toString(), "44147152");
    const doubled = bankroll.room({
      missions: {
        lp: { kind: "w1-amm-lp", status: "amm_open", outstanding_drops: "51783000", hold: "uncertain", realized_loss_drops: "0" },
      },
    }, operatorShape());
    assert.equal(doubled.used.toString(), position.used.toString());
    assert.equal(policy.dayUsed({ days: { "2026-11-08": { uncertain: "1747" } } }, "2026-11-08").toString(), "1747");
  });

  it("fails closed when the pool cannot be valued and does not refill after restart", async () => {
    assert.equal(bankroll.room(null, { proved: false }).remaining.toString(), "0");
    const ledger = home();
    const state = fresh();
    const env = {
      FOUNDRY_DEX_EXECUTE: "yes",
      FOUNDRY_DEX_ROLE: "W1",
      FOUNDRY_DEX_NETWORK: "xrpl:1",
      FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W1.address,
      FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
      FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
      FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
      FOUNDRY_DEX_AXELAR_DROPS: "0",
    };
    const opened = await engine.place(ledger, { now: NOW, idempotency_key: "w1-bank-0001", taker_gets: "90000000", taker_pays: AETH }, clients(state));
    assert.equal(opened.signed, true);
    assert.equal(policy.dayUsed(view(ledger, NOW), policy.chicagoDay(NOW)).toString(), "1747");
    const again = bankroll.room(view(ledger, NOW), {
      proved: true,
      reserveInc: 200000n,
      ownerCount: 0n,
      reserveBase: 1000000n,
      balance: 200000000n,
      offers: [],
      pool: { xrp: 1000000n, balance: 0n, supply: 100n, sole: false },
    });
    const restarted = bankroll.room(view(ledger, NOW), {
      proved: true,
      reserveInc: 200000n,
      ownerCount: 0n,
      reserveBase: 1000000n,
      balance: 200000000n,
      offers: [],
      pool: { xrp: 1000000n, balance: 0n, supply: 100n, sole: false },
    });
    assert.equal(restarted.used.toString(), again.used.toString());
    assert.equal(restarted.pending > 0n, true);
    state.sequence = 11;
    await assert.rejects(() => engine.place(ledger, { now: NOW, idempotency_key: "w1-bank-0002", taker_gets: "20000000", taker_pays: AETH }, clients(state)), (error) => error.code === "BANKROLL");
    assert.equal(state.signs, 1);
  });

  it("lets two orders share the ledger lock and refuses a sole-LP deposit", async () => {
    const ledger = home();
    const state = fresh();
    const raced = await Promise.allSettled([
      engine.place(ledger, { now: NOW, idempotency_key: "w1-bank-lock1", taker_gets: "40000000", taker_pays: AETH }, clients(state)),
      engine.place(ledger, { now: NOW, idempotency_key: "w1-bank-lock2", taker_gets: "45000000", taker_pays: AETH }, clients(state)),
    ]);
    const missions = Object.values(view(ledger, NOW).missions).filter((row) => row.kind === "w1-dex-offer");
    assert.equal(missions.length, 1);
    assert.equal(state.signs, 1);
    assert.equal(raced.filter((row) => row.status === "rejected").length, 1);
    state.lines = [{ account: anchors.AMM, currency: LP, balance: "100" }];
    state.amm.amount = "51783000";
    await assert.rejects(() => deposit(home(), { now: NOW, idempotency_key: "w1-lp-deposit", xrp_drops: "1000000", aeth: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "10" } }, clients(state)), (error) => error.code === "SOLE_LP");
    const exitLedger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "bank-journal-"));
    const env = {
      FOUNDRY_W1_DEX_LIVE: "yes",
      FOUNDRY_W1_DEX_WS: "wss://testnet.xrpl-labs.com",
      FOUNDRY_W1_DEX_ACCOUNT_FILE: "/tmp/w1.json",
      FOUNDRY_DEX_EXECUTE: "yes",
      FOUNDRY_DEX_ROLE: "W1",
      FOUNDRY_DEX_NETWORK: "xrpl:1",
      FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W1.address,
      FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
      FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
      FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
      FOUNDRY_DEX_AXELAR_DROPS: "0",
    };
    const signedBefore = state.signs;
    const decision = await decide(env, { now: NOW, ledger: exitLedger, journal, policy: { rebalance: "exit-sole-lp" } }, clients(state));
    assert.equal(decision.decision, "withdraw");
    assert.equal(decision.signed, true);
    assert.equal(decision.traded, false);
    assert.equal(decision.learning, false);
    assert.equal(decision.lp_xrp_drops, "51783000");
    assert.equal(state.signs, signedBefore + 1);
    const replay = await decide(env, { now: NOW, ledger: exitLedger, journal, policy: { rebalance: "exit-sole-lp" } }, clients(state));
    assert.equal(replay.replay, true);
    assert.equal(state.signs, signedBefore + 1);
    const inventoried = bankroll.room(view(exitLedger, NOW), {
      proved: true,
      reserveInc: 200000n,
      ownerCount: 0n,
      reserveBase: 1000000n,
      balance: 200000000n,
      offers: [],
      pool: { xrp: 51783000n, balance: 100n, supply: 100n, sole: true },
    });
    assert.equal(inventoried.lp_xrp.toString(), "51783000");
    assert.equal(inventoried.used < 51783000n * 2n, true);
  });

  it("sizes one passive quote from a foreign offer inside the remaining bankroll", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "bank-journal-"));
    const state = fresh();
    state.book = [{ Account: xrpl.Wallet.generate().address, TakerGets: "5000000", TakerPays: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "20" } }];
    const env = {
      FOUNDRY_W1_DEX_LIVE: "yes",
      FOUNDRY_W1_DEX_WS: "wss://testnet.xrpl-labs.com",
      FOUNDRY_W1_DEX_ACCOUNT_FILE: "/tmp/w1.json",
      FOUNDRY_DEX_EXECUTE: "yes",
      FOUNDRY_DEX_ROLE: "W1",
      FOUNDRY_DEX_NETWORK: "xrpl:1",
      FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W1.address,
      FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
      FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
      FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
      FOUNDRY_DEX_AXELAR_DROPS: "0",
    };
    const placed = await decide(env, { now: NOW, ledger, journal }, clients(state));
    assert.equal(placed.decision, "place");
    assert.equal(placed.signed, true);
    assert.equal(placed.traded, false);
    assert.equal(placed.market, "foreign");
    const mission = Object.values(view(ledger, NOW).missions).find((row) => row.kind === "w1-dex-offer");
    assert.equal(BigInt(mission.locked_drops) <= 5000000n, true);
    assert.equal(BigInt(mission.locked_drops) < 100000000n, true);
    assert.equal(mission.unsigned_tx.Flags, bounds.TF_PASSIVE);
    const again = await decide(env, { now: NOW, ledger, journal }, clients(state));
    assert.equal(again.decision, "reconcile");
    assert.equal(state.signs, 1);
  });
});
