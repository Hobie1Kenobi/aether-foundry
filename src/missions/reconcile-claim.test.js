"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("./config");
const { control, view, startMission, act } = require("./engine");
const { beginSubmit, notePresign, stampPrepared } = require("./submit");
const { reconcileClaim, OLD_CLAIM } = require("./reconcile-claim");

const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const AUDIT = "reconcile-audit-token-32chars-min";
const NOW = "2026-11-06T22:00:00.000Z";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-reconcile-"));
}

function labs(validated, hashFound) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "server_info") {
      return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: validated } } } }), { status: 200 });
    }
    if (body.method === "account_info") {
      return new Response(JSON.stringify({ result: { validated: true, account_data: { Sequence: 22121127 } } }), { status: 200 });
    }
    if (body.method === "tx") {
      if (hashFound) {
        return new Response(JSON.stringify({ result: { hash: "5E621D59EDBF276A0B31E83E78F114DFB678F4B2E48C51492DF0404EE29013F3" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { error: "txnNotFound" } }), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  };
}

function claim(ledger, address, withWindow, key) {
  const opened = startMission(ledger, {
    idempotency_key: key,
    now: NOW,
    observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
    payment_drops: "1753",
    network_fee_drops: "10",
    resource_url: "https://shop.test/new",
  }, { allowlist: { payees: [REVIEWED] } });
  const ready = act(ledger, { mission_id: opened.mission.id, now: NOW }, { wallet: { address } }).mission;
  if (withWindow) {
    stampPrepared(ledger, { mission_id: ready.id, now: NOW, sequence: 22121127, lastLedgerSequence: 22121554 });
  }
  beginSubmit(ledger, { mission_id: ready.id, now: NOW });
  notePresign(ledger, ready.id, "5E621D59EDBF276A0B31E83E78F114DFB678F4B2E48C51492DF0404EE29013F3", {
    tx: withWindow ? { Sequence: 22121127, LastLedgerSequence: 22121554, Account: address, Destination: REVIEWED, Amount: "1753", Fee: "10" } : undefined,
  });
  return ready.id;
}

describe("new claim reconciliation", () => {
  it("reports the window and does not release or retry without the audit phrase", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const address = xrpl.Wallet.generate().address;
    const id = claim(ledger, address, true, "window-claim-1763");
    const open = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121554, false) });
    assert.equal(open.release_allowed, false);
    assert.equal(open.released, false);
    assert.equal(open.reason, "window_open");
    const ready = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, false) });
    assert.equal(ready.release_allowed, true);
    assert.equal(ready.released, false);
    assert.equal(ready.retried, false);
    assert.equal(view(ledger, NOW).missions[id].hold, "uncertain");
    const present = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, true) });
    assert.equal(present.release_allowed, false);
    assert.equal(present.reason, "hash_present");
  });

  it("audits a passed window for the new claim and refuses the old claim and an override", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const address = xrpl.Wallet.generate().address;
    const id = claim(ledger, address, true, "new-claim-1763");
    const old = claim(ledger, xrpl.Wallet.generate().address, false, "old-style-nolls");
    await assert.rejects(
      () => reconcileClaim(ledger, id, { now: NOW, override: true, fetch: labs(22121555, false) }),
      (error) => error.code === "NO_RETRY"
    );
    const denied = await reconcileClaim(ledger, OLD_CLAIM, {
      now: NOW,
      audit: true,
      env: {
        FOUNDRY_MISSION_RECONCILE_PHRASE: "AUDIT-RELEASE-PASSED-WINDOW",
        FOUNDRY_MISSION_RECONCILE_TOKEN: AUDIT,
        FOUNDRY_MISSION_RECONCILE_MISSION: OLD_CLAIM,
      },
      fetch: labs(99999999, false),
    });
    assert.equal(denied.reason, "old_claim");
    assert.equal(denied.released, false);
    const bare = await reconcileClaim(ledger, old, { now: NOW, audit: true, fetch: labs(99999999, false), env: {
      FOUNDRY_MISSION_RECONCILE_PHRASE: "AUDIT-RELEASE-PASSED-WINDOW",
      FOUNDRY_MISSION_RECONCILE_TOKEN: AUDIT,
      FOUNDRY_MISSION_RECONCILE_MISSION: old,
    } });
    assert.equal(bare.release_allowed, false);
    assert.equal(bare.reason, "no_last_ledger_sequence");
    const released = await reconcileClaim(ledger, id, {
      now: NOW,
      audit: true,
      fetch: labs(22121555, false),
      env: {
        FOUNDRY_MISSION_RECONCILE_PHRASE: "AUDIT-RELEASE-PASSED-WINDOW",
        FOUNDRY_MISSION_RECONCILE_TOKEN: AUDIT,
        FOUNDRY_MISSION_RECONCILE_MISSION: id,
      },
    });
    assert.equal(released.released, true);
    assert.equal(released.retried, false);
    const state = view(ledger, NOW);
    assert.equal(state.missions[id].code, "LEDGER_EXPIRED");
    assert.equal(state.missions[id].complete, false);
    assert.equal(state.missions[old].hold, "uncertain");
    const text = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(text.includes("fee-retry"), false);
  });
});
