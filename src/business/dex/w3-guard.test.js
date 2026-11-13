"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../../director/anchors");
const missionConfig = require("../../missions/config");
const { control, view } = require("../../missions/engine");
const { exclusive } = require("../../missions/ledger");
const book = require("./book");
const bounds = require("./bounds");
const market = require("./market");
const rlusd = require("./rlusd");
const guard = require("./w3-guard");
const taker = require("./taker");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-13T18:00:00.000Z";
const NEXT = "2026-11-14T18:00:00.000Z";
const DAY = "2026-11-13";
const OUTSIDER = "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv";
const POOL = { xrp: 2000000n, exact: { coeff: 1n, exp: 0 }, tradingFee: 0 };
const ROOT = path.resolve(__dirname, "../../..");

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "w3-guard-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  return ledger;
}

function seed(dir, mission) {
  exclusive(dir, (api) => api.append({ type: "mission.upsert", at: NOW, mission }));
}

function baseEnv(extra) {
  const spec = bounds.ROLES.W3;
  return Object.assign({
    FOUNDRY_DEX_EXECUTE: "yes",
    FOUNDRY_DEX_ROLE: "W3",
    FOUNDRY_DEX_NETWORK: "xrpl:1",
    FOUNDRY_DEX_ACCOUNT: spec.account,
    FOUNDRY_DEX_ACTIVATE: spec.phrase,
    FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
    FOUNDRY_DEX_MAX_AETH: "10",
    FOUNDRY_DEX_AXELAR_DROPS: "0",
    FOUNDRY_DEX_RLUSD: "yes",
  }, extra || {});
}

function signBlob(state) {
  return async (tx) => {
    state.signs += 1;
    state.types.push(tx.TransactionType);
    state.flags.push(tx.Flags);
    state.last = tx;
    const tx_blob = xrpl.encode(Object.assign({}, tx, {
      SigningPubKey: `ED${"AA".repeat(32)}`,
      TxnSignature: "00".repeat(64),
    }));
    state.hash = xrpl.hashes.hashSignedTx(tx_blob);
    return { tx_blob };
  };
}

function roleLedger(extra) {
  const account = anchors.WALLETS.W3.address;
  const state = extra || {};
  state.box = state.box || { signs: 0, types: [], flags: [], last: null };
  return {
    mode: "injected",
    sign: signBlob(state.box),
    submit: async () => {
      state.box.submits = (state.box.submits || 0) + 1;
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "tx") return state.tx || { result: { error: "txnNotFound" } };
        if (req.command === "server_info") {
          return { result: { info: { network_id: 1, validated_ledger: { seq: 3000, reserve_inc_xrp: "0.2", reserve_base_xrp: "1" }, complete_ledgers: "1-3000" } } };
        }
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: "12" } } };
        if (req.command === "account_info") {
          return { result: { validated: true, account_data: { Account: account, RegularKey: book.REGULAR.W3, Sequence: state.sequence || 20, Balance: "50000000", OwnerCount: 0 } } };
        }
        if (req.command === "account_lines") {
          const lines = state.trust === false ? [] : [{ account: rlusd.ISSUER, currency: rlusd.CURRENCY, balance: state.balance || "0" }];
          return { result: { validated: true, lines } };
        }
        if (req.command === "account_offers") return { result: { validated: true, offers: [] } };
        if (req.command === "amm_info") {
          const amm = state.amm || {};
          return {
            result: {
              validated: true,
              amm: {
                account: rlusd.AMM,
                amount: amm.amount || "2000000",
                amount2: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: amm.value || "1" },
                trading_fee: amm.trading_fee == null ? 0 : amm.trading_fee,
              },
            },
          };
        }
        if (req.command === "book_offers") {
          const offers = req.taker_gets && req.taker_gets.currency === "XRP" ? (state.bids || []) : (state.asks || []);
          return { result: { validated: true, offers } };
        }
        throw new Error(`unexpected ${req.command}`);
      },
    },
  };
}

function lot(dir, fields) {
  const mission = Object.assign({
    id: "msnw3guardbuy0001",
    idempotency_key: "w3-guard-lot",
    kind: "w3-rlusd",
    role: "W3",
    account: anchors.WALLETS.W3.address,
    action: "buy",
    status: "rlusd_filled",
    hold: "uncertain",
    outstanding_drops: "200012",
    bought_rlusd: "0.1",
    proof_result: "tesSUCCESS",
    proof_type: "consuming_tx",
    proof_hash: "CD".repeat(32),
    realized_loss_drops: "0",
    submit_attempted: true,
    chicago_day: DAY,
    updated_at: NOW,
  }, fields || {});
  seed(dir, mission);
  return mission;
}

