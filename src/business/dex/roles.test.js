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
const { exclusive } = require("../../missions/ledger");
const bounds = require("./bounds");
const exposure = require("./exposure");
const gates = require("./gates");
const book = require("./book");
const rlusd = require("./rlusd");
const taker = require("./taker");
const quoter = require("./quoter");
const oracle = require("./oracle");
const signer = require("./signer");
const { decide } = require("./director");
const { health } = require("./supervisor");
const runtimePolicy = require("../../runtime/policy");
const runtimeSigner = require("../../runtime/signer");
const bankroll = require("../bankroll");
const math = require("../../frontier/oracle-math");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-13T18:00:00.000Z";
const DAY = new Date(NOW);
const OUTSIDER = "rNv54ueuxFt5a3TgqYA4QqmN2hJX2q2TGv";

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "roles-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  return ledger;
}

function seed(dir, mission) {
  exclusive(dir, (api) => api.append({ type: "mission.upsert", at: NOW, mission }));
}

function baseEnv(role) {
  const spec = bounds.ROLES[role];
  return {
    FOUNDRY_DEX_EXECUTE: "yes",
    FOUNDRY_DEX_ROLE: role,
    FOUNDRY_DEX_NETWORK: "xrpl:1",
    FOUNDRY_DEX_ACCOUNT: spec.account,
    FOUNDRY_DEX_ACTIVATE: spec.phrase,
    FOUNDRY_DEX_BANKROLL_DROPS: "100000000",
    FOUNDRY_DEX_MAX_AETH: "10",
    FOUNDRY_DEX_AXELAR_DROPS: "0",
    FOUNDRY_DEX_RLUSD: "yes",
  };
}

function mission(partial) {
  return Object.assign({
    id: partial.id,
    kind: partial.kind,
    role: partial.role,
    hold: "uncertain",
    status: "rlusd_filled",
    action: "buy",
    outstanding_drops: "0",
    realized_loss_drops: "0",
  }, partial);
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

function roleLedger(role, extra) {
  const account = anchors.WALLETS[role].address;
  const regular = book.REGULAR[role];
  const state = extra || {};
  return {
    mode: "injected",
    sign: signBlob(state.box || (state.box = { signs: 0, types: [], flags: [] })),
    submit: async () => {
      state.box.submits = (state.box.submits || 0) + 1;
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "tx") return state.tx || { result: { error: "txnNotFound" } };
        if (req.command === "server_info") {
          return { result: { info: { network_id: state.networkId != null ? state.networkId : 1, validated_ledger: { seq: 3000, reserve_inc_xrp: "0.2", reserve_base_xrp: "1" }, complete_ledgers: "1-3000" } } };
        }
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: "12" } } };
        if (req.command === "account_info") {
          return { result: { validated: true, account_data: { Account: account, RegularKey: regular, Sequence: state.sequence || 20, Balance: "50000000", OwnerCount: 0 } } };
        }
        if (req.command === "account_lines") {
          const lines = state.trust === false ? [] : [{ account: rlusd.ISSUER, currency: rlusd.CURRENCY, balance: state.balance || "0" }];
          return { result: { validated: true, lines } };
        }
        if (req.command === "account_offers") {
          return { result: { validated: true, offers: state.offers || [] } };
        }
        if (req.command === "amm_info") {
          const amm = state.amm || {};
          return {
            result: {
              validated: true,
              amm: {
                account: rlusd.AMM,
                amount: amm.amount || "10000000000",
                amount2: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: amm.value || "4000" },
                trading_fee: amm.trading_fee == null ? 500 : amm.trading_fee,
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
    box: state.box,
    beforeReserve: state.beforeReserve,
  };
}

function spread() {
  return {
    bids: [{
      Account: OUTSIDER,
      TakerGets: "1000000",
      TakerPays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "1" },
    }],
    asks: [{
      Account: OUTSIDER,
      TakerGets: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "1" },
      TakerPays: "2000000",
    }],
  };
}

function w1Client(box) {
  return {
    mode: "injected",
    sign: signBlob(box),
    submit: async () => {
      box.submits = (box.submits || 0) + 1;
      return {};
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") {
          return { result: { info: { network_id: 1, validated_ledger: { seq: 4000, reserve_inc_xrp: "0.2", reserve_base_xrp: "1" }, complete_ledgers: "1-4000" } } };
        }
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: "12" } } };
        if (req.command === "account_info") {
          return { result: { validated: true, account_data: { Account: anchors.WALLETS.W1.address, RegularKey: rlusd.REGULAR_KEY, Sequence: 8, Balance: "80000000", OwnerCount: 1 } } };
        }
        if (req.command === "account_lines") {
          return { result: { validated: true, lines: [{ account: rlusd.ISSUER, currency: rlusd.CURRENCY, balance: "0" }] } };
        }
        if (req.command === "account_offers") return { result: { validated: true, offers: [] } };
        if (req.command === "amm_info") {
          return { result: { validated: true, amm: { account: rlusd.AMM, amount: "10000000000", amount2: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "4000" }, trading_fee: 500 } } };
        }
        if (req.command === "book_offers") return { result: { validated: true, offers: [] } };
        throw new Error(req.command);
      },
    },
  };
}

function agentCtx(extra) {
  return Object.assign({
    env: { FOUNDRY_AGENT_SIGN: "yes" },
    dry: true,
    skipAuth: true,
    skipRpc: true,
    wallet: "W3",
    networkId: 1,
    account: runtimeSigner.richAccount(),
    history: [],
    motions: [],
    state: { watched: { batch: { atomic_enabled: false } } },
    now: DAY,
    feeDrops: "12",
  }, extra || {});
}

function takerOffer(flags, drops, issuer) {
  return {
    TransactionType: "OfferCreate",
    Account: anchors.WALLETS.W3.address,
    Flags: flags,
    TakerGets: drops,
    TakerPays: { currency: rlusd.CURRENCY, issuer: issuer || rlusd.ISSUER, value: "0.2" },
    Fee: "12",
    Sequence: 4,
    LastLedgerSequence: 40,
  };
}

