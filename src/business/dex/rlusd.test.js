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
const { tick: supervise } = require("./supervisor");
const market = require("./market");
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
      state.types = state.types || [];
      state.types.push(tx.TransactionType);
      state.lastTx = tx;
      const tx_blob = xrpl.encode(Object.assign({}, tx, { SigningPubKey: `ED${"AA".repeat(32)}`, TxnSignature: "00".repeat(64) }));
      state.lastHash = xrpl.hashes.hashSignedTx(tx_blob);
      if (tx.TransactionType === "OfferCreate") {
        state.resting = { seq: tx.Sequence, gets: tx.TakerGets, pays: tx.TakerPays };
        state.sequence = tx.Sequence + 1;
      } else {
        state.sequence = tx.Sequence + 1;
      }
      return { tx_blob };
    },
    submit: async () => {
      state.submits += 1;
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") return w1("server_info.json");
        if (req.command === "account_info") {
          const info = w1("account_info.json");
          if (!state.sequence) return info;
          const copy = JSON.parse(JSON.stringify(info));
          copy.result.account_data.Sequence = state.sequence;
          return copy;
        }
        if (req.command === "account_offers") {
          const page = w1("account_offers.json");
          if (!state.resting || state.hideRest) return page;
          const copy = JSON.parse(JSON.stringify(page));
          copy.result.offers.push({
            seq: state.resting.seq,
            Sequence: state.resting.seq,
            taker_gets: state.resting.gets,
            TakerGets: state.resting.gets,
            taker_pays: state.resting.pays,
            TakerPays: state.resting.pays,
          });
          return copy;
        }
        if (req.command === "account_lines") {
          const lines = w1("account_lines.json");
          if (!state.trusted) return lines;
          const copy = JSON.parse(JSON.stringify(lines));
          copy.result.lines.push({ account: rlusd.ISSUER, balance: "0", currency: rlusd.CURRENCY, limit: "10" });
          return copy;
        }
        if (req.command === "fee") return w1("fee.json");
        if (req.command === "tx") {
          if (!state.echo || !state.lastTx) return { result: { validated: false, error: "txnNotFound" } };
          return proofFor(state.lastTx, state.lastHash, state.echo === "alter");
        }
        if (req.command === "amm_info") {
          const issuer = req.asset2 && req.asset2.issuer;
          return issuer === rlusd.ISSUER ? rl("amm.json") : w1("amm_info.json");
        }
        if (req.command === "book_offers") {
          const issuer = (req.taker_pays && req.taker_pays.issuer) || (req.taker_gets && req.taker_gets.issuer);
          if (issuer === rlusd.ISSUER) {
            if (req.taker_gets && req.taker_gets.currency === "XRP") return rl("bids.json");
            if (!state.cross) return rl("asks.json");
            const asks = JSON.parse(JSON.stringify(rl("asks.json")));
            asks.result.offers[0].TakerPays = "1";
            return asks;
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
  it("rejects lookalike issuers and does not trade from W0 or W2", async () => {
    assert.equal(rlusd.isRlusd({ currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "1" }), true);
    assert.equal(rlusd.isRlusd({ currency: "RLUSD", issuer: rlusd.ISSUER, value: "1.5" }), false);
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
    const digits = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "sig-digits.json"), "utf8"));
    for (const row of digits.amounts) {
      const exact = market.exactIou(row.value);
      assert.equal(exact.coeff.toString(), row.coeff);
      assert.equal(exact.exp, row.exp);
    }
    assert.notEqual(market.scaled("0.2900001831580104"), null);
    assert.equal(market.exactIou("1.2345678901234567"), null);
    const seen = await rlusd.load(client({ signs: 0, submits: 0 }).ledger);
    assert.equal(seen.asks.some((ask) => ask.value === "0.2900001831580104"), true);
    const marked = rlusd.markInventory(amm, [
      { account: anchors.WALLETS.W2.address, xrp: 50000000n, exact: market.exactIou("1") },
      { account: "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv", xrp: 3800000n, exact: market.exactIou("0.3003038826") },
    ], market.exactIou("1"));
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
    await assert.rejects(() => signer.sign({
      TransactionType: "Payment",
      Account: anchors.WALLETS.W1.address,
      Destination: anchors.WALLETS.W1.address,
      Flags: 0x00020000,
      Amount: { currency: "RLUSD", issuer: rlusd.ISSUER, value: "1" },
      DeliverMin: { currency: "RLUSD", issuer: rlusd.ISSUER, value: "1" },
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

  it("signs at most the 2 XRP open cap across ticks after a proved rest", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-cap-"));
    const state = { signs: 0, submits: 0, lastTx: null, trusted: true, echo: "prove", types: [] };
    let peak = 0n;
    for (let tick = 0; tick < 6; tick += 1) {
      const before = state.signs;
      const row = await decide(env(), { now: NOW, ledger, journal }, client(state));
      assert.equal(state.signs - before <= 1, true);
      assert.equal(row.learning, false);
      const open = Object.values(view(ledger, NOW).missions).filter((mission) => mission.kind === "w1-rlusd" && mission.hold !== "released").reduce((sum, mission) => sum + BigInt(mission.outstanding_drops || "0"), 0n);
      if (open > peak) peak = open;
      assert.equal(open <= 2000000n, true);
    }
    assert.equal(state.signs, 1);
    assert.deepEqual(state.types, ["OfferCreate"]);
    assert.equal(state.types.some((type) => type === "Payment"), false);
    assert.equal(peak <= 2000000n, true);
    const keys = Object.values(view(ledger, NOW).missions).map((mission) => mission.idempotency_key || "");
    assert.equal(keys.some((key) => key.startsWith("w1-rlusd-buy-")), false);
  });

  it("does not prove a hash echo whose body was altered", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-bind-"));
    const state = { signs: 0, submits: 0, lastTx: null, echo: "alter" };
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    const second = await decide(env(), { now: NOW, ledger, journal }, client(state));
    assert.equal(second.proof_reason, "bind");
    assert.equal(second.status, "rlusd_unknown");
    const third = await decide(env(), { now: NOW, ledger, journal }, client(state));
    assert.equal(third.status, "rlusd_unknown");
    assert.equal(state.signs, 1);
    const proved = Object.values(view(ledger, NOW).missions).filter((mission) => mission.status === "rlusd_proved" || mission.status === "rlusd_resting");
    assert.equal(proved.length, 0);
  });

  it("opens the signer before reserving, and releases an unsigned row", async () => {
    const order = [];
    const state = { signs: 0, submits: 0, lastTx: null };
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-live-"));
    const row = await supervise(env(), {
      now: NOW,
      ledger,
      journal,
      deps: liveDeps(state, order, () => ({
        classicAddress: rlusd.REGULAR_KEY,
        address: rlusd.REGULAR_KEY,
        sign(tx) {
          order.push("sign");
          state.signs += 1;
          state.lastTx = tx;
          return { tx_blob: xrpl.encode(Object.assign({}, tx, { SigningPubKey: `ED${"AA".repeat(32)}`, TxnSignature: "00".repeat(64) })) };
        },
      })),
    });
    assert.equal(row.decision, "trustline");
    assert.equal(order.indexOf("open") < order.indexOf("sign"), true);
    assert.equal(state.signs, 1);
    const refused = home();
    const refusedJournal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-master-"));
    const blocked = await supervise(env(), {
      now: NOW,
      ledger: refused,
      journal: refusedJournal,
      deps: liveDeps({ signs: 0 }, [], () => ({ classicAddress: anchors.WALLETS.W1.address, address: anchors.WALLETS.W1.address, sign() { throw new Error("signed"); } })),
    });
    assert.equal(blocked.rlusd_error, "MASTER_KEY");
    assert.equal(Object.values(view(refused, NOW).missions).some((mission) => mission.kind === "w1-rlusd"), false);
    const broken = home();
    const brokenJournal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-unsent-"));
    const failed = await supervise(env(), {
      now: NOW,
      ledger: broken,
      journal: brokenJournal,
      deps: liveDeps({ signs: 0 }, [], () => ({
        classicAddress: rlusd.REGULAR_KEY,
        address: rlusd.REGULAR_KEY,
        sign() { throw Object.assign(new Error("down"), { code: "SIGNER" }); },
      })),
    });
    assert.equal(failed.rlusd_error, "SIGNER");
    const stuck = Object.values(view(broken, NOW).missions).filter((mission) => mission.kind === "w1-rlusd");
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].hold, "released");
    assert.equal(stuck[0].outstanding_drops, "0");
    assert.equal(stuck[0].submit_attempted, false);
  });

  it("cancels a crossing rest and replaces it once inside the cap", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-replace-"));
    const state = { signs: 0, submits: 0, lastTx: null, trusted: true, echo: "prove", types: [] };
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    state.cross = true;
    const cancel = await decide(env(), { now: NOW, ledger, journal }, client(state));
    assert.equal(cancel.decision, "cancel");
    state.hideRest = true;
    for (let tick = 0; tick < 4; tick += 1) {
      await decide(env(), { now: NOW, ledger, journal }, client(state));
    }
    assert.equal(state.types.filter((type) => type === "Payment").length, 0);
    assert.equal(state.types.filter((type) => type === "OfferCancel").length, 1);
    assert.equal(state.types.filter((type) => type === "OfferCreate").length, 2);
    const open = Object.values(view(ledger, NOW).missions).filter((mission) => mission.kind === "w1-rlusd" && mission.hold !== "released").reduce((sum, mission) => sum + BigInt(mission.outstanding_drops || "0"), 0n);
    assert.equal(open <= 2000000n, true);
  });
});

