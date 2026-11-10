"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../../director/anchors");
const missionConfig = require("../../missions/config");
const { chicagoDay } = require("../../missions/clock");
const { control, view } = require("../../missions/engine");
const bounds = require("./bounds");
const { decide } = require("./director");
const { tick: supervise, main, nextWait } = require("./supervisor");
const { CONNECTION_TIMEOUT_MS, connectLive, websocketList } = require("./live");
const { readJournal } = require("./director");
const market = require("./market");
const rlusd = require("./rlusd");
const signer = require("./signer");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-09T04:00:00.000Z";
const TODAY = "2026-11-10T18:00:00.000Z";
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
        if (req.command === "server_info") {
          if (!state.completeLedgers && !state.validatedSeq) return w1("server_info.json");
          const info = JSON.parse(JSON.stringify(w1("server_info.json")));
          if (state.completeLedgers) info.result.info.complete_ledgers = state.completeLedgers;
          if (state.validatedSeq) info.result.info.validated_ledger.seq = state.validatedSeq;
          return info;
        }
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
          if (!state.trusted && !state.fillBalance) return lines;
          const copy = JSON.parse(JSON.stringify(lines));
          copy.result.lines.push({ account: rlusd.ISSUER, balance: state.fillBalance || "0", currency: rlusd.CURRENCY, limit: "10" });
          return copy;
        }
        if (req.command === "account_tx") {
          if (state.historyThrows) throw Object.assign(new Error("account_tx failed"), { name: "NotConnectedError" });
          return state.history || { result: { validated: true, account: anchors.WALLETS.W1.address, marker: null, transactions: [] } };
        }
        if (req.command === "fee") return w1("fee.json");
        if (req.command === "tx") {
          if (state.txError) return { result: { error: state.txError } };
          if (state.notFound) return { result: { validated: false, error: "txnNotFound" } };
          if (state.trustProof && req.transaction === state.trustHash) return state.trustProof;
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
            if (req.taker_gets && req.taker_gets.currency === "XRP") {
              if (state.noBids) return { result: { validated: true, ledger_index: 1, marker: null, offers: [] } };
              return rl("bids.json");
            }
            if (state.noAsks) return { result: { validated: true, ledger_index: 1, marker: null, offers: [] } };
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

  it("proves the live filled bid and does not keep the exposure open", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    assert.equal(shape.ledger_index, 22223170);
    assert.equal(shape.sequence, 21093748);
    assert.equal(shape.taker_pays_value, "0.07778336573477218");
    assert.equal(shape.balance, shape.taker_pays_value);
    const outside = "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv";
    const filled = await runFill({ taker: outside, history: true });
    assert.equal(filled.row.rationale.includes("no proved cancel"), false);
    assert.equal(filled.row.proof_type, "consuming_tx");
    assert.equal(filled.row.outside_fill, true);
    assert.equal(filled.row.fill_class, "filled");
    assert.equal(filled.row.fill_rlusd, shape.taker_pays_value);
    assert.equal(filled.row.fill_xrp_drops, "1000000");
    assert.equal(filled.row.counterparty, outside);
    assert.equal(filled.row.signed, false);
    assert.equal(filled.row.learning, false);
    assert.equal(BigInt(filled.row.inventory_drops) > 0n, true);
    assert.equal(BigInt(filled.row.inventory_drops) < 1000000n, true);
    const text = fs.readFileSync(path.join(filled.journal, "decisions.jsonl"), "utf8");
    assert.equal(text.includes(outside), true);
    assert.equal(text.includes(shape.taker_pays_value), true);
    const house = await runFill({ taker: anchors.WALLETS.W2.address, history: true });
    assert.equal(house.row.outside_fill, false);
    assert.equal(house.row.fill_class, "self");
    assert.equal(house.row.realized_pnl_drops, "0");
    assert.equal(house.row.counterparty, null);
    const amm = await runFill({ taker: anchors.AMM, history: true });
    assert.equal(amm.row.outside_fill, false);
    const fallback = await runFill({ history: false, trust: true, pruned: true });
    assert.equal(fallback.row.proof_type, "stored_journal");
    assert.equal(fallback.row.counterparty, null);
    assert.equal(fallback.row.outside_fill, false);
    assert.equal(fallback.row.fill_rlusd, shape.taker_pays_value);
    assert.equal(fallback.row.rationale.includes("stored placement proof"), true);
    assert.equal(fallback.state.signs <= 1, true);
    const open = Object.values(view(fallback.ledger, NOW).missions).filter((mission) => mission.kind === "w1-rlusd" && mission.hold !== "released").reduce((sum, mission) => sum + BigInt(mission.outstanding_drops || "0"), 0n);
    assert.equal(open <= 2000000n, true);
    assert.equal((fallback.state.types || []).filter((type) => type === "OfferCreate").length <= 1, true);
    assert.equal(shape.trustset_sequence, 21093747);
    assert.equal(shape.baseline, "0");
    assert.equal(shape.trustset_hash, "DD19FBD953682B294EAFC82FD4C6A711AB204C9D7DA96F0E4436F99A8E9D616B");
    assert.equal(shape.create_hash, "FA581AAA64A5494406D144E859D8C58BFF15D9B93B797B341D87E564E8ED5C29");
    const inside = await runFill({ history: false, trust: true, pruned: true, completeLedgers: "22220000-22225000" });
    assert.equal(inside.row.decision, "research");
    assert.equal(inside.row.proof_type, undefined);
    const insideMission = Object.values(view(inside.ledger, NOW).missions).find((mission) => mission.sequence === shape.sequence);
    assert.equal(insideMission.status, "rlusd_resting");
    assert.equal(insideMission.outstanding_drops, "1200010");
    const bare = await runFill({ history: false, pruned: true, bare: true });
    assert.equal(bare.row.decision, "research");
    assert.equal(bare.row.proof_type, undefined);
    const bareMission = Object.values(view(bare.ledger, NOW).missions).find((mission) => mission.sequence === shape.sequence);
    assert.equal(bareMission.status, "rlusd_resting");
    assert.equal(bareMission.outstanding_drops, "1200010");
    assert.equal(bareMission.proof_result, undefined);
    assert.equal(bareMission.validated_ledger, undefined);
  });

  it("treats only ledgers older than every complete_ledgers start as pruned", () => {
    const gap = [[22220000, 22221000], [22224000, 22225000]];
    assert.equal(rlusd.historyDropped(gap, 22223170), false);
    assert.equal(rlusd.historyDropped(gap, 22219000), true);
    assert.equal(rlusd.historyDropped([[22224000, 22225000]], 22223170), true);
  });

  it("releases a legacy vanished offer from the validated book without calling it a fill", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    assert.equal(shape.labs_window, "22222753-22224013");
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-vanished-"));
    const tx = seedFill(ledger, shape, shape.create_hash, { legacy: true });
    const state = {
      signs: 0,
      submits: 0,
      types: [],
      fillBalance: shape.balance,
      history: { result: { validated: true, marker: null, transactions: [] } },
      notFound: true,
      completeLedgers: shape.labs_window,
      echo: "prove",
      lastTx: tx,
      lastHash: shape.create_hash,
    };
    for (const seq of [22223900, 22223900, 22223901]) {
      state.validatedSeq = seq;
      const row = await decide(env(), { now: NOW, ledger, journal }, client(state));
      assert.equal(state.signs, 0);
      assert.equal(row.proof_type, undefined);
    }
    let open = Object.values(view(ledger, NOW).missions).find((mission) => mission.sequence === shape.sequence);
    assert.equal(open.status, "rlusd_resting");
    assert.equal(open.outstanding_drops, "1200010");
    state.validatedSeq = 22223902;
    const closed = await decide(env(), { now: NOW, ledger, journal }, client(state));
    assert.equal(state.signs, 0);
    assert.equal(closed.status, "rlusd_vanished_unattributed");
    assert.equal(closed.proof_type, "state_only");
    assert.equal(closed.outside_fill, false);
    assert.equal(closed.counterparty, null);
    assert.equal(closed.traded, false);
    assert.equal(closed.realized_pnl_drops, "0");
    assert.equal(closed.fill_rlusd, shape.balance);
    open = Object.values(view(ledger, NOW).missions).find((mission) => mission.sequence === shape.sequence);
    assert.equal(open.idempotency_key, "w1-rlusd-rest");
    assert.equal(open.outstanding_drops, closed.inventory_drops);
    assert.equal(BigInt(open.outstanding_drops) < 1200010n, true);
    assert.equal(BigInt(open.outstanding_drops) <= 2000000n, true);
    state.validatedSeq = 22223903;
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    const exposure = Object.values(view(ledger, NOW).missions).filter((mission) => mission.kind === "w1-rlusd" && mission.hold !== "released").reduce((sum, mission) => sum + BigInt(mission.outstanding_drops || "0"), 0n);
    assert.equal(state.signs <= 1, true);
    assert.equal(exposure <= 2000000n, true);
  });

  it("resets absence when the offer is back on the book", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-back-"));
    const tx = seedFill(ledger, shape, shape.create_hash, { legacy: true });
    const state = {
      signs: 0,
      submits: 0,
      types: [],
      fillBalance: shape.balance,
      history: { result: { validated: true, marker: null, transactions: [] } },
      notFound: true,
      completeLedgers: shape.labs_window,
      lastTx: tx,
      lastHash: shape.create_hash,
    };
    for (const seq of [22223900, 22223901]) {
      state.validatedSeq = seq;
      state.resting = null;
      await decide(env(), { now: NOW, ledger, journal }, client(state));
    }
    state.validatedSeq = 22223902;
    state.resting = { seq: shape.sequence, gets: shape.taker_gets_drops, pays: { currency: shape.currency, issuer: shape.issuer, value: shape.taker_pays_value } };
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    let mission = Object.values(view(ledger, NOW).missions).find((row) => row.sequence === shape.sequence);
    assert.deepEqual(mission.absence_ledgers, []);
    state.validatedSeq = 22223903;
    state.resting = null;
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    mission = Object.values(view(ledger, NOW).missions).find((row) => row.sequence === shape.sequence);
    assert.equal(mission.status, "rlusd_resting");
    assert.equal(mission.outstanding_drops, "1200010");
    assert.equal(state.signs, 0);
  });

  it("does not count an absence when the tx lookup is not txnNotFound", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-internal-"));
    const tx = seedFill(ledger, shape, shape.create_hash, {});
    const state = {
      signs: 0,
      submits: 0,
      types: [],
      fillBalance: shape.balance,
      history: {
        result: {
          validated: true,
          marker: null,
          transactions: [{ hash: "AB".repeat(32), tx_json: { TransactionType: "Payment", Account: "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv" }, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [] } }],
        },
      },
      txError: "internal",
      completeLedgers: shape.complete_ledgers_after_create,
      validatedSeq: 22224100,
      lastTx: tx,
      lastHash: shape.create_hash,
    };
    await decide(env(), { now: NOW, ledger, journal }, client(state));
    const mission = Object.values(view(ledger, NOW).missions).find((row) => row.sequence === shape.sequence);
    assert.equal(mission.absence_ledgers, undefined);
    assert.equal(mission.outstanding_drops, "1200010");
    assert.equal(mission.status, "rlusd_resting");
    assert.equal(state.signs, 0);
  });

  it("does not sell RLUSD when the outside ask is missing", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-noask-"));
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id: "msnnoask21093748",
        idempotency_key: "w1-rlusd-rest",
        kind: "w1-rlusd",
        status: "rlusd_vanished_unattributed",
        proof_type: "state_only",
        role: "W1",
        account: anchors.WALLETS.W1.address,
        hold: "uncertain",
        signed: true,
        submitted: true,
        action: "rest",
        chicago_day: "2026-11-08",
        sequence: shape.sequence,
        submit_attempted: true,
        inventory_rlusd: shape.balance,
        inventory_drops: "885833",
        outstanding_drops: "885833",
        updated_at: NOW,
      },
    })}\n`);
    const state = { signs: 0, submits: 0, types: [], fillBalance: shape.balance, noAsks: true };
    const row = await decide(env(), { now: TODAY, ledger, journal }, client(state));
    assert.equal(row.decision, "research");
    assert.equal(state.signs, 0);
    assert.equal(Object.values(view(ledger, TODAY).missions).some((mission) => mission.action === "sell"), false);
  });

  it("does not sell 0.001 RLUSD when that would raise 1000 drops to the offer reserve", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-dust-"));
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id: "msndust21093748",
        idempotency_key: "w1-rlusd-rest",
        kind: "w1-rlusd",
        status: "rlusd_vanished_unattributed",
        proof_type: "state_only",
        role: "W1",
        account: anchors.WALLETS.W1.address,
        hold: "uncertain",
        signed: true,
        submitted: true,
        action: "rest",
        chicago_day: "2026-11-08",
        sequence: shape.sequence,
        submit_attempted: true,
        inventory_rlusd: "0.001",
        inventory_drops: "1000",
        outstanding_drops: "1000",
        updated_at: NOW,
      },
    })}\n`);
    const state = { signs: 0, submits: 0, types: [], fillBalance: "0.001" };
    const row = await decide(env(), { now: TODAY, ledger, journal }, client(state));
    assert.equal(row.decision, "research");
    assert.equal(state.signs, 0);
    const mission = Object.values(view(ledger, TODAY).missions).find((item) => item.id === "msndust21093748");
    assert.equal(mission.outstanding_drops, "1000");
    assert.equal(Object.values(view(ledger, TODAY).missions).some((item) => item.action === "sell"), false);
  });

  it("does not sell inventory whose mark is below the offer reserve", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-below-reserve-"));
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id: "msnbelow21093748",
        idempotency_key: "w1-rlusd-rest",
        kind: "w1-rlusd",
        status: "rlusd_vanished_unattributed",
        proof_type: "state_only",
        role: "W1",
        account: anchors.WALLETS.W1.address,
        hold: "uncertain",
        signed: true,
        submitted: true,
        action: "rest",
        chicago_day: "2026-11-08",
        sequence: shape.sequence,
        submit_attempted: true,
        inventory_rlusd: "0.01",
        inventory_drops: "150000",
        outstanding_drops: "150000",
        updated_at: NOW,
      },
    })}\n`);
    const state = { signs: 0, submits: 0, types: [], fillBalance: "0.01" };
    const row = await decide(env(), { now: TODAY, ledger, journal }, client(state));
    assert.equal(row.decision, "research");
    assert.equal(state.signs, 0);
    const mission = Object.values(view(ledger, TODAY).missions).find((item) => item.id === "msnbelow21093748");
    assert.equal(mission.outstanding_drops, "150000");
    assert.equal(Object.values(view(ledger, TODAY).missions).some((item) => item.action === "sell"), false);
  });

  it("returns a cancelled or expired RLUSD sell to the line mark and releases its reserve", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ends = [
      ["cancel", "rlusd_cancelled", "C1" + "AB".repeat(31)],
      ["expire", "rlusd_expired", "E1" + "CD".repeat(31)],
    ];
    for (const [kind, status, hash] of ends) {
      const ledger = home();
      const journal = fs.mkdtempSync(path.join(os.tmpdir(), `rlusd-sell-${kind}-`));
      const sequence = 21093800;
      const previous = {
        Account: anchors.WALLETS.W1.address,
        Sequence: sequence,
        TakerGets: { currency: shape.currency, issuer: shape.issuer, value: shape.balance },
        TakerPays: "1000000",
      };
      if (kind === "expire") previous.Expiration = 800000000;
      fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
        type: "mission.upsert",
        at: TODAY,
        mission: {
          id: `msnsellend${sequence}`,
          idempotency_key: "w1-rlusd-sell-2026-11-10",
          kind: "w1-rlusd",
          status: "rlusd_resting",
          action: "sell",
          hold: "uncertain",
          signed: true,
          submitted: true,
          submit_attempted: true,
          role: "W1",
          account: anchors.WALLETS.W1.address,
          chicago_day: "2026-11-10",
          sequence,
          outstanding_drops: "200010",
          cost_basis: "state_only_mark",
          cost_basis_drops: "885833",
          inventory_rlusd: shape.balance,
          inventory_drops: "885833",
          signed_hash: "AB".repeat(32),
          updated_at: TODAY,
          unsigned_tx: {
            TransactionType: "OfferCreate",
            Account: anchors.WALLETS.W1.address,
            Sequence: sequence,
            Fee: "10",
            TakerGets: previous.TakerGets,
            TakerPays: previous.TakerPays,
          },
        },
      })}\n`);
      const tx = kind === "cancel"
        ? { TransactionType: "OfferCancel", Account: anchors.WALLETS.W1.address, OfferSequence: sequence }
        : { TransactionType: "AccountSet", Account: anchors.WALLETS.W1.address };
      const state = {
        signs: 0,
        submits: 0,
        types: [],
        fillBalance: shape.balance,
        history: {
          result: {
            validated: true,
            marker: null,
            transactions: [{
              hash,
              tx_json: tx,
              meta: {
                TransactionResult: "tesSUCCESS",
                AffectedNodes: [{ DeletedNode: { LedgerEntryType: "Offer", FinalFields: previous, PreviousFields: previous } }],
              },
            }],
          },
        },
      };
      const row = await decide(env(), { now: TODAY, ledger, journal }, client(state));
      assert.equal(row.status, status);
      assert.equal(row.outside_fill, false);
      assert.equal(row.realized_pnl_drops, "0");
      assert.equal(state.signs, 0);
      const sell = Object.values(view(ledger, TODAY).missions).find((mission) => mission.action === "sell");
      assert.equal(sell.status, status);
      assert.equal(sell.outstanding_drops, "885833");
      assert.notEqual(sell.outstanding_drops, "200010");
      if (kind === "cancel") {
        const again = await decide(env(), { now: TODAY, ledger, journal }, client(state));
        const exposure = Object.values(view(ledger, TODAY).missions).filter((mission) => mission.kind === "w1-rlusd" && mission.hold !== "released").reduce((sum, mission) => sum + BigInt(mission.outstanding_drops || "0"), 0n);
        assert.notEqual(again.replay, true);
        assert.notEqual(exposure, 0n);
        if (again.signed === true) {
          assert.equal(state.signs, 1);
          assert.equal(exposure, 200010n);
          const next = Object.values(view(ledger, TODAY).missions).find((mission) => mission.action === "sell" && mission.status !== "rlusd_cancelled");
          assert.equal(next.outstanding_drops, "200010");
          assert.equal(next.idempotency_key.startsWith("w1-rlusd-sell-2026-11-10-"), true);
        } else {
          assert.equal(state.signs, 0);
          assert.equal(exposure, 885833n);
        }
      }
    }
  });

  it("keeps the unsold RLUSD mark inside a partial sell's exposure", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-partial-sell-"));
    const sequence = 21093810;
    const previous = {
      Account: anchors.WALLETS.W1.address,
      Sequence: sequence,
      TakerGets: { currency: shape.currency, issuer: shape.issuer, value: "0.1" },
      TakerPays: "1000000",
    };
    const finalFields = {
      Account: anchors.WALLETS.W1.address,
      Sequence: sequence,
      TakerGets: { currency: shape.currency, issuer: shape.issuer, value: shape.balance },
      TakerPays: "400000",
    };
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: TODAY,
      mission: {
        id: "msnsellpartial21093810",
        idempotency_key: "w1-rlusd-sell-2026-11-10",
        kind: "w1-rlusd",
        status: "rlusd_resting",
        action: "sell",
        hold: "uncertain",
        signed: true,
        submitted: true,
        submit_attempted: true,
        role: "W1",
        account: anchors.WALLETS.W1.address,
        chicago_day: "2026-11-10",
        sequence,
        outstanding_drops: "200010",
        cost_basis: "state_only_mark",
        cost_basis_drops: "885833",
        signed_hash: "AB".repeat(32),
        updated_at: TODAY,
        unsigned_tx: {
          TransactionType: "OfferCreate",
          Account: anchors.WALLETS.W1.address,
          Sequence: sequence,
          Fee: "10",
          TakerGets: previous.TakerGets,
          TakerPays: previous.TakerPays,
        },
      },
    })}\n`);
    const state = {
      signs: 0,
      submits: 0,
      types: [],
      fillBalance: shape.balance,
      history: {
        result: {
          validated: true,
          marker: null,
          transactions: [{
            hash: "F1" + "AB".repeat(31),
            tx_json: { TransactionType: "OfferCreate", Account: "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv", Sequence: 22049388 },
            meta: {
              TransactionResult: "tesSUCCESS",
              AffectedNodes: [{ ModifiedNode: { LedgerEntryType: "Offer", PreviousFields: previous, FinalFields: finalFields } }],
            },
          }],
        },
      },
    };
    const row = await decide(env(), { now: TODAY, ledger, journal }, client(state));
    assert.equal(row.status, "rlusd_partial");
    assert.equal(row.remaining_rlusd, shape.balance);
    assert.equal(row.outstanding_drops, (200000n + 885833n).toString());
    assert.notEqual(row.outstanding_drops, "200000");
    const exposure = Object.values(view(ledger, TODAY).missions).filter((mission) => mission.kind === "w1-rlusd" && mission.hold !== "released").reduce((sum, mission) => sum + BigInt(mission.outstanding_drops || "0"), 0n);
    assert.equal(exposure, 200000n + 885833n);
    assert.equal(state.signs, 0);
  });

  it("sells state-only RLUSD inside the live headroom and can buy what remains", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-exit-"));
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id: "msnvanished21093748",
        idempotency_key: "w1-rlusd-rest",
        kind: "w1-rlusd",
        status: "rlusd_vanished_unattributed",
        proof_type: "state_only",
        role: "W1",
        account: anchors.WALLETS.W1.address,
        hold: "uncertain",
        signed: true,
        submitted: true,
        action: "rest",
        chicago_day: "2026-11-08",
        sequence: shape.sequence,
        submit_attempted: true,
        outside_fill: false,
        counterparty: null,
        realized_pnl_drops: "0",
        inventory_rlusd: shape.balance,
        inventory_drops: "885833",
        outstanding_drops: "885833",
        updated_at: NOW,
      },
    })}\n`);
    const state = { signs: 0, submits: 0, types: [], fillBalance: shape.balance, noBids: true };
    const bought = await decide(env(), { now: TODAY, ledger, journal }, client(state));
    assert.equal(bought.decision, "place");
    assert.equal(state.signs, 1);
    const spend = BigInt(state.lastTx.TakerGets);
    assert.equal(spend >= 100000n, true);
    assert.equal(spend < 1000000n, true);
    const order = Object.values(view(ledger, TODAY).missions).find((row) => row.idempotency_key && row.idempotency_key.startsWith("w1-rlusd-rest-"));
    assert.equal(order.outstanding_drops, (spend + 10n + 200000n).toString());
    const exposure = Object.values(view(ledger, TODAY).missions).filter((row) => row.kind === "w1-rlusd" && row.hold !== "released").reduce((sum, row) => sum + BigInt(row.outstanding_drops || "0"), 0n);
    assert.equal(exposure <= 2000000n, true);
    assert.equal(885833n + 1000000n + 10n + 200000n > 2000000n, true);
    assert.equal(chicagoDay(TODAY), "2026-11-10");
    assert.equal(chicagoDay(NOW), "2026-11-08");
    const sellLedger = home();
    const sellJournal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-sell-"));
    for (const prior of ["w1-rlusd-swap-a", "w1-rlusd-swap-b"]) {
      fs.appendFileSync(path.join(sellLedger, "events.jsonl"), `${JSON.stringify({
        type: "mission.upsert",
        at: NOW,
        mission: {
          id: `msn${prior}`,
          idempotency_key: prior,
          kind: "w1-rlusd",
          status: "rlusd_filled",
          action: "swap",
          hold: "released",
          signed: true,
          submitted: true,
          submit_attempted: true,
          chicago_day: "2026-11-08",
          outstanding_drops: "0",
          role: "W1",
          account: anchors.WALLETS.W1.address,
          updated_at: NOW,
        },
      })}\n`);
    }
    fs.appendFileSync(path.join(sellLedger, "events.jsonl"), `${JSON.stringify({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id: "msnsell21093748",
        idempotency_key: "w1-rlusd-rest",
        kind: "w1-rlusd",
        status: "rlusd_vanished_unattributed",
        proof_type: "state_only",
        role: "W1",
        account: anchors.WALLETS.W1.address,
        hold: "uncertain",
        signed: true,
        submitted: true,
        action: "rest",
        chicago_day: "2026-11-08",
        sequence: shape.sequence,
        submit_attempted: true,
        outside_fill: false,
        counterparty: null,
        realized_pnl_drops: "0",
        inventory_rlusd: shape.balance,
        inventory_drops: "885833",
        outstanding_drops: "885833",
        updated_at: NOW,
      },
    })}\n`);
    const selling = { signs: 0, submits: 0, types: [], fillBalance: shape.balance };
    const placed = await decide(env(), { now: TODAY, ledger: sellLedger, journal: sellJournal }, client(selling));
    assert.equal(placed.decision, "place");
    assert.equal(selling.signs, 1);
    assert.equal(selling.lastTx.TakerGets.currency, shape.currency);
    assert.equal(selling.lastTx.TakerGets.value, shape.balance);
    const sold = Object.values(view(sellLedger, TODAY).missions).find((row) => row.action === "sell");
    assert.equal(sold.idempotency_key, "w1-rlusd-sell-2026-11-10");
    assert.equal(sold.chicago_day, "2026-11-10");
    assert.equal(sold.outstanding_drops, (10n + 200000n).toString());
    assert.equal(sold.cost_basis, "state_only_mark");
    assert.equal(sold.cost_basis_drops, "885833");
    const after = Object.values(view(sellLedger, TODAY).missions).filter((row) => row.kind === "w1-rlusd" && row.hold !== "released").reduce((sum, row) => sum + BigInt(row.outstanding_drops || "0"), 0n);
    assert.equal(after <= 885833n, true);
    assert.equal(after <= 2000000n, true);
    const sellSeq = selling.lastTx.Sequence;
    const taker = "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv";
    selling.hideRest = true;
    selling.notFound = false;
    selling.echo = "prove";
    await decide(env(), { now: TODAY, ledger: sellLedger, journal: sellJournal }, client(selling));
    selling.history = {
      result: {
        validated: true,
        marker: null,
        transactions: [{
          hash: "22".repeat(32),
          tx_json: { TransactionType: "OfferCreate", Account: taker, Sequence: 22049388 },
          meta: {
            TransactionResult: "tesSUCCESS",
            AffectedNodes: [{
              DeletedNode: {
                LedgerEntryType: "Offer",
                FinalFields: {
                  Account: anchors.WALLETS.W1.address,
                  Sequence: sellSeq,
                  TakerGets: selling.lastTx.TakerGets,
                  TakerPays: selling.lastTx.TakerPays,
                },
              },
            }],
          },
        }],
      },
    };
    const filled = await decide(env(), { now: TODAY, ledger: sellLedger, journal: sellJournal }, client(selling));
    assert.equal(filled.outside_fill, true);
    assert.equal(filled.cost_basis, "state_only_mark");
    assert.equal(filled.counterparty, taker);
    assert.equal(filled.realized_pnl_drops, (BigInt(selling.lastTx.TakerPays) - 885833n).toString());
    assert.equal(selling.signs, 1);
  });

  it("does not convert a line that is merely larger than the offer", async () => {
    const thrown = await runFill({ historyThrows: true, fillBalance: "1.5", trust: true });
    assert.equal(thrown.row.decision, "research");
    assert.equal(thrown.row.proof_type, undefined);
    assert.equal(thrown.row.status, undefined);
    const thrownMission = Object.values(view(thrown.ledger, NOW).missions).find((mission) => mission.sequence === 21093748);
    assert.equal(thrownMission.status, "rlusd_resting");
    assert.equal(thrownMission.outstanding_drops, "1200010");
    const loose = await runFill({ history: false, fillBalance: "1.5", trust: true });
    assert.equal(loose.row.decision, "research");
    assert.equal(loose.row.proof_type, undefined);
    const looseMission = Object.values(view(loose.ledger, NOW).missions).find((mission) => mission.sequence === 21093748);
    assert.equal(looseMission.status, "rlusd_resting");
    assert.equal(looseMission.outstanding_drops, "1200010");
  });

  it("books only the consumed slice of a partial RLUSD fill", async () => {
    const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
    const partial = await runFill({
      history: true,
      taker: "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv",
      partial: {
        taker_gets: "400000",
        taker_pays: "0.03111334629390887",
      },
    });
    assert.equal(partial.row.status, "rlusd_partial");
    assert.equal(partial.row.fill_class, "partial");
    assert.equal(partial.row.fill_xrp_drops, "600000");
    assert.equal(partial.row.remaining_drops, "400000");
    assert.equal(partial.row.fill_rlusd, "0.04667001944086331");
    assert.equal(BigInt(partial.row.inventory_drops) > 0n, true);
    assert.equal(BigInt(partial.row.inventory_drops) < 600000n, true);
    const mission = Object.values(view(partial.ledger, NOW).missions).find((row) => row.sequence === shape.sequence);
    assert.equal(mission.status, "rlusd_partial");
    assert.equal(mission.outstanding_drops, (400000n + BigInt(partial.row.inventory_drops) + 200000n).toString());
    assert.equal(BigInt(mission.outstanding_drops) <= 2000000n, true);
    assert.equal(partial.state.signs, 0);
  });

  it("journals a degraded tick when the socket times out and does not sign", async () => {
    assert.equal(CONNECTION_TIMEOUT_MS > 5000, true);
    assert.equal(nextWait(60000, 60000, true), 120000);
    assert.equal(nextWait(200000, 60000, true), 300000);
    assert.equal(nextWait(200000, 60000, false), 60000);
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-down-"));
    let signs = 0;
    const code = await main(["--once"], {
      env: Object.assign(env(), { FOUNDRY_W1_DEX_SUPERVISOR: "yes" }),
      input: {
        now: NOW,
        ledger,
        journal,
        deps: {
          connect: async () => {
            throw Object.assign(new Error("connect() timed out after 5000 ms"), { name: "NotConnectedError" });
          },
          readAccount: async () => { signs += 1; throw new Error("opened"); },
          openWallet: () => { signs += 1; throw new Error("opened"); },
        },
      },
    });
    assert.equal(code, 0);
    assert.equal(signs, 0);
    const rows = readJournal(journal);
    assert.equal(rows[rows.length - 1].decision, "observe");
    assert.equal(rows[rows.length - 1].market, "degraded");
    assert.equal(rows[rows.length - 1].signed, false);
    assert.equal(rows[rows.length - 1].learning, false);
    assert.equal(rows[rows.length - 1].traded, false);
  });

  it("uses the next testnet socket when the first connect times out", async () => {
    assert.throws(() => websocketList("wss://s1.ripple.com"), (error) => error.code === "HOST");
    const calls = [];
    const opened = await connectLive(Object.assign(env(), {
      FOUNDRY_W1_DEX_WS: "wss://testnet.xrpl-labs.com,wss://s.altnet.rippletest.net:51233",
    }), {
      connect: async (url) => {
        calls.push(url);
        if (calls.length === 1) throw Object.assign(new Error("connect() timed out after 5000 ms"), { name: "NotConnectedError" });
        return {
          request: async () => ({ result: { info: { network_id: 1 } } }),
          disconnect: async () => {},
          on() {},
        };
      },
    });
    assert.deepEqual(calls, ["wss://testnet.xrpl-labs.com", "wss://s.altnet.rippletest.net:51233"]);
    await opened.close();
  });
});