describe("shared RLUSD caps", () => {
  it("ships a 3.5 XRP team cap and keeps the per-role caps", () => {
    assert.equal(bounds.TEAM_RLUSD_CAP_DROPS, 3500000n);
    assert.equal(bounds.teamCapDrops({}), 3500000n);
    assert.equal(bounds.teamCapDrops({ FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS: "3500000" }), 3500000n);
    assert.equal(bounds.teamCapDrops({ FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS: "2000000" }), 2000000n);
    assert.equal(bounds.teamCapDrops({ FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS: "3500001" }), null);
    assert.equal(bounds.ROLE_RLUSD_CAP.W1, 2000000n);
    assert.equal(bounds.ROLE_RLUSD_CAP.W3, 500000n);
    assert.equal(bounds.ROLE_RLUSD_CAP.W4, 1000000n);
    assert.equal(rlusd.MAX_TRADE_DROPS, 2000000n);
    const w1 = bounds.verifiedEnv(baseEnv("W1"));
    assert.equal(w1.role, "W1");
    assert.equal(w1.account, anchors.WALLETS.W1.address);
    assert.equal(w1.team_rlusd_cap_drops, "3500000");
    assert.equal(w1.axelar_drops, "0");
    assert.equal(w1.learning, false);
    assert.equal(bounds.verifiedEnv(Object.assign(baseEnv("W1"), { FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS: "3500001" })), null);
    assert.equal(bounds.verifiedEnv(Object.assign(baseEnv("W3"), { FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W0.address })), null);
    assert.equal(bounds.verifiedEnv(Object.assign(baseEnv("W3"), { FOUNDRY_DEX_AXELAR_DROPS: "1" })), null);
    assert.equal(bounds.verifiedEnv(baseEnv("W3")).role, "W3");
    assert.equal(bounds.verifiedEnv(baseEnv("W4")).phrase, "ACTIVATE-W4-DEX-ROLE");
  });

  it("adds each role once and blocks at 3.5 XRP", () => {
    const state = {
      missions: {
        w1: mission({ id: "w1", kind: "w1-rlusd", role: "W1", outstanding_drops: "2000000" }),
        w3: mission({ id: "w3", kind: "w3-rlusd", role: "W3", outstanding_drops: "500000" }),
        w4: mission({ id: "w4", kind: "w4-rlusd", role: "W4", outstanding_drops: "1000000" }),
        copy: mission({ id: "w3", kind: "w3-rlusd", role: "W3", outstanding_drops: "500000" }),
        released: mission({ id: "gone", kind: "w3-rlusd", role: "W3", hold: "released", outstanding_drops: "500000" }),
        trust: mission({ id: "trust", kind: "w1-rlusd", role: "W1", action: "trust", status: "rlusd_proved", outstanding_drops: "200010" }),
      },
    };
    assert.equal(exposure.teamOpen(state), 3500000n);
    assert.equal(exposure.roleOpen(state, "W1") + exposure.roleOpen(state, "W3") + exposure.roleOpen(state, "W4"), 3500000n);
    assert.equal(exposure.allows(state, "W1", 0n, 3500000n), true);
    assert.equal(exposure.allows(state, "W3", 1n, 3500000n), false);
    assert.equal(exposure.ledgerHeadroom(state).used, 3500000n);
    const roomy = {
      missions: {
        w4: mission({ id: "w4", kind: "w4-rlusd", role: "W4", outstanding_drops: "1500000" }),
      },
    };
    assert.equal(exposure.allows(roomy, "W1", 2000000n, 3500000n), true);
    assert.equal(exposure.allows(roomy, "W1", 2000001n, 3500000n), false);
    assert.equal(exposure.allows({ missions: {} }, "W1", 2000001n, 3500000n), false);
    assert.equal(exposure.allows({ missions: {} }, "W3", 500001n, 3500000n), false);
    assert.equal(exposure.allows({ missions: {} }, "W4", 1000001n, 3500000n), false);
    const doubled = {
      missions: {
        trust: mission({
          id: "msnde18ca1a9d441a55",
          kind: "w4-rlusd",
          role: "W4",
          action: "trust",
          status: "rlusd_unknown",
          outstanding_drops: "200010",
          fee_drops: "10",
        }),
        bid: mission({
          id: "w4bid",
          kind: "w4-rlusd",
          role: "W4",
          action: "bid",
          status: "rlusd_resting",
          outstanding_drops: "400010",
        }),
        flight: mission({
          id: "w4flight",
          kind: "w4-rlusd",
          role: "W4",
          action: "cancel",
          status: "rlusd_unknown",
          outstanding_drops: "12",
        }),
      },
    };
    assert.equal(exposure.teamOpen(doubled), 400032n);
    assert.equal(exposure.roleOpen(doubled, "W4"), 400032n);
    assert.equal(exposure.teamOpen(doubled) > 400010n, true);
    const existingQuote = {
      missions: {
        trust: mission({
          id: "msnde18ca1a9d441a55",
          kind: "w4-rlusd",
          role: "W4",
          action: "trust",
          status: "rlusd_proved",
          outstanding_drops: "0",
          fee_drops: "10",
        }),
        bid: mission({
          id: "msn0e39f438e3c0dc85",
          kind: "w4-rlusd",
          role: "W4",
          action: "bid",
          status: "rlusd_resting",
          outstanding_drops: "400010",
        }),
      },
    };
    assert.equal(exposure.teamOpen(existingQuote), 400010n);
    assert.equal(exposure.roleOpen(existingQuote, "W4"), 400010n);
    assert.equal(exposure.ledgerHeadroom(doubled).used, 400032n);
    const smallAsk = {
      missions: {
        trust: doubled.missions.trust,
        ask: mission({
          id: "w4ask",
          kind: "w4-rlusd",
          role: "W4",
          action: "ask",
          status: "rlusd_resting",
          outstanding_drops: "100000",
        }),
      },
    };
    assert.equal(exposure.teamOpen(smallAsk), 300010n);
    assert.equal(exposure.roleOpen(smallAsk, "W4"), 300010n);
    assert.equal(exposure.allows(doubled, "W4", 599969n, 3500000n), false);
    assert.equal(exposure.allows(doubled, "W1", 2000000n, 3500000n), false);
    const withDex = {
      missions: {
        trust: mission({
          id: "trust-dex",
          kind: "w4-rlusd",
          role: "W4",
          action: "trust",
          status: "rlusd_unknown",
          outstanding_drops: "200010",
          fee_drops: "10",
        }),
        bid: mission({
          id: "bid-dex",
          kind: "w4-rlusd",
          role: "W4",
          action: "bid",
          status: "rlusd_resting",
          outstanding_drops: "400010",
        }),
        dex: mission({
          id: "dex",
          kind: "w1-dex-offer",
          role: "W1",
          action: "rest",
          status: "dex_open",
          outstanding_drops: "2000000",
        }),
      },
    };
    assert.equal(exposure.ledgerHeadroom(withDex).used, 2400020n);
    doubled.missions.trust.status = "rlusd_proved";
    assert.equal(exposure.teamOpen(doubled), 400022n);
    assert.equal(exposure.ledgerHeadroom(doubled).used, 400022n);
    const position = { proved_xrp: 0n, reserve_inc: 200000n };
    const head = rlusd.headroom(position, { missions: { w3: mission({ id: "w3", kind: "w3-rlusd", role: "W3", outstanding_drops: "500000" }) } }, { trustline: false, own: [] });
    assert.equal(head.used, 500000n);
  });

  it("lets an uncertain in-flight hold block every other role", () => {
    const state = {
      missions: {
        flight: mission({ id: "flight", kind: "w4-rlusd", role: "W4", status: "rlusd_unknown", outstanding_drops: "1000" }),
      },
    };
    assert.equal(exposure.blocksNewRisk(state, "W3"), true);
    assert.equal(exposure.blocksNewRisk(state, "W1"), true);
    assert.equal(exposure.blocksNewRisk(state, "W4"), false);
    assert.equal(exposure.allows(state, "W3", 100000n, 3500000n), false);
    assert.equal(exposure.allows({ missions: {} }, "W1", 1000n, 999999999n), true);
    assert.equal(exposure.allows({ missions: {} }, "W1", 3500001n, 999999999n), false);
  });

  it("counts every role once against the shared 100 XRP bankroll", () => {
    const observed = {
      proved: true,
      reserveBase: 1000000n,
      reserveInc: 200000n,
      ownerCount: 0n,
      balance: 100000000n,
      offers: [],
      rlusdOffers: [],
      bids: [],
      pool: { xrp: 0n, balance: 0n, supply: 1n, aethScaled: 0n, sole: false },
    };
    const shared = {
      missions: {
        w3: mission({ id: "w3", kind: "w3-rlusd", role: "W3", outstanding_drops: "500000" }),
        copy: mission({ id: "w3", kind: "w3-rlusd", role: "W3", outstanding_drops: "500000" }),
        legacy: mission({ id: exposure.LEGACY_HOLD, kind: "w3-rlusd", role: "W3", outstanding_drops: "5000000" }),
      },
    };
    const position = bankroll.room(shared, observed);
    assert.equal(position.used, 1500000n);
    assert.equal(position.proved_xrp, 1000000n);
    const marked = {
      missions: Object.assign({}, shared.missions, {
        "bankroll-lp-high-water": {
          id: "bankroll-lp-high-water",
          kind: "w1-bankroll-mark",
          proved_xrp_drops: "5000000",
          rlusd_overlap_drops: "0",
          lp_high_water_drops: "0",
          hold: "released",
          outstanding_drops: "0",
        },
        dex: mission({ id: "dex", kind: "w1-dex-offer", role: "W1", outstanding_drops: "2000000", action: "rest", status: "dex_open" }),
      }),
    };
    assert.equal(exposure.ledgerHeadroom(marked).used, 5500000n);
  });

  it("does not let two roles reserve past 3.5 XRP on one ledger", async () => {
    const ledger = home();
    seed(ledger, mission({ id: "w4", kind: "w4-rlusd", role: "W4", outstanding_drops: "3000000", status: "rlusd_filled", action: "bid" }));
    seed(ledger, { id: exposure.LEGACY_HOLD, hold: "uncertain", signed: true, outstanding_drops: "1747", updated_at: NOW });
    let waiting = [];
    const barrier = () => new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 2) {
        const ready = waiting.splice(0, waiting.length);
        ready.forEach((fn) => fn());
      }
    });
    const w3 = { trust: true, box: { signs: 0, types: [], flags: [] }, beforeReserve: barrier };
    const w1box = { signs: 0, types: [], flags: [] };
    const w1 = w1Client(w1box);
    w1.beforeReserve = barrier;
    await Promise.all([
      taker.tick(baseEnv("W3"), ledger, NOW, roleLedger("W3", w3), { headroom: 100000000n }, null),
      rlusd.tick(Object.assign(baseEnv("W1"), { FOUNDRY_DEX_RLUSD: "yes" }), ledger, NOW, w1, { proved_xrp: 0n, reserve_inc: 200000n }),
    ]);
    assert.equal(exposure.teamOpen(view(ledger, NOW)) <= 3500000n, true);
    assert.equal(w3.box.signs + w1box.signs, 1);
    const legacy = view(ledger, NOW).missions[exposure.LEGACY_HOLD];
    assert.equal(legacy.hold, "uncertain");
    assert.equal(legacy.signed, true);
    assert.equal(legacy.outstanding_drops, "1747");
  });
});

