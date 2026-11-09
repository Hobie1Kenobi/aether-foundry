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
const { PERMANENT_HOLD } = require("../capabilities");
const bounds = require("./bounds");
const { connectLive } = require("./live");
const { decide, readJournal } = require("./director");
const { health, main } = require("./supervisor");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-08T18:00:00.000Z";
const AETH = { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "1" };

function home() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "dex-ledger-"));
  control(ledger, { action: "activate", confirm: missionConfig.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
    JSON.stringify({ type: "mission.upsert", at: NOW, mission: { id: PERMANENT_HOLD, hold: "uncertain", signed: true, updated_at: NOW } }),
    JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: PERMANENT_HOLD, day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747" } }),
    JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: PERMANENT_HOLD, day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
  ].join("\n")}\n`);
  return ledger;
}

function roleEnv(extra) {
  return Object.assign({
    FOUNDRY_DEX_EXECUTE: "yes",
    FOUNDRY_DEX_ROLE: "W1",
    FOUNDRY_DEX_NETWORK: "xrpl:1",
    FOUNDRY_DEX_ACCOUNT: anchors.WALLETS.W1.address,
    FOUNDRY_DEX_ACTIVATE: bounds.PHRASE,
    FOUNDRY_DEX_MAX_LOCKED_DROPS: bounds.MAX_LOCKED_DROPS.toString(),
    FOUNDRY_DEX_MAX_AETH: bounds.MAX_AETH,
    FOUNDRY_DEX_AXELAR_DROPS: "0",
    FOUNDRY_W1_DEX_LIVE: "yes",
    FOUNDRY_W1_DEX_WS: "wss://testnet.xrpl-labs.com",
    FOUNDRY_W1_DEX_ACCOUNT_FILE: "/tmp/w1-regular-only.json",
  }, extra || {});
}

function world() {
  return {
    seq: 10000,
    sequence: 10,
    balance: "20000000",
    ownerCount: 0,
    reserveBase: 1,
    reserveInc: 0.2,
    fee: "10",
    offers: [],
    signs: 0,
    submits: 0,
    networkId: 1,
    regularKey: null,
    lookup: null,
    accountTx: null,
  };
}

function clients(state) {
  return {
    mode: "injected",
    sign: async (tx) => {
      state.signs += 1;
      const blob = xrpl.encode(Object.assign({}, tx, {
        SigningPubKey: `ED${"AA".repeat(32)}`,
        TxnSignature: "00".repeat(64),
      }));
      return { tx_blob: blob };
    },
    submit: async () => {
      state.submits += 1;
      if (state.engineResult && state.engineResult !== "tesSUCCESS") {
        return { result: { engine_result: state.engineResult } };
      }
      return { result: { engine_result: "tesSUCCESS" } };
    },
    ledger: {
      request: async (req) => {
        if (req.command === "server_info") {
          return { result: { info: { network_id: state.networkId, complete_ledgers: "1-20000", validated_ledger: { seq: state.seq, reserve_base_xrp: state.reserveBase, reserve_inc_xrp: state.reserveInc } } } };
        }
        if (req.command === "account_info") {
          return { result: { validated: true, ledger_index: state.seq, account_data: { Account: anchors.WALLETS.W1.address, Sequence: state.sequence, Balance: state.balance, OwnerCount: state.ownerCount, RegularKey: state.regularKey } } };
        }
        if (req.command === "fee") return { result: { drops: { open_ledger_fee: state.fee } } };
        if (req.command === "account_offers") {
          return { result: { validated: true, account: anchors.WALLETS.W1.address, ledger_index: 10001, marker: null, offers: state.offers } };
        }
        if (req.command === "tx") return state.lookup ? state.lookup(req) : { result: { error: "txnNotFound" } };
        if (req.command === "account_tx") return state.accountTx ? state.accountTx(req) : { result: { validated: true, marker: null, transactions: [] } };
        throw new Error(req.command);
      },
    },
  };
}

function ownQuotes() {
  return [
    { seq: 4, taker_gets: "500000", taker_pays: AETH },
    { seq: 5, taker_gets: "500000", taker_pays: AETH },
    { seq: 6, taker_gets: "500000", taker_pays: AETH },
    { seq: 7, taker_gets: "775000", taker_pays: AETH },
  ];
}

describe("w1 director", () => {
  it("rejects a master key and a regular-key mismatch before signing", async () => {
    const regular = xrpl.Wallet.generate().address;
    const other = xrpl.Wallet.generate().address;
    const order = [];
    let signs = 0;
    const connect = async () => ({
      request: async (body) => {
        order.push(body.command);
        if (body.command === "server_info") {
          return { result: { info: { network_id: 1, validated_ledger: { seq: 10, reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } };
        }
        return { result: { validated: true, account_data: { Account: anchors.WALLETS.W1.address, RegularKey: regular, Sequence: 3, Balance: "20000000", OwnerCount: 4 } } };
      },
      disconnect: async () => {},
    });
    const master = await connectLive(roleEnv(), {
      connect,
      readAccount: async () => {
        order.push("read");
        return { account: anchors.WALLETS.W1.address, regular_key: regular, seed: "fixture-not-a-seed" };
      },
      openWallet: () => {
        order.push("open");
        return { address: anchors.WALLETS.W1.address, classicAddress: anchors.WALLETS.W1.address, sign() { signs += 1; } };
      },
    });
    await assert.rejects(() => master.openKey(), (error) => error.code === "MASTER_KEY");
    assert.equal(signs, 0);
    assert.equal(order.indexOf("server_info") < order.indexOf("read"), true);
    assert.equal(order.indexOf("read") < order.indexOf("open"), true);
    await master.close();
    const mismatch = await connectLive(roleEnv(), {
      connect,
      readAccount: async () => ({ account: anchors.WALLETS.W1.address, regular_key: other, seed: "fixture-not-a-seed" }),
      openWallet: () => { signs += 1; throw new Error("opened"); },
    });
    await assert.rejects(() => mismatch.openKey(), (error) => error.code === "REGULAR_KEY");
    assert.equal(signs, 0);
    await mismatch.close();
    const absent = await connectLive(roleEnv(), {
      connect: async () => ({
        request: async (body) => {
          if (body.command === "server_info") return { result: { info: { network_id: 1, validated_ledger: { seq: 10, reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } };
          return { result: { validated: true, account_data: { Account: anchors.WALLETS.W1.address, Sequence: 3, Balance: "20000000", OwnerCount: 4 } } };
        },
        disconnect: async () => {},
      }),
      readAccount: async () => { throw new Error("secret read"); },
      openWallet: () => { throw new Error("opened"); },
    });
    await assert.rejects(() => absent.openKey(), (error) => error.code === "REGULAR_KEY");
  });

  it("observes an own-only book on two ticks and again after restart", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "dex-journal-"));
    const state = world();
    const input = { now: NOW, ledger, journal };
    const researched = await decide(roleEnv(), input, clients(state));
    assert.equal(researched.decision, "research");
    assert.equal(researched.spend_enabled, true);
    assert.equal(researched.traded, false);
    assert.equal(state.signs, 0);
    state.offers = ownQuotes();
    const first = await decide(roleEnv(), input, clients(state));
    const second = await decide(roleEnv(), input, clients(state));
    assert.equal(first.decision, "observe");
    assert.equal(first.spend_enabled, true);
    assert.equal(first.traded, false);
    assert.equal(first.learning, false);
    assert.equal(first.preexisting_locked_drops, "2275000");
    assert.equal(first.cap_blocked, false);
    assert.equal(first.day_used_drops, "1747");
    assert.equal(second.decision, "observe");
    assert.equal(second.preexisting_locked_drops, "2275000");
    assert.equal(state.signs, 0);
    assert.equal(state.submits, 0);
    const restarted = await decide(roleEnv(), { now: NOW, ledger, journal }, clients(state));
    assert.equal(restarted.decision, "observe");
    assert.equal(readJournal(journal).length, 4);
    assert.equal(fs.readFileSync(path.join(journal, "decisions.jsonl"), "utf8").includes("fixture-not-a-seed"), false);
    state.offers = [{ seq: 9, taker_gets: "4999000", taker_pays: AETH }];
    const blocked = await decide(roleEnv(), { now: NOW, ledger, journal }, clients(state));
    assert.equal(blocked.decision, "observe");
    assert.equal(blocked.cap_blocked, true);
    assert.equal(blocked.traded, false);
  });

  it("places a standing order once, replays it, then reconciles a partial fill", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "dex-journal-"));
    const state = world();
    const standing = { taker_gets: "1000", taker_pays: AETH };
    const input = { now: NOW, ledger, journal, policy: { standing_offer: standing } };
    const placed = await decide(roleEnv(), input, clients(state));
    assert.equal(placed.decision, "place");
    assert.equal(placed.signed, true);
    assert.equal(placed.traded, false);
    assert.equal(state.signs, 1);
    const mission = Object.values(view(ledger, NOW).missions).find((row) => row.kind === "w1-dex-offer");
    state.offers = [{ seq: mission.unsigned_tx.Sequence, taker_gets: "400", taker_pays: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "0.4" } }];
    state.lookup = () => ({
      result: {
        validated: true,
        hash: mission.signed_hash,
        ledger_index: 10001,
        tx_json: mission.unsigned_tx,
        meta: {
          TransactionResult: "tesSUCCESS",
          AffectedNodes: [
            { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: anchors.WALLETS.W1.address, Balance: "19999390", OwnerCount: 1 }, PreviousFields: { Account: anchors.WALLETS.W1.address, Balance: "20000000", OwnerCount: 0 } } },
            { ModifiedNode: { LedgerEntryType: "RippleState", FinalFields: { Balance: "0.6", LowLimit: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W1.address, value: "100" }, HighLimit: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "0" } }, PreviousFields: { Balance: "0", LowLimit: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W1.address, value: "100" }, HighLimit: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "0" } } } },
            { CreatedNode: { LedgerEntryType: "Offer", NewFields: { Account: anchors.WALLETS.W1.address, Sequence: mission.sequence, TakerGets: "400", TakerPays: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "0.4" } } } },
          ],
        },
      },
    });
    const follow = await decide(roleEnv(), input, clients(state));
    assert.equal(follow.decision, "reconcile");
    assert.equal(state.signs, 1);
    assert.equal(view(ledger, NOW).missions[mission.id].status, "dex_partial");
    assert.equal(view(ledger, NOW).missions[mission.id].outstanding_drops, "200400");
    state.engineResult = "tecUNFUNDED_OFFER";
    const failed = await decide(roleEnv({ FOUNDRY_DEX_KILL: "yes" }), input, clients(state));
    assert.equal(failed.decision, "hold");
    assert.equal(failed.spend_enabled, false);
    assert.equal(state.submits, 1);
    const dormant = await main(["--once"], { env: {} });
    assert.equal(dormant, 0);
    assert.equal(health({}).dormant, true);
    assert.equal(health({}).learning, false);
  });

  it("records a terminal submit error and does not submit it again", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "dex-journal-"));
    const state = world();
    state.engineResult = "tecUNFUNDED_OFFER";
    const policyFile = path.join(journal, "policy.json");
    fs.writeFileSync(policyFile, `${JSON.stringify({ standing_offer: { taker_gets: "1000", taker_pays: AETH } })}\n`);
    const env = roleEnv({ FOUNDRY_W1_DEX_POLICY: policyFile });
    const input = { now: NOW, ledger, journal };
    const failed = await decide(env, input, clients(state));
    assert.equal(failed.decision, "place");
    assert.equal(failed.status, "dex_unknown");
    assert.equal(failed.submitted, false);
    assert.equal(failed.traded, false);
    assert.equal(state.submits, 1);
    const again = await decide(env, input, clients(state));
    assert.equal(again.decision, "reconcile");
    assert.equal(state.submits, 1);
    assert.equal(state.signs, 1);
    const text = fs.readFileSync(path.join(journal, "decisions.jsonl"), "utf8");
    assert.equal(text.includes("seed"), false);
    assert.equal(text.includes("tx_blob"), false);
    assert.equal(text.includes("dex_unknown"), true);
  });

  it("lets two ticks share the mission ledger lock", async () => {
    const ledger = home();
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msnffffffffffffffff", day: "2026-11-07", drops: "4000000", settlement: "submit_unknown", live: false })}\n`);
    const state = world();
    const left = fs.mkdtempSync(path.join(os.tmpdir(), "dex-journal-"));
    const right = fs.mkdtempSync(path.join(os.tmpdir(), "dex-journal-"));
    const offer = (gets) => ({ taker_gets: gets, taker_pays: AETH });
    const raced = await Promise.all([
      decide(roleEnv(), { now: NOW, ledger, journal: left, policy: { standing_offer: offer("400000") } }, clients(state)),
      decide(roleEnv(), { now: NOW, ledger, journal: right, policy: { standing_offer: offer("450000") } }, clients(state)),
    ]);
    const placed = raced.filter((row) => row.signed === true);
    const blocked = raced.filter((row) => row.error_code === "CAP" || row.error_code === "SEQUENCE");
    assert.equal(placed.length, 1);
    assert.equal(blocked.length, 1);
    assert.equal(state.signs, 1);
    const missions = Object.values(view(ledger, NOW).missions).filter((row) => row.kind === "w1-dex-offer");
    assert.equal(missions.length, 1);
  });

  it("selects cancel for its own open order and does not release it early", async () => {
    const ledger = home();
    const journal = fs.mkdtempSync(path.join(os.tmpdir(), "dex-journal-"));
    const state = world();
    const standing = { taker_gets: "1000", taker_pays: AETH };
    const input = { now: NOW, ledger, journal, policy: { standing_offer: standing } };
    const placed = await decide(roleEnv(), input, clients(state));
    assert.equal(placed.signed, true);
    const mission = Object.values(view(ledger, NOW).missions).find((row) => row.kind === "w1-dex-offer");
    state.offers = [{ seq: mission.sequence, taker_gets: "1000", taker_pays: AETH }];
    state.lookup = () => ({
      result: {
        validated: true,
        hash: mission.signed_hash,
        ledger_index: 10001,
        tx_json: mission.unsigned_tx,
        meta: {
          TransactionResult: "tesSUCCESS",
          AffectedNodes: [
            { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: anchors.WALLETS.W1.address, Balance: "19999990", OwnerCount: 1 }, PreviousFields: { Account: anchors.WALLETS.W1.address, Balance: "20000000", OwnerCount: 0 } } },
            { CreatedNode: { LedgerEntryType: "Offer", NewFields: { Account: anchors.WALLETS.W1.address, Sequence: mission.sequence, TakerGets: "1000", TakerPays: AETH } } },
          ],
        },
      },
    });
    const opened = await decide(roleEnv(), input, clients(state));
    assert.equal(opened.decision, "reconcile");
    assert.equal(view(ledger, NOW).missions[mission.id].status, "dex_open");
    const before = view(ledger, NOW).missions[mission.id].outstanding_drops;
    const withdrawn = await decide(roleEnv(), {
      now: NOW,
      ledger,
      journal,
      policy: { standing_offer: standing, cancel_standing: true },
    }, clients(state));
    assert.equal(withdrawn.decision, "cancel");
    assert.equal(withdrawn.error_code, "LEDGER");
    assert.equal(state.signs, 1);
    assert.equal(view(ledger, NOW).missions[mission.id].outstanding_drops, before);
    assert.notEqual(view(ledger, NOW).missions[mission.id].hold, "released");
  });
});