function liveOffer(shape, hash) {
  return {
    TransactionType: "OfferCreate",
    Account: anchors.WALLETS.W1.address,
    Flags: bounds.TF_PASSIVE,
    TakerGets: shape.taker_gets_drops,
    TakerPays: { currency: shape.currency, issuer: shape.issuer, value: shape.taker_pays_value },
    Fee: "10",
    Sequence: shape.sequence,
    LastLedgerSequence: shape.ledger_index,
  };
}

function seedFill(ledger, shape, hash, extra) {
  const tx = liveOffer(shape, hash);
  const mission = {
    id: "msnrlusdfill21093748",
    idempotency_key: "w1-rlusd-rest",
    kind: "w1-rlusd",
    status: "rlusd_resting",
    role: "W1",
    account: anchors.WALLETS.W1.address,
    hold: "uncertain",
    signed: true,
    submitted: true,
    action: "rest",
    chicago_day: "2026-11-08",
    sequence: shape.sequence,
    last_ledger_sequence: shape.ledger_index,
    fee_drops: "10",
    outstanding_drops: "1200010",
    realized_loss_drops: "0",
    realized_pnl_drops: "0",
    submit_attempted: true,
    signed_hash: hash,
    proof_hash: extra.bare ? undefined : hash,
    proof_result: extra.bare || extra.legacy ? undefined : "tesSUCCESS",
    rlusd_baseline: extra.legacy ? undefined : "1.5",
    validated_ledger: extra.bare || extra.legacy ? undefined : shape.stored_ledger,
    updated_at: NOW,
    unsigned_tx: tx,
  };
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({ type: "mission.upsert", at: NOW, mission })}\n`);
  return tx;
}

function trustHash(shape) {
  return shape.trustset_hash;
}

function seedTrust(ledger, shape, hash) {
  const mission = {
    id: "msnrlusdtrust21093747",
    idempotency_key: "w1-rlusd-trust",
    kind: "w1-rlusd",
    status: "rlusd_proved",
    role: "W1",
    account: anchors.WALLETS.W1.address,
    hold: "uncertain",
    signed: true,
    submitted: true,
    action: "trust",
    sequence: shape.trustset_sequence,
    fee_drops: "12",
    outstanding_drops: "0",
    submit_attempted: true,
    signed_hash: hash,
    proof_hash: hash,
    proof_result: "tesSUCCESS",
    proof_balance: shape.baseline,
    validated_ledger: shape.stored_ledger,
    updated_at: NOW,
    unsigned_tx: {
      TransactionType: "TrustSet",
      Account: anchors.WALLETS.W1.address,
      Sequence: shape.trustset_sequence,
      LimitAmount: { currency: shape.currency, issuer: shape.issuer, value: "10" },
    },
  };
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({ type: "mission.upsert", at: NOW, mission })}\n`);
}