describe("signer gates", () => {
  it("requires IOC, the official issuer, and refuses W0 and the lookalike", async () => {
    assert.equal(runtimePolicy.AGENT_CAPS.per_tx_drops, "10000000");
    assert.equal(runtimePolicy.AGENT_CAPS.max_tx_per_utc_day, 200);
    const doc = runtimePolicy.loadAllowlist();
    assert.equal(doc.accounts.W0.sign, false);
    assert.equal(doc.actions.w3_pool_taker.ioc_required, true);
    assert.equal(doc.actions.w3_pool_taker.issuer, rlusd.ISSUER);
    assert.equal(doc.actions.w3_pool_taker.pool, rlusd.AMM);
    assert.equal(doc.actions.w5_rlusd_oracle.account, "W5");
    assert.equal(doc.actions.w5_rlusd_oracle.tx_type, "OracleSet");
    assert.doesNotThrow(() => runtimePolicy.assertAgentRequest(agentCtx({
      intent: "w3_pool_taker",
      tx: takerOffer(gates.TF_IOC, "200000"),
    })));
    assert.throws(() => gates.assertDex(takerOffer(bounds.TF_PASSIVE, "200000"), {
      role: "W3",
      type: "OfferCreate",
      account: anchors.WALLETS.W3.address,
      sequence: 4,
      last: 40,
      fee: "12",
      taker_gets: "200000",
      taker_pays: takerOffer(gates.TF_IOC, "200000").TakerPays,
    }), (error) => error.code === "TX");
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      intent: "w3_pool_taker",
      tx: takerOffer(gates.TF_IOC, "200000", "rKmPxqLookalikeIssuerXXXXXXXX"),
    })), (error) => error.code === "TX");
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      intent: "w3_pool_taker",
      tx: Object.assign(takerOffer(gates.TF_IOC, "200000"), { Destination: anchors.AMM }),
    })), (error) => error.code === "POOL");
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      intent: "w3_pool_taker",
      tx: takerOffer(gates.TF_IOC, "300000"),
    })), (error) => error.code === "CAP");
    const history = [1, 2, 3, 4].map(() => ({ action: "w3_pool_taker", transaction_type: "OfferCreate", ts: NOW }));
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      intent: "w3_pool_taker",
      history,
      tx: takerOffer(gates.TF_IOC, "200000"),
    })), (error) => error.code === "DAY");
    await assert.rejects(() => runtimeSigner.evaluate({
      wallet: "W0",
      tx: { TransactionType: "Payment", Account: anchors.WALLETS.W0.address, Destination: OUTSIDER, Amount: "1" },
    }, agentCtx()), (error) => error.code === "W0");
  });

  it("allowlists OracleSet for W5 only and keeps it fees-only", async () => {
    const oracleTx = {
      TransactionType: "OracleSet",
      Account: anchors.WALLETS.W5.address,
      OracleDocumentID: 2,
      LastUpdateTime: 1700000000,
      PriceDataSeries: [{ PriceData: { BaseAsset: rlusd.CURRENCY, QuoteAsset: "XRP", AssetPrice: "1", Scale: 8 } }],
    };
    await assert.rejects(() => runtimeSigner.evaluate({ wallet: "W0", tx: Object.assign({}, oracleTx, { Account: anchors.WALLETS.W0.address }) }, agentCtx()), (error) => error.code === "W0");
    await assert.rejects(() => runtimeSigner.evaluate({ wallet: "W3", intent: "w5_rlusd_oracle", tx: Object.assign({}, oracleTx, { Account: anchors.WALLETS.W3.address }) }, agentCtx({ wallet: "W3" })), (error) => error.code === "WALLET");
    const dry = await runtimeSigner.evaluate({ wallet: "W5", intent: "w5_rlusd_oracle", dry_run: true, tx: oracleTx }, agentCtx({ wallet: "W5" }));
    assert.equal(dry.body.dry_run, true);
    assert.equal(dry.body.signed, false);
    assert.equal(dry.body.key_loaded, false);
    assert.equal(dry.body.tx.TransactionType, "OracleSet");
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      wallet: "W5",
      intent: "w5_rlusd_oracle",
      tx: Object.assign({}, oracleTx, { Amount: "1", Destination: OUTSIDER }),
    })), (error) => error.code === "CAP");
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      wallet: "W5",
      intent: "w5_rlusd_oracle",
      tx: Object.assign({}, oracleTx, {
        PriceDataSeries: [{ PriceData: { BaseAsset: rlusd.CURRENCY, QuoteAsset: "XRP", AssetPrice: "1", Scale: 11 } }],
      }),
    })), (error) => error.code === "TX");
    assert.throws(() => runtimePolicy.assertAgentRequest(agentCtx({
      wallet: "W5",
      intent: "w5_rlusd_oracle",
      tx: Object.assign({}, oracleTx, { LastUpdateTime: 800000000 }),
    })), (error) => error.code === "TX");
  });
});