function proofFor(tx, hash, alter) {
  const body = JSON.parse(JSON.stringify(tx));
  if (alter) {
    if (body.LimitAmount) body.LimitAmount = Object.assign({}, body.LimitAmount, { value: "11" });
    if (body.TakerPays && typeof body.TakerPays === "object") body.TakerPays = Object.assign({}, body.TakerPays, { value: "999" });
    if (body.SendMax) body.SendMax = "1";
  }
  const meta = { TransactionResult: "tesSUCCESS", AffectedNodes: [] };
  if (body.TransactionType === "OfferCreate") {
    meta.AffectedNodes.push({ CreatedNode: { LedgerEntryType: "Offer", NewFields: { Account: body.Account, Sequence: body.Sequence, TakerGets: body.TakerGets, TakerPays: body.TakerPays } } });
  } else if (body.TransactionType === "TrustSet") {
    meta.AffectedNodes.push({ CreatedNode: { LedgerEntryType: "RippleState", NewFields: { HighLimit: { currency: body.LimitAmount.currency, issuer: body.LimitAmount.issuer, value: body.LimitAmount.value } } } });
  } else if (body.TransactionType === "OfferCancel") {
    meta.AffectedNodes.push({ DeletedNode: { LedgerEntryType: "Offer", FinalFields: { Sequence: body.OfferSequence } } });
  } else {
    meta.delivered_amount = body.Amount;
    meta.AffectedNodes.push({ ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: body.Account } } });
  }
  return { result: { validated: true, hash, meta, tx_json: body } };
}

function liveDeps(state, order, openWallet) {
  return {
    connect: async () => ({
      request: client(state).ledger.request,
      disconnect: async () => {},
    }),
    readAccount: async () => {
      order.push("read");
      return { account: anchors.WALLETS.W1.address, regular_key: rlusd.REGULAR_KEY, seed: "fixture-not-a-seed" };
    },
    openWallet: () => {
      order.push("open");
      return openWallet();
    },
  };
}

function readPool() {
  const body = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "amm.json"), "utf8")).result.amm;
  return {
    xrp: BigInt(body.amount),
    exact: market.exactIou(body.amount2.value),
    tradingFee: body.trading_fee,
  };
}