function trustProof(shape, hash) {
  return {
    result: {
      validated: true,
      hash,
      tx_json: {
        TransactionType: "TrustSet",
        Account: anchors.WALLETS.W1.address,
        Sequence: shape.trustset_sequence,
        Fee: "12",
        Flags: 0x00020000,
        LastLedgerSequence: shape.ledger_index,
        LimitAmount: { currency: shape.currency, issuer: shape.issuer, value: "10" },
      },
      meta: {
        TransactionResult: "tesSUCCESS",
        AffectedNodes: [{
          CreatedNode: {
            LedgerEntryType: "RippleState",
            NewFields: {
              Balance: shape.baseline,
              HighLimit: { currency: shape.currency, issuer: shape.issuer, value: "0" },
              LowLimit: { currency: shape.currency, issuer: anchors.WALLETS.W1.address, value: "10" },
            },
          },
        }],
      },
    },
  };
}

async function runFill(options) {
  const shape = JSON.parse(fs.readFileSync(path.join(RLUSDFIX, "fill-21093748.json"), "utf8"));
  const hash = shape.create_hash;
  assert.equal(hash.startsWith(shape.create_hash_prefix), true);
  assert.equal(hash.endsWith(shape.create_hash_suffix), true);
  assert.equal(hash.length, 64);
  const trust = trustHash(shape);
  assert.equal(trust.startsWith(shape.trustset_hash_prefix), true);
  assert.equal(trust.length, 64);
  const ledger = home();
  const journal = fs.mkdtempSync(path.join(os.tmpdir(), "rlusd-fill-"));
  const tx = seedFill(ledger, shape, hash, options);
  if (options.trust && !options.bare) seedTrust(ledger, shape, trust);
  const takerHash = `${"11".repeat(32)}`;
  const fields = {
    Account: anchors.WALLETS.W1.address,
    Sequence: shape.sequence,
    TakerGets: shape.taker_gets_drops,
    TakerPays: { currency: shape.currency, issuer: shape.issuer, value: shape.taker_pays_value },
  };
  const node = options.partial ? {
    ModifiedNode: {
      LedgerEntryType: "Offer",
      PreviousFields: fields,
      FinalFields: {
        Account: anchors.WALLETS.W1.address,
        Sequence: shape.sequence,
        TakerGets: options.partial.taker_gets,
        TakerPays: { currency: shape.currency, issuer: shape.issuer, value: options.partial.taker_pays },
      },
    },
  } : { DeletedNode: { LedgerEntryType: "Offer", FinalFields: fields } };
  const history = options.history ? {
    result: {
      validated: true,
      marker: null,
      ledger_index: shape.ledger_index,
      transactions: [{
        validated: true,
        hash: takerHash,
        tx_json: { TransactionType: "OfferCreate", Account: options.taker, Sequence: 22049388 },
        meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [node] },
      }],
    },
  } : { result: { validated: true, marker: null, transactions: [] } };
  const state = {
    signs: 0,
    submits: 0,
    types: [],
    fillBalance: options.fillBalance || shape.balance,
    history,
    historyThrows: options.historyThrows === true,
    notFound: options.pruned === true,
    completeLedgers: options.completeLedgers || (options.pruned ? shape.complete_ledgers_after_create : null),
    echo: "prove",
    lastTx: tx,
    lastHash: hash,
    trustHash: trust,
    trustProof: trustProof(shape, trust),
  };
  const row = await decide(env(), { now: NOW, ledger, journal }, client(state));
  if (!options.partial && !options.historyThrows && options.fillBalance == null) {
    for (let tick = 0; tick < 3; tick += 1) await decide(env(), { now: NOW, ledger, journal }, client(state));
  }
  return { row, state, ledger, journal };
}

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