describe("W3 taker and W4 quoter", () => {
  it("signs one IOC buy inside 0.1-0.25 XRP and stops when the team or a hold is full", async () => {
    const ledger = home();
    const state = { trust: true, box: { signs: 0, types: [], flags: [] } };
    const clients = roleLedger("W3", state);
    const first = await taker.tick(Object.assign(baseEnv("W3"), { FOUNDRY_W3_DEX_LIVE: "yes" }), ledger, NOW, clients, null, null);
    assert.equal(first.learning, false);
    assert.equal(state.box.signs, 1);
    assert.equal(state.box.types[0], "OfferCreate");
    assert.equal(state.box.flags[0], gates.TF_IOC);
    assert.equal(BigInt(state.box.last.TakerGets) >= 100000n && BigInt(state.box.last.TakerGets) <= 250000n, true);
    assert.equal(state.box.last.TakerPays.issuer, rlusd.ISSUER);
    const again = await taker.tick(baseEnv("W3"), ledger, NOW, clients, null, null);
    assert.equal(again.signed, false);
    assert.equal(state.box.signs, 1);

    const blocked = home();
    seed(blocked, mission({ id: "team", kind: "w1-rlusd", role: "W1", outstanding_drops: "3400000", status: "rlusd_filled" }));
    const full = { trust: true, box: { signs: 0, types: [], flags: [] } };
    const stopped = await taker.tick(baseEnv("W3"), blocked, NOW, roleLedger("W3", full), null, null);
    assert.equal(stopped.signed, false);
    assert.equal(full.box.signs, 0);

    const held = home();
    seed(held, mission({ id: "flight", kind: "w1-rlusd", role: "W1", status: "rlusd_unknown", outstanding_drops: "10" }));
    const uncertain = { trust: true, box: { signs: 0, types: [], flags: [] } };
    const paused = await taker.tick(baseEnv("W3"), held, NOW, roleLedger("W3", uncertain), null, null);
    assert.equal(paused.signed, false);
    assert.match(paused.rationale, /uncertain/);
    assert.equal(uncertain.box.signs, 0);
  });

  it("journals fill counterparties and does not call house accounts outside", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "w3-fill-"));
    const hash = "AB".repeat(32);
    seed(ledger, {
      id: "msnfillproof000001",
      idempotency_key: "w3-fill",
      kind: "w3-rlusd",
      role: "W3",
      account: anchors.WALLETS.W3.address,
      hold: "uncertain",
      status: "rlusd_unknown",
      action: "buy",
      signed_hash: hash,
      outstanding_drops: "200000",
      realized_loss_drops: "0",
      submit_attempted: true,
      updated_at: NOW,
    });
    const state = {
      trust: true,
      box: { signs: 0, types: [], flags: [] },
      tx: {
        result: {
          validated: true,
          hash,
          meta: {
            TransactionResult: "tesSUCCESS",
            AffectedNodes: [
              { ModifiedNode: { LedgerEntryType: "Offer", FinalFields: { Account: OUTSIDER }, PreviousFields: {} } },
              { ModifiedNode: { LedgerEntryType: "Offer", FinalFields: { Account: rlusd.AMM }, PreviousFields: {} } },
              { ModifiedNode: { LedgerEntryType: "Offer", FinalFields: { Account: anchors.AMM }, PreviousFields: {} } },
            ].concat(anchors.WALLET_IDS.map((id) => ({
              ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: anchors.WALLETS[id].address }, PreviousFields: {} },
            }))),
          },
        },
      },
    };
    const row = await taker.tick(baseEnv("W3"), ledger, NOW, roleLedger("W3", state), null, journal);
    assert.equal(row.fill_proof.outside_accounts.includes(OUTSIDER), true);
    assert.equal(row.fill_proof.outside_accounts.includes(rlusd.AMM), false);
    assert.equal(row.fill_proof.outside_accounts.includes(anchors.AMM), false);
    for (const id of anchors.WALLET_IDS) {
      assert.equal(row.fill_proof.outside_accounts.includes(anchors.WALLETS[id].address), false);
    }
    assert.equal(row.fill_proof.house_accounts.includes(anchors.WALLETS.W1.address) || row.fill_proof.house_accounts.includes(rlusd.AMM), true);
    const text = fs.readFileSync(path.join(journal, "decisions.jsonl"), "utf8");
    assert.match(text, new RegExp(OUTSIDER));
    assert.equal(/seed|tx_blob/i.test(text), false);
    assert.equal(state.box.signs, 0);
  });

  it("quotes inside the spread and will not replace before 2 hours", async () => {
    const fresh = home();
    const bookSide = spread();
    const state = Object.assign({ trust: true, box: { signs: 0, types: [], flags: [] } }, bookSide);
    const placed = await quoter.tick(baseEnv("W4"), fresh, NOW, roleLedger("W4", state), null, null);
    assert.equal(placed.signed, true);
    assert.equal(placed.learning, false);
    assert.equal(state.box.flags[0], bounds.TF_PASSIVE);
    assert.equal(state.box.signs, 1);
    const bid = quoter.insideBid(
      { xrp: 1000000n, exact: { coeff: 1n, exp: 0 } },
      { xrp: 2000000n, exact: { coeff: 1n, exp: 0 } },
      200000n
    );
    assert.equal(typeof bid.taker_pays.value, "string");
    assert.equal(quoter.insideBid(
      { xrp: 1000000n, exact: { coeff: 1n, exp: 0 } },
      { xrp: 1000000n, exact: { coeff: 1n, exp: 0 } },
      200000n
    ), null);

    const resting = home();
    seed(resting, {
      id: "w4rest",
      kind: "w4-rlusd",
      role: "W4",
      action: "bid",
      status: "rlusd_resting",
      hold: "uncertain",
      sequence: 11,
      quoted_at: "2026-11-13T17:00:00.000Z",
      outstanding_drops: "200012",
      realized_loss_drops: "0",
      unsigned_tx: { TakerGets: "200000", TakerPays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0.15" } },
      updated_at: NOW,
    });
    const quiet = Object.assign({ trust: true, box: { signs: 0, types: [], flags: [] }, offers: [{ seq: 11 }] }, spread());
    const held = await quoter.tick(baseEnv("W4"), resting, NOW, roleLedger("W4", quiet), null, null);
    assert.equal(held.signed, false);
    assert.equal(quiet.box.signs, 0);

    const stale = home();
    seed(stale, {
      id: "w4old",
      kind: "w4-rlusd",
      role: "W4",
      action: "bid",
      status: "rlusd_resting",
      hold: "uncertain",
      sequence: 12,
      quoted_at: "2026-11-13T12:00:00.000Z",
      outstanding_drops: "200012",
      realized_loss_drops: "0",
      unsigned_tx: { TakerGets: "200000" },
      updated_at: "2026-11-13T12:00:00.000Z",
    });
    const old = Object.assign({ trust: true, box: { signs: 0, types: [], flags: [] }, offers: [{ seq: 12 }] }, spread());
    const cancelled = await quoter.tick(baseEnv("W4"), stale, NOW, roleLedger("W4", old), null, null);
    assert.equal(cancelled.decision, "cancel");
    assert.equal(cancelled.signed, true);
    assert.equal(old.box.types[0], "OfferCancel");
    assert.equal(old.box.signs, 1);
    const replaced = await quoter.tick(baseEnv("W4"), stale, NOW, roleLedger("W4", Object.assign({ trust: true, box: { signs: 0, types: [], flags: [] }, offers: [] }, spread())), null, null);
    assert.equal(replaced.decision, "place");
    assert.equal(replaced.signed, true);
    assert.equal(replaced.flags, bounds.TF_PASSIVE);
    const open = exposure.rows(view(stale, NOW)).filter((mission) => mission.role === "W4" && mission.hold !== "released" && (mission.action === "bid" || mission.action === "ask"));
    assert.equal(open.length, 1);
  });

  it("sells only the RLUSD the taker bought", async () => {
    const ledger = home();
    seed(ledger, {
      id: "msnbuyroundtrip01",
      idempotency_key: "w3-bought",
      kind: "w3-rlusd",
      role: "W3",
      action: "buy",
      status: "rlusd_filled",
      hold: "uncertain",
      outstanding_drops: "200012",
      bought_rlusd: "0.05",
      proof_result: "tesSUCCESS",
      proof_type: "consuming_tx",
      proof_hash: "AB".repeat(32),
      cost_basis_drops: "100000",
      realized_loss_drops: "0",
      submit_attempted: true,
      chicago_day: "2026-11-13",
      updated_at: NOW,
    });
    const state = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [], last: null } };
    const sold = await taker.tick(baseEnv("W3"), ledger, NOW, roleLedger("W3", state), { headroom: 100000000n }, null);
    assert.equal(sold.signed, true);
    assert.equal(state.box.last.Flags, gates.TF_IOC);
    assert.equal(state.box.last.TakerGets.value, "0.05");
    assert.equal(state.box.last.TakerGets.issuer, rlusd.ISSUER);
    const bare = home();
    seed(bare, {
      id: "msnbuyunproved01",
      idempotency_key: "w3-unproved",
      kind: "w3-rlusd",
      role: "W3",
      action: "buy",
      status: "rlusd_filled",
      hold: "uncertain",
      outstanding_drops: "200012",
      realized_loss_drops: "0",
      submit_attempted: true,
      chicago_day: "2026-11-13",
      updated_at: NOW,
    });
    const quiet = { trust: true, balance: "5", box: { signs: 0, types: [], flags: [] } };
    const skipped = await taker.tick(baseEnv("W3"), bare, NOW, roleLedger("W3", quiet), { headroom: 100000000n }, null);
    assert.equal(skipped.signed, false);
    assert.equal(quiet.box.signs, 0);
  });

  it("lets W1 use the 3.5 XRP team room without raising its own 2 XRP cap", async () => {
    const open = home();
    seed(open, mission({ id: "other", kind: "w4-rlusd", role: "W4", outstanding_drops: "1500000", status: "rlusd_filled" }));
    const box = { signs: 0, types: [], flags: [] };
    const bought = await rlusd.tick(Object.assign(baseEnv("W1"), { FOUNDRY_DEX_RLUSD: "yes" }), open, NOW, w1Client(box), { proved_xrp: 0n, reserve_inc: 200000n });
    assert.equal(bought.signed, true);
    assert.equal(bought.learning, false);
    assert.equal(box.signs, 1);
    const tight = home();
    seed(tight, mission({ id: "other", kind: "w3-rlusd", role: "W3", outstanding_drops: "3300000", status: "rlusd_filled" }));
    const quiet = { signs: 0, types: [], flags: [] };
    const skipped = await rlusd.tick(baseEnv("W1"), tight, NOW, w1Client(quiet), { proved_xrp: 0n, reserve_inc: 200000n });
    assert.equal(skipped.signed === true, false);
    assert.equal(quiet.signs, 0);
  });
});