function lossFromProcess(dir) {
  const script = `
    const guard = require("./src/business/dex/w3-guard");
    const state = guard.read(${JSON.stringify(dir)});
    process.stdout.write(JSON.stringify({
      closed: state.closed === true,
      day: state.day || null,
      pnl: state.realized_pnl_drops || null,
      loss: state.closed ? null : guard.lossOf(state, ${JSON.stringify(DAY)}).toString(),
    }));
  `;
  const ran = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout);
}

describe("W3 price and loss guards", () => {
  const exact = market.exactIou("0.1");
  const net = guard.netProceeds(POOL, [], exact, 12n);

  it("prices the pool after the trading fee and ignores an offer estimate", () => {
    assert.equal(guard.DEFAULT_LOSS_CAP, 50000n);
    assert.equal(guard.DEFAULT_MARGIN, 0n);
    assert.equal(guard.lossCap({}), 50000n);
    assert.equal(guard.sellMargin({}), 0n);
    assert.equal(guard.lossCap({ FOUNDRY_W3_DAILY_LOSS_CAP_DROPS: "1000" }), 1000n);
    assert.equal(guard.lossCap({ FOUNDRY_W3_DAILY_LOSS_CAP_DROPS: "50001" }), null);
    assert.equal(guard.sellMargin({ FOUNDRY_W3_SELL_MARGIN_DROPS: "1" }), 1n);
    assert.equal(guard.sellMargin({ FOUNDRY_W3_SELL_MARGIN_DROPS: "-1" }), null);
    assert.equal(net, 181806n);
    assert.equal(guard.poolOut(Object.assign({}, POOL, { tradingFee: 50000 }), exact), 90909n);
    const account = anchors.WALLETS.W3.address;
    const meta = {
      AffectedNodes: [{
        ModifiedNode: {
          LedgerEntryType: "AccountRoot",
          FinalFields: { Account: account, Balance: "49849990" },
          PreviousFields: { Balance: "50000000" },
        },
      }],
    };
    assert.equal(guard.provedSpend(meta, { Fee: "10", TakerGets: "200000" }, account), "150010");
    assert.equal(guard.provedSpend({ AffectedNodes: [] }, { Fee: "10", TakerGets: "200000" }, account), null);
    assert.equal(guard.provedSpend(meta, { Fee: "10", TakerGets: "200000" }, anchors.WALLETS.W0.address), null);
    assert.equal(guard.portion(10n, { coeff: 3n, exp: 0 }, { coeff: 2n, exp: 0 }), 7n);
  });

  it("holds RLUSD when the quote does not cover the proved cost", async () => {
    const ledger = home();
    lot(ledger, { cost_basis_drops: (net + 1n).toString() });
    const state = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [], last: null } };
    const held = await taker.tick(baseEnv(), ledger, NOW, roleLedger(state), { headroom: 100000000n }, null);
    assert.equal(held.signed, false);
    assert.match(held.rationale, /proved cost basis/);
    assert.equal(state.box.signs, 0);
    const saved = view(ledger, NOW).missions.msnw3guardbuy0001;
    assert.equal(saved.bought_rlusd, "0.1");
    assert.equal(saved.outstanding_drops, "200012");
    assert.equal(saved.hold, "uncertain");

    const worse = home();
    lot(worse, { id: "msnw3guardbuy0002", idempotency_key: "w3-guard-worse", cost_basis_drops: "190000" });
    const quiet = {
      trust: true,
      balance: "5",
      box: { signs: 0, types: [], flags: [], last: null },
      bids: [{
        Account: OUTSIDER,
        TakerGets: "100000",
        TakerPays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0.1" },
      }],
    };
    const still = await taker.tick(baseEnv(), worse, NOW, roleLedger(quiet), { headroom: 100000000n }, null);
    assert.equal(still.signed, false);
    assert.match(still.rationale, /proved cost basis/);
    assert.equal(quiet.box.signs, 0);
    assert.equal(view(worse, NOW).missions.msnw3guardbuy0002.bought_rlusd, "0.1");
  });

  it("sells a favorable proved lot and no more than the line balance", async () => {
    const ledger = home();
    lot(ledger, { cost_basis_drops: net.toString() });
    const state = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [], last: null } };
    const sold = await taker.tick(baseEnv(), ledger, NOW, roleLedger(state), { headroom: 100000000n }, null);
    assert.equal(sold.signed, true);
    assert.equal(state.box.last.Flags, 0x00020000);
    assert.equal(state.box.last.TakerGets.value, "0.1");
    assert.equal(state.box.last.TakerGets.issuer, rlusd.ISSUER);
    assert.equal(BigInt(state.box.last.TakerPays) >= net + 12n, true);
    assert.equal(BigInt(state.box.last.TakerPays) <= 250000n, true);
    assert.equal(JSON.stringify(state.box.last).includes("rKmPxq"), false);

    const partial = home();
    lot(partial, {
      id: "msnw3guardpartial1",
      idempotency_key: "w3-guard-partial",
      bought_rlusd: "0.2",
      cost_basis_drops: (net * 2n).toString(),
    });
    const slice = { trust: true, balance: "0.1", box: { signs: 0, types: [], flags: [], last: null } };
    const smaller = await taker.tick(baseEnv(), partial, NOW, roleLedger(slice), { headroom: 100000000n }, null);
    assert.equal(smaller.signed, true);
    assert.equal(slice.box.last.TakerGets.value, "0.1");
    assert.notEqual(slice.box.last.TakerGets.value, "0.2");

    const tight = home();
    lot(tight, { id: "msnw3guardmargin01", idempotency_key: "w3-guard-margin", cost_basis_drops: net.toString() });
    const margin = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [], last: null } };
    const held = await taker.tick(baseEnv({ FOUNDRY_W3_SELL_MARGIN_DROPS: "1" }), tight, NOW, roleLedger(margin), { headroom: 100000000n }, null);
    assert.equal(held.signed, false);
    assert.match(held.rationale, /cost basis/);
    assert.equal(margin.box.signs, 0);

    const booked = home();
    lot(booked, { id: "msnw3guardbook0001", idempotency_key: "w3-guard-book", cost_basis_drops: "190000" });
    const cross = {
      trust: true,
      balance: "5",
      box: { signs: 0, types: [], flags: [], last: null },
      bids: [{
        Account: OUTSIDER,
        TakerGets: "210000",
        TakerPays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0.1" },
      }],
    };
    const took = await taker.tick(baseEnv(), booked, NOW, roleLedger(cross), { headroom: 100000000n }, null);
    assert.equal(took.signed, true);
    assert.equal(cross.box.last.TakerPays, "190012");
    assert.equal(cross.box.last.TakerGets.value, "0.1");
  });

  it("stops new buys at exactly 50000 drops and still allows a favorable sell", async () => {
    const open = home();
    guard.record(open, DAY, -49999n, "11".repeat(32));
    const under = { trust: true, box: { signs: 0, types: [], flags: [], last: null } };
    const bought = await taker.tick(baseEnv(), open, NOW, roleLedger(under), { headroom: 100000000n }, null);
    assert.equal(bought.signed, true);
    assert.equal(typeof under.box.last.TakerGets, "string");
    assert.equal(under.box.signs, 1);

    const capped = home();
    guard.record(capped, DAY, -50000n, "22".repeat(32));
    const blocked = { trust: true, box: { signs: 0, types: [], flags: [], last: null } };
    const stopped = await taker.tick(baseEnv(), capped, NOW, roleLedger(blocked), { headroom: 100000000n }, null);
    assert.equal(stopped.signed, false);
    assert.match(stopped.rationale, /loss cap/);
    assert.equal(blocked.box.signs, 0);

    const exit = home();
    guard.record(exit, DAY, -50000n, "33".repeat(32));
    lot(exit, { id: "msnw3guardexit0001", idempotency_key: "w3-guard-exit", cost_basis_drops: net.toString() });
    const state = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [], last: null } };
    const sold = await taker.tick(baseEnv(), exit, NOW, roleLedger(state), { headroom: 100000000n }, null);
    assert.equal(sold.signed, true);
    assert.equal(state.box.last.TakerGets.value, "0.1");
    assert.equal(state.box.signs, 1);

    const loose = home();
    const refused = { trust: true, box: { signs: 0, types: [], flags: [], last: null } };
    const unsafe = await taker.tick(baseEnv({ FOUNDRY_W3_DAILY_LOSS_CAP_DROPS: "50001" }), loose, NOW, roleLedger(refused), { headroom: 100000000n }, null);
    assert.equal(unsafe.signed, false);
    assert.match(unsafe.rationale, /not a safe drop string/);
    assert.equal(refused.box.signs, 0);
  });

  it("resets the loss cap on the next Chicago day", async () => {
    const ledger = home();
    guard.record(ledger, DAY, -50000n, "44".repeat(32));
    const state = { trust: true, box: { signs: 0, types: [], flags: [], last: null } };
    const bought = await taker.tick(baseEnv(), ledger, NEXT, roleLedger(state), { headroom: 100000000n }, null);
    assert.equal(bought.signed, true);
    assert.equal(typeof state.box.last.TakerGets, "string");
    assert.equal(state.box.signs, 1);
    const kept = JSON.parse(fs.readFileSync(path.join(ledger, guard.FILE), "utf8"));
    assert.equal(kept.day, DAY);
    assert.equal(kept.realized_pnl_drops, "-50000");
  });

  it("keeps a proved loss after a new process starts", async () => {
    const ledger = home();
    const hash = "AB".repeat(32);
    seed(ledger, {
      id: "msnw3guardsell0001",
      idempotency_key: "w3-guard-sell-loss",
      kind: "w3-rlusd",
      role: "W3",
      account: anchors.WALLETS.W3.address,
      action: "sell",
      status: "rlusd_unknown",
      hold: "uncertain",
      signed_hash: hash,
      cost_basis_drops: "200000",
      outstanding_drops: "12",
      realized_loss_drops: "0",
      submit_attempted: true,
      chicago_day: DAY,
      sequence: 21,
      updated_at: NOW,
    });
    const account = anchors.WALLETS.W3.address;
    const state = {
      trust: true,
      box: { signs: 0, types: [], flags: [], last: null },
      tx: {
        result: {
          validated: true,
          hash,
          meta: {
            TransactionResult: "tesSUCCESS",
            AffectedNodes: [{
              ModifiedNode: {
                LedgerEntryType: "AccountRoot",
                FinalFields: { Account: account, Balance: "50150000" },
                PreviousFields: { Balance: "50000000" },
              },
            }],
          },
        },
      },
    };
    const proved = await taker.tick(baseEnv(), ledger, NOW, roleLedger(state), { headroom: 100000000n }, null);
    assert.equal(proved.decision, "reconcile");
    assert.equal(state.box.signs, 0);
    const file = path.join(ledger, guard.FILE);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/seed|secret|tx_blob|private/i.test(text), false);
    assert.equal(fs.existsSync(path.join(ledger, `${guard.FILE}.partial`)), false);
    assert.equal(fs.existsSync(path.join(ledger, "lock")), false);
    const saved = JSON.parse(text);
    assert.equal(saved.schema, guard.SCHEMA);
    assert.equal(saved.day, DAY);
    assert.equal(saved.realized_pnl_drops, "-50000");
    assert.deepEqual(saved.proofs, [hash]);
    const again = guard.record(ledger, DAY, -50000n, hash);
    assert.equal(again.replay, true);
    assert.equal(again.realized_pnl_drops, "-50000");

    const seen = lossFromProcess(ledger);
    assert.equal(seen.closed, false);
    assert.equal(seen.day, DAY);
    assert.equal(seen.pnl, "-50000");
    assert.equal(seen.loss, "50000");

    const restarted = { trust: true, box: { signs: 0, types: [], flags: [], last: null } };
    const blocked = await taker.tick(baseEnv(), ledger, NOW, roleLedger(restarted), { headroom: 100000000n }, null);
    assert.equal(blocked.signed, false);
    assert.match(blocked.rationale, /loss cap/);
    assert.equal(restarted.box.signs, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).realized_pnl_drops, "-50000");
  });

  it("fails closed when the loss record is unreadable", async () => {
    const ledger = home();
    fs.writeFileSync(path.join(ledger, guard.FILE), "{not-json\n");
    const buy = { trust: true, box: { signs: 0, types: [], flags: [], last: null } };
    const blocked = await taker.tick(baseEnv(), ledger, NOW, roleLedger(buy), { headroom: 100000000n }, null);
    assert.equal(blocked.signed, false);
    assert.match(blocked.rationale, /unreadable/);
    assert.equal(buy.box.signs, 0);

    const exit = home();
    fs.writeFileSync(path.join(exit, guard.FILE), "null\n");
    lot(exit, { id: "msnw3guardcorrupt1", idempotency_key: "w3-guard-corrupt", cost_basis_drops: net.toString() });
    const sell = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [], last: null } };
    const held = await taker.tick(baseEnv(), exit, NOW, roleLedger(sell), { headroom: 100000000n }, null);
    assert.equal(held.signed, false);
    assert.match(held.rationale, /unreadable/);
    assert.equal(sell.box.signs, 0);
    assert.equal(view(exit, NOW).missions.msnw3guardcorrupt1.bought_rlusd, "0.1");
    assert.equal(view(exit, NOW).missions.msnw3guardcorrupt1.outstanding_drops, "200012");
  });
});
