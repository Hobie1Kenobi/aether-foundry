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
const market = require("./dex/market");
const { deposit, withdraw, reconcile } = require("./dex/amm");
const { depositOutcome, withdrawOutcome } = require("./dex/amm-proof");
const engine = require("./dex/engine");
const { decide } = require("./dex/director");
const { liveExpected, health } = require("./dex/live");
const signer = require("./dex/signer");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-08T18:00:00.000Z";
const LATER = "2026-11-10T18:00:00.000Z";
const LP = "0158534100000000000000000000000000000000";
const W1 = anchors.WALLETS.W1.address;
const W0 = anchors.WALLETS.W0.address;
const AETH = { currency: anchors.AETH_HEX, issuer: W0, value: "1" };

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
    JSON.stringify({ type: "mission.upsert", at: NOW, mission: { id: "msn5b5c3223e5e88526", hold: "uncertain", signed: true, updated_at: NOW } }),
    JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747" } }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msn5b5c3223e5e88526", day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msndiag", day: "2026-11-08", drops: "20", settlement: "submit_unknown", live: true }),
  ].join("\n")}\n`);
  return ledger;
}

function env() {
  return {
    FOUNDRY_DEX_EXECUTE: "yes",
    FOUNDRY_DEX_ROLE: "W1",
    FOUNDRY_DEX_NETWORK: "xrpl:1",
    FOUNDRY_DEX_ACCOUNT: W1,
    FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
    FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
    FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
    FOUNDRY_DEX_AXELAR_DROPS: "0",
    FOUNDRY_W1_DEX_LIVE: "yes",
    FOUNDRY_W1_DEX_WS: "wss://testnet.xrpl-labs.com",
    FOUNDRY_W1_DEX_ACCOUNT_FILE: "/tmp/w1.json",
  };
}

function observed(extra) {
  return Object.assign({
    proved: true,
    reserveBase: 1000000n,
    reserveInc: 200000n,
    ownerCount: 8n,
    balance: 49022152n,
    offers: [{ seq: 4, locked: 2275000n }],
    bids: [],
    walletAeth: 0n,
    aethFrozen: false,
    pool: {
      xrp: 51783000n,
      aethScaled: 4923540000000000000n,
      balance: 100n,
      supply: 100n,
      sole: true,
    },
  }, extra || {});
}

function clients(state) {
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
        if (req.command === "server_info") return { result: { info: { network_id: state.networkId || 1, validated_ledger: { seq: state.seq, reserve_base_xrp: state.reserveBase, reserve_inc_xrp: state.reserveInc } } } };
        if (req.command === "account_info") return { result: { validated: true, account_data: { Account: W1, Sequence: state.sequence, Balance: state.balance, OwnerCount: state.ownerCount } } };
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: state.fee } } };
        if (req.command === "amm_info") return { result: { validated: state.ammValidated !== false, ledger_index: state.seq, amm: state.amm } };
        if (req.command === "account_lines") return { result: { validated: true, account: W1, marker: state.lineMarker || null, lines: state.lines } };
        if (req.command === "account_offers") return { result: { validated: true, account: W1, marker: null, offers: state.offers } };
        if (req.command === "book_offers") return { result: { validated: true, marker: null, offers: state.book } };
        if (req.command === "tx") return state.lookup ? state.lookup(req) : { result: { validated: false } };
        throw new Error(req.command);
      },
    },
  };
}

function fresh(extra) {
  return Object.assign({
    seq: 10000,
    sequence: 20,
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
      amount2: { currency: anchors.AETH_HEX, issuer: W0, value: "100" },
      lp_token: { currency: LP, issuer: anchors.AMM, value: "100" },
      trading_fee: 500,
    },
  }, extra || {});
}

function ripple(balance, currency, low, high) {
  return {
    Balance: balance,
    LowLimit: { currency, issuer: low, value: "0" },
    HighLimit: { currency, issuer: high, value: "0" },
  };
}

describe("bankroll audit", () => {
  it("prices AETH from an outside bid and refuses the pool's own price", () => {
    const bare = bankroll.room(null, observed());
    assert.equal(bare.aeth_valuation, "unproved");
    assert.equal(bare.aeth_xrp.toString(), "0");
    assert.equal(bare.risk_increasing, false);
    assert.equal(bare.remaining.toString(), "0");
    assert.equal(bare.base_reserve.toString(), "1000000");
    assert.equal(bare.proved_xrp.toString(), (51783000n + 2275000n + 1000000n + 1600000n).toString());
    const bid = bankroll.room(null, observed({
      bids: [{ account: "rForeignBid1111111111111111111111", xrp: 1000n, aeth: 4923540000000000000n }],
    }));
    assert.equal(bid.aeth_valuation, "unproved");
    assert.equal(bid.aeth_xrp.toString(), "0");
    assert.equal(bid.remaining.toString(), "0");
    const dust = bankroll.room(null, observed({
      bids: [{ account: "rForeignBid1111111111111111111111", xrp: 1n, aeth: 4923540000000000000n }],
    }));
    assert.equal(dust.aeth_valuation, "unproved");
    assert.equal(dust.risk_increasing, false);
    const partial = bankroll.room(null, observed({
      bids: [{ account: "rForeignBid1111111111111111111111", xrp: 1000n, aeth: 1n }],
    }));
    assert.equal(partial.aeth_valuation, "unproved");
    assert.equal(partial.remaining.toString(), "0");
    const frozen = bankroll.room(null, observed({ walletAeth: 1n, aethFrozen: true, pool: { xrp: 1000n, aethScaled: 1n, balance: 0n, supply: 100n, sole: false }, offers: [] }));
    assert.equal(frozen.aeth_valuation, "unproved");
    assert.equal(frozen.risk_increasing, false);
  });

  it("rejects a non-native pool, a long decimal, a frozen line, and an unbounded quote", () => {
    const amm = {
      account: anchors.AMM,
      amount: "1000",
      amount2: { currency: anchors.AETH_HEX, issuer: W0, value: "1.0000001" },
      lp_token: { currency: LP, issuer: anchors.AMM, value: "1" },
      trading_fee: 500,
    };
    const lines = { result: { validated: true, account: W1, marker: null, lines: [] } };
    assert.throws(() => market.parsePool({ result: { validated: true, amm } }, lines), (error) => error.code === "VALUATION");
    amm.amount2 = { currency: "USD", issuer: W0, value: "1" };
    assert.throws(() => market.parsePool({ result: { validated: true, amm } }, lines), (error) => error.code === "VALUATION");
    amm.amount2 = { currency: anchors.AETH_HEX, issuer: W0, value: "1" };
    const tooMuch = { result: { validated: true, account: W1, marker: null, lines: [{ account: anchors.AMM, currency: LP, balance: "2" }] } };
    assert.throws(() => market.parsePool({ result: { validated: true, amm } }, tooMuch), (error) => error.code === "VALUATION");
    const frozenLines = { result: { validated: true, account: W1, marker: null, lines: [{ account: W0, currency: anchors.AETH_HEX, balance: "5", freeze: true }] } };
    const parsed = market.parsePool({ result: { validated: true, amm, ledger_index: 10 } }, frozenLines);
    assert.equal(parsed.wallet.aethFrozen, true);
    const book = market.parseBook({ result: { validated: true, marker: null, offers: [
      { Account: W1, TakerGets: "10", TakerPays: AETH },
      { Account: W0, TakerGets: "10", TakerPays: AETH },
      { Account: anchors.AMM, TakerGets: "10", TakerPays: AETH },
      { Account: "rForeignBid1111111111111111111111", TakerGets: "100000000000", TakerPays: AETH },
      { Account: "rForeignBid1111111111111111111111", TakerGets: "5000000", TakerPays: AETH },
    ] } });
    assert.equal(book.unbounded, 1);
    assert.equal(book.bids.length, 1);
    assert.equal(book.bids[0].xrp.toString(), "5000000");
    assert.throws(() => market.parseBook({ result: { validated: true, marker: null, offers: [{ TakerGets: "10", TakerPays: AETH }] } }), (error) => error.code === "UNCERTAIN");
  });

  it("keeps payment caps, the legacy hold, and the bankroll apart across a restart and the next day", async () => {
    const ledger = home();
    const state = fresh();
    const opened = await engine.place(ledger, { now: NOW, idempotency_key: "w1-audit-pay", taker_gets: "1000", taker_pays: AETH }, clients(state));
    assert.equal(opened.signed, true);
    const day = policy.dayUsed(view(ledger, NOW), policy.chicagoDay(NOW)).toString();
    const later = policy.dayUsed(view(ledger, LATER), policy.chicagoDay(LATER)).toString();
    assert.equal(day, "1767");
    assert.equal(later, "1767");
    const shape = {
      proved: true,
      reserveBase: 1000000n,
      reserveInc: 200000n,
      ownerCount: 0n,
      balance: 200000000n,
      offers: [],
      bids: [],
      walletAeth: 0n,
      pool: { xrp: 1000000n, aethScaled: 1n, balance: 0n, supply: 100n, sole: false },
    };
    const first = bankroll.room(view(ledger, NOW), shape);
    const restarted = bankroll.room(view(ledger, LATER), shape);
    assert.equal(restarted.pending.toString(), first.pending.toString());
    assert.equal(restarted.limit.toString(), "100000000");
    assert.equal(first.base_reserve.toString(), "1000000");
    const raced = await Promise.allSettled([
      engine.place(ledger, { now: NOW, idempotency_key: "w1-audit-a", taker_gets: "40000000", taker_pays: AETH }, clients(Object.assign({}, state, { sequence: 21 }))),
      engine.place(ledger, { now: NOW, idempotency_key: "w1-audit-b", taker_gets: "45000000", taker_pays: AETH }, clients(Object.assign({}, state, { sequence: 21 }))),
    ]);
    assert.equal(Object.values(view(ledger, NOW).missions).filter((row) => row.kind === "w1-dex-offer").length, 2);
    assert.equal(raced.filter((row) => row.status === "rejected").length, 1);
  });

  it("proves a deposit and a withdraw from metadata and does not free unproved XRP", async () => {
    const ledger = home();
    const buyer = "rForeignBid1111111111111111111111";
    const state = fresh({
      book: [{ Account: buyer, TakerGets: "1000000", TakerPays: { currency: anchors.AETH_HEX, issuer: W0, value: "100" } }],
    });
    await assert.rejects(() => deposit(ledger, { now: NOW, idempotency_key: "w1-audit-dep", xrp_drops: "1000000", aeth: AETH }, clients(state)), (error) => error.code === "UNSUPPORTED");
    assert.equal(state.signs, 0);
    const crafted = {
      signed_hash: "AB".repeat(32),
      sequence: 20,
      last_ledger_sequence: 10020,
      fee_drops: "10",
      locked_drops: "1000000",
      lp_currency: LP,
      unsigned_tx: { TransactionType: "AMMDeposit", Amount: "1000000", Amount2: { currency: anchors.AETH_HEX, issuer: W0, value: "1" }, Fee: "10", Flags: 0x00100000, Sequence: 20, LastLedgerSequence: 10020 },
    };
    assert.throws(() => depositOutcome({ result: { validated: true, hash: "CD".repeat(32), ledger_index: 10, tx_json: crafted.unsigned_tx, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [{ ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: W1, Balance: "1" }, PreviousFields: { Balance: "2" } } }] } } }, crafted), (error) => error.code === "PROOF" || error.code === "UNCERTAIN");
    const exitState = fresh({
      lines: [{ account: anchors.AMM, currency: LP, balance: "100" }],
      amm: {
        account: anchors.AMM,
        amount: "51783000",
        amount2: { currency: anchors.AETH_HEX, issuer: W0, value: "100" },
        lp_token: { currency: LP, issuer: anchors.AMM, value: "100" },
        trading_fee: 500,
      },
    });
    const exitLedger = home();
    const exited = await withdraw(exitLedger, { now: NOW }, clients(exitState));
    assert.equal(exited.tx.TransactionType, "AMMWithdraw");
    const exitMission = view(exitLedger, NOW).missions[exited.id];
    exitState.lookup = () => ({ result: { validated: true, hash: exitMission.signed_hash, ledger_index: 11, tx_json: exitMission.unsigned_tx, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [] } } });
    const held = await reconcile(exitLedger, { now: NOW, mission_id: exited.id }, clients(exitState));
    assert.equal(held.status, "amm_unknown");
    assert.equal(held.recovered_drops, undefined);
    exitState.lookup = () => ({
      result: {
        validated: true,
        hash: exitMission.signed_hash,
        ledger_index: 12,
        tx_json: exitMission.unsigned_tx,
        meta: {
          TransactionResult: "tesSUCCESS",
          AffectedNodes: [
            { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: W1, Balance: "251782990" }, PreviousFields: { Balance: "200000000" } } },
            { ModifiedNode: { LedgerEntryType: "RippleState", FinalFields: ripple("100", anchors.AETH_HEX, W1, W0), PreviousFields: ripple("0", anchors.AETH_HEX, W1, W0) } },
            { DeletedNode: { LedgerEntryType: "RippleState", FinalFields: ripple("100", LP, W1, anchors.AMM) } },
            { ModifiedNode: { LedgerEntryType: "AMM", FinalFields: { Amount: "1000" }, PreviousFields: { Amount: "51784000" } } },
          ],
        },
      },
    });
    const stillThere = await reconcile(exitLedger, { now: NOW, mission_id: exited.id }, clients(exitState));
    assert.equal(view(exitLedger, NOW).missions[exited.id].proof_reason, "pool_not_reduced");
    assert.equal(view(exitLedger, NOW).missions[exited.id].recovered_drops, undefined);
    exitState.lines = [];
    exitState.amm = Object.assign({}, exitState.amm, { amount: "1000" });
    const returned = await reconcile(exitLedger, { now: NOW, mission_id: exited.id }, clients(exitState));
    assert.equal(returned.status, "amm_proved");
    assert.equal(BigInt(returned.recovered_drops) > 0n, true);
    const after = bankroll.room(view(exitLedger, NOW), {
      proved: true,
      reserveBase: 1000000n,
      reserveInc: 200000n,
      ownerCount: 0n,
      balance: 251782990n,
      offers: [],
      bids: [],
      walletAeth: 100000000n,
      pool: { xrp: 1000n, aethScaled: 1n, balance: 0n, supply: 100n, sole: false },
    });
    assert.equal(after.lp_xrp.toString(), "0");
    assert.equal(after.aeth_valuation, "unproved");
    assert.equal(after.risk_increasing, false);
  });

  it("does not sign research and does not follow an unbounded or self quote", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "audit-journal-"));
    const state = fresh({
      lines: [{ account: anchors.AMM, currency: LP, balance: "100" }],
      amm: {
        account: anchors.AMM,
        amount: "51783000",
        amount2: { currency: anchors.AETH_HEX, issuer: W0, value: "100" },
        lp_token: { currency: LP, issuer: anchors.AMM, value: "100" },
        trading_fee: 500,
      },
      book: [{ Account: "rForeignBid1111111111111111111111", TakerGets: "100000000000", TakerPays: AETH }],
    });
    const quiet = await decide(env(), { now: NOW, ledger, journal }, clients(state));
    assert.equal(quiet.decision, "research");
    assert.equal(quiet.aeth_valuation, "unproved");
    assert.equal(quiet.risk_increasing, false);
    assert.equal(state.signs, 0);
    assert.equal(quiet.recommendation, undefined);
  });

  it("does not let a house bid or a pool decline create headroom", async () => {
    const house = market.parseBook({ result: { validated: true, marker: null, offers: [
      { Account: anchors.WALLETS.W2.address, TakerGets: "60000000", TakerPays: { currency: anchors.AETH_HEX, issuer: W0, value: "4923.54" } },
    ] } });
    assert.equal(house.bids.length, 0);
    const ledger = home();
    bankroll.commitMark(ledger, 51783000n, NOW);
    const fallen = bankroll.room(view(ledger, NOW), {
      proved: true,
      reserveBase: 1000000n,
      reserveInc: 200000n,
      ownerCount: 0n,
      balance: 100000000n,
      offers: [],
      bids: [],
      walletAeth: 0n,
      pool: { xrp: 10000000n, aethScaled: 1n, balance: 0n, supply: 100n, sole: false },
    });
    assert.equal(fallen.lp_xrp.toString(), "51783000");
    assert.equal(fallen.remaining < 50000000n, true);
    const marked = view(ledger, NOW).missions["bankroll-lp-high-water"].lp_high_water_drops;
    bankroll.recover(ledger, 1000000n, 0n, NOW);
    const after = view(ledger, NOW).missions["bankroll-lp-high-water"].lp_high_water_drops;
    assert.equal(BigInt(after), BigInt(marked) - 1000000n);
    const tx = {
      TransactionType: "AMMWithdraw",
      Account: W1,
      Flags: 0x00010000,
      Fee: "10",
      Sequence: 3,
      LastLedgerSequence: 40,
      LPTokenIn: { currency: LP, issuer: anchors.AMM, value: "1.123456789012345" },
      Asset: { currency: "XRP" },
      Asset2: { currency: anchors.AETH_HEX, issuer: W0 },
    };
    const expected = liveExpected(tx);
    assert.equal(expected.flags, 0x00010000);
    assert.equal(expected.lp.value, "1.123456789012345");
    await signer.sign(tx, expected, async () => ({ tx_blob: xrpl.encode(Object.assign({}, tx, { SigningPubKey: `ED${"AA".repeat(32)}`, TxnSignature: "00".repeat(64) })) }));
    assert.equal(health({}).max_locked_enforced, false);
    assert.equal(health({}).bankroll_drops, "100000000");
  });
});