describe("W3 fill acquisition", () => {
  const HASH = "BDBC06FE6CB57A1869029CE9DA4A4CE5C6C1C82D5004B6CEAFCEDFEA6D949EB1";
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/w3-ioc-buy-22299209.json"), "utf8"));

  function line(balance, prev, high, low, currency) {
    const code = currency || rlusd.CURRENCY;
    return {
      ModifiedNode: {
        LedgerEntryType: "RippleState",
        FinalFields: {
          Balance: { currency: code, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: balance },
          HighLimit: { currency: code, issuer: high, value: "0" },
          LowLimit: { currency: code, issuer: low, value: "10" },
        },
        PreviousFields: { Balance: { currency: code, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: prev } },
      },
    };
  }

  it("reads 0.01476733 RLUSD from the live IOC buy metadata", () => {
    const w3 = anchors.WALLETS.W3.address;
    assert.equal(book.rlusdAcquired(fixture.meta, w3), fixture.acquired);
    assert.equal(fixture.acquired.startsWith("0.01476733"), true);
    assert.equal(book.rlusdAcquired(fixture.meta, anchors.WALLETS.W0.address), null);
    assert.equal(book.rlusdAcquired(fixture.meta, anchors.WALLETS.W4.address), null);
    assert.equal(book.rlusdAcquired(fixture.meta, rlusd.AMM), "0");
    assert.equal(book.rlusdAcquired(fixture.meta, rlusd.ISSUER), null);
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("-0.01476733409826197", "0", w3, rlusd.ISSUER)],
    }, w3), fixture.acquired);
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("-0.1", "-0.5", w3, rlusd.ISSUER)],
    }, w3), "0");
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("0.2", "0", w3, rlusd.ISSUER)],
    }, w3), "0");
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("0.2", "0.5", rlusd.ISSUER, w3)],
    }, w3), "0");
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("0.1", "-0.4", rlusd.ISSUER, w3)],
    }, w3), "0.1");
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("0.2", "0", rlusd.ISSUER, w3), line("0.2", "0", rlusd.ISSUER, w3)],
    }, w3), null);
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("0.005", "0", rlusd.ISSUER, w3), fixture.meta.AffectedNodes[2]],
    }, w3), "0.005");
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("1", "0", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", w3)],
    }, w3), null);
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [line("1", "0", rlusd.ISSUER, w3, "USD")],
    }, w3), null);
    assert.equal(book.rlusdAcquired({
      AffectedNodes: [{
        ModifiedNode: {
          LedgerEntryType: "RippleState",
          FinalFields: {
            Balance: fixture.acquired,
            HighLimit: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0" },
            LowLimit: { currency: rlusd.CURRENCY, issuer: w3, value: "10" },
          },
          PreviousFields: { Balance: "0" },
        },
      }],
    }, w3), fixture.acquired);
    assert.equal(book.atMost(fixture.acquired, fixture.acquired), fixture.acquired);
    assert.equal(book.atMost("1", "0.01"), "0.01");
    assert.equal(book.atMost("0.005", fixture.acquired), "0.005");
    const lookalike = {
      AffectedNodes: [{
        ModifiedNode: {
          LedgerEntryType: "RippleState",
          FinalFields: {
            Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "1" },
            HighLimit: { currency: rlusd.CURRENCY, issuer: "rKmPxqLookalikeIssuerXXXXXXXX", value: "0" },
            LowLimit: { currency: rlusd.CURRENCY, issuer: anchors.WALLETS.W3.address, value: "10" },
          },
          PreviousFields: { Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "0" } },
        },
      }],
    };
    assert.equal(book.rlusdAcquired(lookalike, anchors.WALLETS.W3.address), null);
    const created = {
      AffectedNodes: [{
        CreatedNode: {
          LedgerEntryType: "RippleState",
          NewFields: {
            Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "0.2" },
            HighLimit: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0" },
            LowLimit: { currency: rlusd.CURRENCY, issuer: anchors.WALLETS.W3.address, value: "10" },
          },
        },
      }],
    };
    assert.equal(book.rlusdAcquired(created, anchors.WALLETS.W3.address), "0.2");
    const deleted = {
      AffectedNodes: [{
        DeletedNode: {
          LedgerEntryType: "RippleState",
          FinalFields: {
            Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "0.2" },
            HighLimit: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0" },
            LowLimit: { currency: rlusd.CURRENCY, issuer: anchors.WALLETS.W3.address, value: "10" },
          },
          PreviousFields: { Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "0.5" } },
        },
      }],
    };
    assert.equal(book.rlusdAcquired(deleted, anchors.WALLETS.W3.address), "0");
    const deletedDebt = {
      AffectedNodes: [{
        DeletedNode: {
          LedgerEntryType: "RippleState",
          FinalFields: {
            Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "0" },
            HighLimit: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: "0" },
            LowLimit: { currency: rlusd.CURRENCY, issuer: anchors.WALLETS.W3.address, value: "10" },
          },
          PreviousFields: { Balance: { currency: rlusd.CURRENCY, issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji", value: "-0.4" } },
        },
      }],
    };
    assert.equal(book.rlusdAcquired(deletedDebt, anchors.WALLETS.W3.address), "0");
  });

  function provenBuy(extra) {
    return Object.assign({
      id: "msna9cb1105fdf57c75",
      kind: "w3-rlusd",
      role: "W3",
      action: "buy",
      account: anchors.WALLETS.W3.address,
      hold: "uncertain",
      status: "rlusd_filled",
      bought_rlusd: "0",
      proof_hash: HASH,
      proof_result: "tesSUCCESS",
      signed_hash: HASH,
      sequence: 21093764,
      outstanding_drops: "200010",
      realized_loss_drops: "0",
      submit_attempted: true,
      updated_at: NOW,
    }, extra || {});
  }

  function buyResult(patch) {
    const result = JSON.parse(JSON.stringify(Object.assign({
      validated: true,
      hash: HASH,
      ledger_index: fixture.ledger_index,
    }, fixture)));
    return patch ? patch(result) : result;
  }

  async function replay(mission, result, extra) {
    const ledger = home();
    seed(ledger, mission);
    seed(ledger, {
      id: exposure.LEGACY_HOLD,
      kind: "w3-rlusd",
      role: "W3",
      action: "buy",
      account: anchors.WALLETS.W3.address,
      hold: "uncertain",
      signed: true,
      status: "rlusd_filled",
      bought_rlusd: "0",
      proof_hash: HASH,
      signed_hash: HASH,
      sequence: 21093764,
      outstanding_drops: "1747",
      updated_at: "2026-11-01T00:00:00.000Z",
    });
    const state = Object.assign({
      trust: true,
      balance: "0.01",
      box: { signs: 0, types: [], flags: [] },
      amm: { amount: "20000000", value: "1", trading_fee: 0 },
      tx: { result },
    }, extra || {});
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "w3-reprove-"));
    let row;
    try {
      row = await taker.tick(baseEnv("W3"), ledger, extra && extra.now || NOW, roleLedger("W3", state), { headroom: 100000000n }, journal);
    } catch (error) {
      row = error;
    }
    const saved = view(ledger, extra && extra.now || NOW).missions.msna9cb1105fdf57c75;
    const legacy = view(ledger, extra && extra.now || NOW).missions[exposure.LEGACY_HOLD];
    const text = `${JSON.stringify(saved || {})}${JSON.stringify(legacy || {})}${fs.existsSync(path.join(journal, "decisions.jsonl")) ? fs.readFileSync(path.join(journal, "decisions.jsonl"), "utf8") : ""}`;
    assert.equal(/seed|secret|tx_blob|private/i.test(text), false);
    assert.equal(legacy.hold, "uncertain");
    assert.equal(legacy.signed, true);
    assert.equal(legacy.outstanding_drops, "1747");
    assert.equal(legacy.bought_rlusd, "0");
    return { row, saved, state, ledger };
  }

  it("re-proves a zero acquire from the validated buy and sells the smaller official amount", async () => {
    const { row, saved, state } = await replay(provenBuy(), buyResult());
    assert.equal(saved.bought_rlusd, "0.01");
    assert.equal(saved.cost_basis_drops, "81261");
    assert.notEqual(saved.cost_basis_drops, "200000");
    assert.equal(saved.hold, "uncertain");
    assert.equal(saved.id, "msna9cb1105fdf57c75");
    assert.equal(saved.sequence, 21093764);
    assert.equal(row.signed, true);
    assert.equal(state.box.flags[0], gates.TF_IOC);
    assert.equal(state.box.last.Destination, undefined);
    assert.equal(state.box.last.TakerGets.issuer, rlusd.ISSUER);
    assert.equal(state.box.last.TakerGets.currency, rlusd.CURRENCY);
    assert.equal(state.box.last.TakerGets.value, "0.01");
    assert.equal(JSON.stringify(state.box.last).includes("rKmPxq"), false);
    const pays = BigInt(state.box.last.TakerPays);
    assert.equal(pays >= 100000n && pays <= 250000n, true);
  });

  it("refuses a re-proof that is not the validated sequenced buy", async () => {
    const refused = [
      () => buyResult((result) => { result.validated = false; return result; }),
      () => buyResult((result) => { result.meta.TransactionResult = "tecPATH_DRY"; return result; }),
      () => buyResult((result) => { result.hash = "AB".repeat(32); return result; }),
      () => buyResult((result) => { result.tx_json.Sequence = 21093765; return result; }),
      () => buyResult((result) => { result.tx_json.Account = anchors.WALLETS.W0.address; return result; }),
      () => buyResult((result) => { result.tx_json.NetworkID = 0; return result; }),
      () => buyResult((result) => { result.tx_json.Flags = 0; return result; }),
      () => buyResult((result) => { result.tx_json.TakerPays.issuer = "rKmPxqLookalikeIssuerXXXXXXXX"; return result; }),
    ];
    for (const build of refused) {
      const { row, saved, state } = await replay(provenBuy(), build());
      assert.equal(saved.bought_rlusd, "0");
      assert.equal(saved.hold, "uncertain");
      assert.equal(saved.outstanding_drops, "200010");
      assert.equal(row.signed, false);
      assert.equal(state.box.signs, 0);
    }
    const missing = await replay(provenBuy({ sequence: undefined }), buyResult());
    assert.equal(missing.saved.bought_rlusd, "0");
    assert.equal(missing.saved.outstanding_drops, "200010");
    assert.equal(missing.state.box.signs, 0);
    const mismatched = await replay(provenBuy({ proof_hash: "CD".repeat(32) }), buyResult());
    assert.equal(mismatched.saved.bought_rlusd, "0");
    assert.equal(mismatched.state.box.signs, 0);
    const later = await replay(provenBuy({ sequence: undefined }), buyResult(), { now: "2026-12-01T00:00:00.000Z" });
    assert.equal(later.saved.bought_rlusd, "0");
    assert.equal(later.saved.hold, "uncertain");
    assert.equal(later.saved.outstanding_drops, "200010");
    assert.equal(later.state.box.signs, 0);
  });

  it("caps the booked fill at the offer and sells that partial official amount", async () => {
    const w3 = anchors.WALLETS.W3.address;
    const partial = buyResult((result) => {
      result.meta.AffectedNodes[0].ModifiedNode.FinalFields.Balance.value = "0.01";
      result.tx_json.TakerPays.value = fixture.acquired;
      return result;
    });
    const filled = await replay(provenBuy(), partial, { balance: "5" });
    assert.equal(filled.saved.bought_rlusd, "0.01");
    assert.notEqual(filled.saved.bought_rlusd, fixture.acquired);
    assert.equal(filled.state.box.last.TakerGets.value, "0.01");
    assert.equal(filled.state.box.last.TakerGets.issuer, rlusd.ISSUER);
    assert.equal(filled.state.box.flags[0], gates.TF_IOC);
    const dust = buyResult((result) => {
      result.meta.AffectedNodes[0].ModifiedNode.FinalFields.Balance.value = "0.005";
      result.tx_json.TakerPays.value = fixture.acquired;
      return result;
    });
    const undersized = await replay(provenBuy(), dust, { balance: "5" });
    assert.equal(undersized.saved.bought_rlusd, "0.005");
    assert.equal(undersized.state.box.signs, 0);
    const spiked = buyResult((result) => {
      result.meta.AffectedNodes[0].ModifiedNode.FinalFields.Balance.value = "1";
      result.tx_json.TakerPays.value = "0.01";
      return result;
    });
    const capped = await replay(provenBuy(), spiked, { balance: "5" });
    assert.equal(capped.saved.bought_rlusd, "0.01");
    assert.equal(capped.state.box.last.TakerGets.value, "0.01");
    assert.notEqual(capped.state.box.last.TakerGets.value, "1");
    assert.equal(capped.state.box.last.Account, w3);
    const pays = BigInt(capped.state.box.last.TakerPays);
    assert.equal(pays >= 100000n && pays <= 250000n, true);
  });

  it("does not sell a re-proved fill through a full team cap or the wrong network", async () => {
    const ledger = home();
    seed(ledger, provenBuy());
    seed(ledger, mission({ id: "w1full", kind: "w1-rlusd", role: "W1", outstanding_drops: "3500000", status: "rlusd_filled" }));
    const state = {
      trust: true,
      balance: "0.01",
      box: { signs: 0, types: [], flags: [] },
      amm: { amount: "20000000", value: "1", trading_fee: 0 },
      tx: { result: buyResult() },
    };
    const row = await taker.tick(baseEnv("W3"), ledger, NOW, roleLedger("W3", state), { headroom: 100000000n }, null);
    const saved = view(ledger, NOW).missions.msna9cb1105fdf57c75;
    assert.equal(saved.bought_rlusd, "0.01");
    assert.equal(saved.cost_basis_drops, "81261");
    assert.equal(saved.outstanding_drops, "81261");
    assert.equal(row.signed, false);
    assert.equal(state.box.signs, 0);
    assert.equal(exposure.teamOpen(view(ledger, NOW)) > 3500000n, true);
    const wrongNet = home();
    seed(wrongNet, provenBuy());
    await assert.rejects(() => taker.tick(baseEnv("W3"), wrongNet, NOW, roleLedger("W3", {
      trust: true,
      balance: "0.01",
      networkId: 0,
      box: { signs: 0, types: [], flags: [] },
      tx: { result: buyResult() },
    }), { headroom: 100000000n }, null), (error) => error.code === "MAINNET");
    assert.equal(view(wrongNet, NOW).missions.msna9cb1105fdf57c75.bought_rlusd, "0");
    assert.equal(view(wrongNet, NOW).missions.msna9cb1105fdf57c75.outstanding_drops, "200010");
  });
});

describe("trust line proof", () => {
  const HASH = "CD".repeat(32);

  function trustTx(account, issuer) {
    return {
      result: {
        validated: true,
        hash: HASH,
        ledger_index: 3210,
        tx_json: {
          TransactionType: "TrustSet",
          Account: account,
          Sequence: 9,
          Fee: "10",
          LimitAmount: { currency: rlusd.CURRENCY, issuer, value: "10" },
        },
        meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [] },
      },
    };
  }

  it("proves a W4 trust line from tesSUCCESS and does not release it on a clock", async () => {
    const ledger = home();
    seed(ledger, {
      id: "msnde18ca1a9d441a55",
      idempotency_key: "w4-rlusd-trust",
      kind: "w4-rlusd",
      role: "W4",
      action: "trust",
      account: anchors.WALLETS.W4.address,
      hold: "uncertain",
      status: "rlusd_unknown",
      signed_hash: HASH,
      sequence: 9,
      outstanding_drops: "200010",
      realized_loss_drops: "0",
      submit_attempted: true,
      updated_at: "2026-11-13T12:00:00.000Z",
    });
    seed(ledger, { id: exposure.LEGACY_HOLD, hold: "uncertain", signed: true, outstanding_drops: "1747", updated_at: "2026-11-13T12:00:00.000Z" });
    assert.equal(exposure.blocksNewRisk(view(ledger, NOW), "W1"), true);
    const state = { trust: true, box: { signs: 0, types: [], flags: [] }, tx: trustTx(anchors.WALLETS.W4.address, rlusd.ISSUER) };
    const proved = await quoter.tick(baseEnv("W4"), ledger, NOW, roleLedger("W4", state), null, null);
    assert.equal(proved.status, "rlusd_proved");
    assert.equal(proved.signed, false);
    assert.equal(state.box.signs, 0);
    const saved = view(ledger, NOW).missions.msnde18ca1a9d441a55;
    assert.equal(saved.status, "rlusd_proved");
    assert.equal(saved.hold, "uncertain");
    assert.equal(saved.outstanding_drops, "0");
    assert.equal(saved.proof_result, "tesSUCCESS");
    assert.equal(exposure.blocksNewRisk(view(ledger, NOW), "W1"), false);
    const legacy = view(ledger, NOW).missions[exposure.LEGACY_HOLD];
    assert.equal(legacy.hold, "uncertain");
    assert.equal(legacy.signed, true);
    assert.equal(legacy.outstanding_drops, "1747");
    const later = await quoter.tick(baseEnv("W4"), ledger, "2026-11-14T18:00:00.000Z", roleLedger("W4", { trust: true, box: { signs: 0, types: [], flags: [] }, bids: [], asks: [] }), null, null);
    const still = view(ledger, "2026-11-14T18:00:00.000Z").missions.msnde18ca1a9d441a55;
    assert.equal(still.hold, "uncertain");
    assert.equal(still.status, "rlusd_proved");
    assert.notEqual(later.status, "rlusd_cancelled");

    const stuck = home();
    seed(stuck, {
      id: "w4unproved",
      kind: "w4-rlusd",
      role: "W4",
      action: "trust",
      account: anchors.WALLETS.W4.address,
      hold: "uncertain",
      status: "rlusd_unknown",
      signed_hash: HASH,
      sequence: 9,
      outstanding_drops: "200010",
      realized_loss_drops: "0",
      updated_at: "2026-11-01T00:00:00.000Z",
    });
    const refused = await quoter.tick(baseEnv("W4"), stuck, NOW, roleLedger("W4", {
      trust: true,
      box: { signs: 0, types: [], flags: [] },
      tx: trustTx(anchors.WALLETS.W4.address, "rKmPxqLookalikeIssuerXXXXXXXX"),
    }), null, null);
    assert.equal(refused.signed, false);
    const open = view(stuck, NOW).missions.w4unproved;
    assert.equal(open.status, "rlusd_unknown");
    assert.equal(open.hold, "uncertain");
    assert.equal(open.outstanding_drops, "200010");

    const missing = home();
    seed(missing, {
      id: "w4missing",
      kind: "w4-rlusd",
      role: "W4",
      action: "trust",
      account: anchors.WALLETS.W4.address,
      hold: "uncertain",
      status: "rlusd_unknown",
      signed_hash: HASH,
      sequence: 9,
      outstanding_drops: "200010",
      realized_loss_drops: "0",
      updated_at: "2026-11-01T00:00:00.000Z",
    });
    const noHash = trustTx(anchors.WALLETS.W4.address, rlusd.ISSUER);
    delete noHash.result.hash;
    await quoter.tick(baseEnv("W4"), missing, NOW, roleLedger("W4", { trust: true, box: { signs: 0, types: [], flags: [] }, tx: noHash }), null, null);
    const failedTx = trustTx(anchors.WALLETS.W4.address, rlusd.ISSUER);
    failedTx.result.meta.TransactionResult = "tecUNFUNDED";
    await quoter.tick(baseEnv("W4"), missing, "2026-11-20T00:00:00.000Z", roleLedger("W4", { trust: true, box: { signs: 0, types: [], flags: [] }, tx: failedTx }), null, null);
    const wrongAccount = trustTx(anchors.WALLETS.W1.address, rlusd.ISSUER);
    await quoter.tick(baseEnv("W4"), missing, "2026-11-21T00:00:00.000Z", roleLedger("W4", { trust: true, box: { signs: 0, types: [], flags: [] }, tx: wrongAccount }), null, null);
    await quoter.tick(baseEnv("W4"), missing, "2026-11-22T00:00:00.000Z", roleLedger("W4", { trust: true, box: { signs: 0, types: [], flags: [] } }), null, null);
    const held = view(missing, "2026-11-22T00:00:00.000Z").missions.w4missing;
    assert.equal(held.status, "rlusd_unknown");
    assert.equal(held.hold, "uncertain");
    assert.equal(held.outstanding_drops, "200010");
    const wrongSeq = trustTx(anchors.WALLETS.W4.address, rlusd.ISSUER);
    wrongSeq.result.tx_json.Sequence = 8;
    wrongSeq.result.ledger_index = null;
    assert.equal(book.trustSettled(noHash.result, { signed_hash: HASH, sequence: 9 }, anchors.WALLETS.W4.address), null);
    assert.equal(book.trustSettled(failedTx.result, { signed_hash: HASH, sequence: 9 }, anchors.WALLETS.W4.address), null);
    assert.equal(book.trustSettled(wrongSeq.result, { signed_hash: HASH, sequence: 9 }, anchors.WALLETS.W4.address), null);
    await assert.rejects(() => quoter.tick(baseEnv("W4"), missing, NOW, roleLedger("W4", { trust: true, networkId: 0, box: { signs: 0, types: [], flags: [] }, tx: trustTx(anchors.WALLETS.W4.address, rlusd.ISSUER) }), null, null), (error) => error.code === "MAINNET");
    assert.equal(view(missing, NOW).missions.w4missing.outstanding_drops, "200010");
    assert.equal(await quoter.tick(Object.assign(baseEnv("W4"), { FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W0.address }), missing, NOW, roleLedger("W4", { trust: true, box: { signs: 0, types: [], flags: [] } }), null, null), null);
    assert.equal(view(missing, NOW).missions.w4missing.status, "rlusd_unknown");
  });

  it("books a W3 trust line as proved rather than filled", async () => {
    const ledger = home();
    seed(ledger, {
      id: "w3trust",
      kind: "w3-rlusd",
      role: "W3",
      action: "trust",
      account: anchors.WALLETS.W3.address,
      hold: "uncertain",
      status: "rlusd_unknown",
      signed_hash: HASH,
      sequence: 9,
      outstanding_drops: "200012",
      realized_loss_drops: "0",
      submit_attempted: true,
      updated_at: NOW,
    });
    const state = { trust: true, box: { signs: 0, types: [], flags: [] }, tx: trustTx(anchors.WALLETS.W3.address, rlusd.ISSUER) };
    const row = await taker.tick(baseEnv("W3"), ledger, NOW, roleLedger("W3", state), null, null);
    assert.equal(row.status, "rlusd_proved");
    const saved = view(ledger, NOW).missions.w3trust;
    assert.equal(saved.status, "rlusd_proved");
    assert.equal(saved.hold, "uncertain");
    assert.equal(saved.outstanding_drops, "0");
    assert.equal(exposure.roleOpen(view(ledger, NOW), "W3"), 0n);
    assert.equal(state.box.signs, 0);
  });

  it("migrates a W3 trust line already booked filled", async () => {
    const ledger = home();
    seed(ledger, {
      id: "w3filled",
      kind: "w3-rlusd",
      role: "W3",
      action: "trust",
      account: anchors.WALLETS.W3.address,
      hold: "uncertain",
      status: "rlusd_filled",
      signed_hash: HASH,
      sequence: 9,
      outstanding_drops: "200012",
      fee_drops: "12",
      realized_loss_drops: "0",
      outside_fill: true,
      proof_type: "consuming_tx",
      submit_attempted: true,
      updated_at: "2026-11-01T00:00:00.000Z",
    });
    seed(ledger, { id: exposure.LEGACY_HOLD, hold: "uncertain", signed: true, outstanding_drops: "1747", updated_at: "2026-11-01T00:00:00.000Z" });
    const quiet = await taker.tick(baseEnv("W3"), ledger, NOW, roleLedger("W3", { trust: true, box: { signs: 0, types: [], flags: [] } }), null, null);
    assert.equal(quiet.signed, false);
    const waiting = view(ledger, NOW).missions.w3filled;
    assert.equal(waiting.status, "rlusd_filled");
    assert.equal(waiting.hold, "uncertain");
    assert.equal(waiting.outstanding_drops, "200012");
    const later = await taker.tick(baseEnv("W3"), ledger, "2026-11-20T00:00:00.000Z", roleLedger("W3", { trust: true, box: { signs: 0, types: [], flags: [] } }), null, null);
    assert.notEqual(later.status, "rlusd_proved");
    assert.equal(view(ledger, "2026-11-20T00:00:00.000Z").missions.w3filled.outstanding_drops, "200012");
    const provedTx = trustTx(anchors.WALLETS.W3.address, rlusd.ISSUER);
    provedTx.result.meta.AffectedNodes = [
      { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: OUTSIDER } } },
    ];
    const row = await taker.tick(baseEnv("W3"), ledger, "2026-11-20T01:00:00.000Z", roleLedger("W3", { trust: true, box: { signs: 0, types: [], flags: [] }, tx: provedTx }), null, null);
    assert.equal(row.status, "rlusd_proved");
    const saved = view(ledger, "2026-11-20T01:00:00.000Z").missions.w3filled;
    assert.equal(saved.status, "rlusd_proved");
    assert.equal(saved.hold, "uncertain");
    assert.equal(saved.outstanding_drops, "0");
    assert.equal(saved.outside_fill, false);
    assert.equal(saved.proof_type, "trust_set");
    assert.equal(exposure.roleOpen(view(ledger, "2026-11-20T01:00:00.000Z"), "W3"), 0n);
    const legacy = view(ledger, "2026-11-20T01:00:00.000Z").missions[exposure.LEGACY_HOLD];
    assert.equal(legacy.hold, "uncertain");
    assert.equal(legacy.signed, true);
    assert.equal(legacy.outstanding_drops, "1747");
  });
});

describe("W5 oracle", () => {
  it("dry-runs the official RLUSD price every 30 minutes and does not read a key", async () => {
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "w5-oracle-"));
    let reads = 0;
    const pool = { xrp: 10000000000n, exact: { coeff: 4000n, exp: 0 }, tradingFee: 500, network_id: 1 };
    const row = await oracle.tick({}, {
      now: NOW,
      journal,
      pool,
      deps: { readAccount() { reads += 1; throw new Error("key"); } },
    }, null);
    assert.equal(row.dry_run, true);
    assert.equal(row.signed, false);
    assert.equal(row.key_loaded, false);
    assert.equal(row.learning, false);
    assert.equal(row.fee_only, true);
    assert.equal(row.tx.Account, anchors.WALLETS.W5.address);
    assert.equal(row.tx.TransactionType, "OracleSet");
    assert.equal(row.tx.OracleDocumentID, 2);
    assert.equal(row.tx.Amount, undefined);
    assert.equal(row.quote_xrp_per_rlusd, "2.5");
    assert.equal(row.tx.PriceDataSeries[0].PriceData.Scale, 8);
    assert.equal(row.tx.PriceDataSeries[0].PriceData.AssetPrice, math.encodeQuote("2.5").asset_price_hex);
    assert.equal(row.tx.LastUpdateTime, math.unixSeconds(NOW));
    assert.equal(row.tx.PriceDataSeries[0].PriceData.BaseAsset, rlusd.CURRENCY);
    assert.equal(row.tx.PriceDataSeries[0].PriceData.QuoteAsset, "XRP");
    const liveJournal = fs.mkdtempSync(path.join(os.tmpdir(), "w5-live-"));
    const liveBox = { signs: 0, types: [], flags: [] };
    const liveEnv = {
      FOUNDRY_W5_ORACLE_LIVE: "yes",
      FOUNDRY_DEX_EXECUTE: "yes",
      FOUNDRY_DEX_NETWORK: "xrpl:1",
      FOUNDRY_DEX_AXELAR_DROPS: "0",
      FOUNDRY_W5_ORACLE_ACTIVATE: oracle.PHRASE,
    };
    const posted = await oracle.tick(liveEnv, { now: new Date().toISOString(), journal: liveJournal }, roleLedger("W5", { trust: true, box: liveBox }));
    assert.equal(posted.dry_run, false);
    assert.equal(posted.signed, true);
    assert.equal(posted.tx.Fee, "12");
    assert.equal(posted.tx.Sequence, 20);
    assert.equal(posted.tx.OracleDocumentID, 2);
    assert.equal(liveBox.signs, 1);
    const again = await oracle.tick(liveEnv, { now: new Date().toISOString(), journal: liveJournal }, roleLedger("W5", { trust: true, box: { signs: 0, types: [], flags: [] } }));
    assert.equal(again.decision, "research");
    assert.equal(again.signed, false);
    assert.equal(reads, 0);
    const soon = await oracle.tick({}, { now: "2026-11-13T18:20:00.000Z", journal, pool }, null);
    assert.equal(soon.decision, "dry-run");
    assert.equal(soon.dry_run, true);
    await assert.rejects(() => oracle.tick({}, { now: "2026-11-13T20:00:00.000Z", pool: Object.assign({}, pool, { network_id: 0 }) }, null), (error) => error.code === "MAINNET");
    assert.equal(health(Object.assign(baseEnv("W3"), { FOUNDRY_W3_DEX_SUPERVISOR: "yes" })).role, "w3-dex-supervisor");
    assert.equal(health(baseEnv("W1")).role, "w1-dex-supervisor");
    const decided = await decide(Object.assign(baseEnv("W3"), { FOUNDRY_W3_DEX_LIVE: "yes" }), {
      now: NOW,
      journal: fs.mkdtempSync(path.join(os.tmpdir(), "w3-journal-")),
      ledger: home(),
    }, roleLedger("W3", { trust: true, box: { signs: 0, types: [], flags: [] } }));
    assert.equal(decided.learning, false);
    assert.equal(decided.role, "W3");
    const failed = fs.mkdtempSync(path.join(os.tmpdir(), "w5-fail-"));
    const lines = [];
    await assert.rejects(() => oracle.tick({
      FOUNDRY_W5_ORACLE_LIVE: "yes",
      FOUNDRY_DEX_EXECUTE: "yes",
      FOUNDRY_DEX_NETWORK: "xrpl:1",
      FOUNDRY_DEX_AXELAR_DROPS: "0",
      FOUNDRY_W5_ORACLE_ACTIVATE: oracle.PHRASE,
    }, { now: new Date().toISOString(), journal: failed }, {
      sign: async () => ({ tx_blob: "00", hash: "AB".repeat(32) }),
      submit: async () => { throw Object.assign(new Error("submit failed seed sEd11111111111111111111"), { code: "SUBMIT" }); },
      ledger: roleLedger("W5", { trust: true, box: { signs: 0, types: [], flags: [] } }).ledger,
    }), (error) => error.code === "SIGNER" || error.code === "TX" || error.code === "SUBMIT");
    assert.equal(oracle.tooSoon(failed, new Date().toISOString()), false);
    const logged = oracle.reportFailure(Object.assign(new Error("seed sEd11111111111111111111 tx_blob AAAA"), { code: "SUBMIT" }), failed, (line) => lines.push(line));
    assert.equal(logged.attempted, false);
    assert.equal(logged.submitted, false);
    const text = `${lines.join("")}${fs.readFileSync(path.join(failed, "decisions.jsonl"), "utf8")}`;
    assert.equal(text.includes("sEd"), false);
    assert.equal(text.includes("tx_blob"), false);
    assert.equal(oracle.tooSoon(failed, new Date().toISOString()), false);
    const crashed = fs.mkdtempSync(path.join(os.tmpdir(), "w5-crash-"));
    const crashNow = new Date().toISOString();
    let submits = 0;
    const crashEnv = {
      FOUNDRY_W5_ORACLE_LIVE: "yes",
      FOUNDRY_DEX_EXECUTE: "yes",
      FOUNDRY_DEX_NETWORK: "xrpl:1",
      FOUNDRY_DEX_AXELAR_DROPS: "0",
      FOUNDRY_W5_ORACLE_ACTIVATE: oracle.PHRASE,
    };
    const clients = roleLedger("W5", { trust: true, box: { signs: 0, types: [], flags: [] } });
    clients.submit = async () => {
      submits += 1;
      const prior = fs.readFileSync(path.join(crashed, "decisions.jsonl"), "utf8");
      assert.equal(prior.includes("\"attempted\":true"), true);
      assert.equal(prior.includes("sEd"), false);
      assert.equal(prior.includes("tx_blob"), false);
      throw Object.assign(new Error("crash after submit seed sEd11111111111111111111 tx_blob FFFF"), { code: "SUBMIT" });
    };
    await assert.rejects(() => oracle.tick(crashEnv, { now: crashNow, journal: crashed }, clients), (error) => error.code === "SUBMIT");
    assert.equal(submits, 1);
    assert.equal(oracle.tooSoon(crashed, crashNow), true);
    const blocked = await oracle.tick(crashEnv, { now: crashNow, journal: crashed }, clients);
    assert.equal(blocked.decision, "research");
    assert.equal(blocked.signed, false);
    assert.equal(submits, 1);
    const crashText = fs.readFileSync(path.join(crashed, "decisions.jsonl"), "utf8");
    assert.equal(crashText.includes("sEd"), false);
    assert.equal(crashText.includes("tx_blob"), false);
    assert.equal(crashText.includes("FFFF"), false);
    fs.appendFileSync(path.join(crashed, "decisions.jsonl"), "{\"decision\":\"publish\",\"attempted\":true");
    assert.equal(oracle.tooSoon(crashed, crashNow), true);
    const unjournaled = roleLedger("W5", { trust: true, box: { signs: 0, types: [], flags: [] } });
    let bareSubmits = 0;
    unjournaled.submit = async () => { bareSubmits += 1; };
    await assert.rejects(() => oracle.tick(crashEnv, { now: crashNow }, unjournaled), (error) => error.code === "JOURNAL");
    assert.equal(bareSubmits, 0);
  });
});
