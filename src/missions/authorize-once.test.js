"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("./config");
const { control, view, startMission, act } = require("./engine");
const { beginSubmit, notePresign } = require("./submit");
const { exclusive } = require("./ledger");
const policy = require("./policy");
const { authorizeOnce, PERMANENT_HOLD } = require("./authorize-once");
const { readHistory, appendRecord, hashRecord } = require("./lease-chain");
const { executeOnce } = require("./execute-once");

const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const AUTH = "authorize-once-token-32chars-minimum";
const NOW = "2026-11-06T22:30:00.000Z";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-authz-"));
}

function env(home, ledger, extra) {
  return Object.assign({
    FOUNDRY_MISSION_HOME: home,
    FOUNDRY_MISSION_LEDGER: ledger,
    FOUNDRY_MISSION_AUTHORIZE_TOKEN: AUTH,
    FOUNDRY_MISSION_AUTHORIZE_PHRASE: "AUTHORIZE-ONE-MORE-PURCHASE",
    FOUNDRY_MISSION_AUTHORIZE_NOTE: "owner approved one more sanctions purchase",
  }, extra || {});
}

function permanent(ledger) {
  exclusive(ledger, (api) => {
    api.append({
      type: "mission.upsert",
      at: NOW,
      mission: {
        id: PERMANENT_HOLD,
        presigned_hash: "AB".repeat(32),
        signed: true,
        hold: "unsubmitted",
        complete: false,
        budget: { budget_drops: "1747" },
        day: "2026-11-06",
      },
    });
    api.append({
      type: "budget.uncertain",
      at: NOW,
      mission_id: PERMANENT_HOLD,
      day: "2026-11-06",
      drops: "1747",
      settlement: "submit_unknown",
      live: true,
    });
  });
}

describe("one more purchase authorization", () => {
  it("issues one generation, keeps the prior line, and leaves the hold", () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    permanent(ledger);
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"));
    const used = policy.dayUsed(view(ledger, NOW), "2026-11-06");
    assert.equal(used, 1747n);
    const first = authorizeOnce(env(home, ledger), { now: NOW });
    assert.equal(first.issued, true);
    assert.equal(first.max_ticks, 1);
    assert.equal(fs.readFileSync(path.join(ledger, "events.jsonl")).equals(before), true);
    assert.equal(policy.dayUsed(view(ledger, NOW), "2026-11-06"), 1747n);
    assert.throws(() => authorizeOnce(env(home, ledger), { now: NOW }), (error) => error.code === "NO_RETRY");
    const historyFile = path.join(home, "lease-history.jsonl");
    const firstBytes = fs.readFileSync(historyFile);
    assert.equal(firstBytes.toString().trim().split("\n").length, 1);
    appendRecord(home, {
      type: "lease.used",
      lease_id: first.lease_id,
      used_at: NOW,
      ticks: 1,
      invoice_id: "invoice-already-used-01",
    });
    const second = authorizeOnce(env(home, ledger), { now: "2026-11-06T22:40:00.000Z" });
    assert.notEqual(second.lease_id, first.lease_id);
    const text = fs.readFileSync(historyFile);
    assert.equal(text.subarray(0, firstBytes.length).equals(firstBytes), true);
    assert.equal(readHistory(home).length, 3);
  });

  it("leaves a used execute.json in place and still requires a new generation", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    const legacy = path.join(home, "execute.json");
    fs.writeFileSync(legacy, `${JSON.stringify({ ticks_used: 1, phrase: "EXECUTE-ONE-FRESH-PURCHASE" })}\n`);
    const legacyBytes = fs.readFileSync(legacy);
    await assert.rejects(
      () => executeOnce(Object.assign(env(home, ledger), {
        FOUNDRY_MISSION_EXECUTE_TOKEN: "execute-one-shot-token-32chars-min",
        FOUNDRY_MISSION_EXECUTE_PHRASE: "EXECUTE-ONE-FRESH-PURCHASE",
      }), { now: NOW, spawnSigner: false }),
      (error) => error.code === "NO_RETRY"
    );
    const issued = authorizeOnce(env(home, ledger), { now: NOW });
    assert.equal(fs.readFileSync(legacy).equals(legacyBytes), true);
    appendRecord(home, {
      type: "lease.used",
      lease_id: issued.lease_id,
      used_at: NOW,
      ticks: 1,
      invoice_id: "invoice-from-the-used-generation",
    });
    await assert.rejects(
      () => executeOnce(Object.assign(env(home, ledger), {
        FOUNDRY_MISSION_EXECUTE_TOKEN: "execute-one-shot-token-32chars-min",
        FOUNDRY_MISSION_EXECUTE_PHRASE: "EXECUTE-ONE-FRESH-PURCHASE",
        FOUNDRY_MISSION_CHALLENGE_FILE: path.join(home, "missing.json"),
      }), { now: NOW, spawnSigner: false }),
      (error) => error.code === "NO_RETRY"
    );
    assert.equal(fs.readFileSync(legacy).equals(legacyBytes), true);
  });

  it("detects a tampered lease line and refuses another grant", () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    authorizeOnce(env(home, ledger), { now: NOW });
    const file = path.join(home, "lease-history.jsonl");
    const original = fs.readFileSync(file, "utf8");
    const row = JSON.parse(original);
    row.note = "tampered note";
    fs.writeFileSync(file, `${JSON.stringify(row)}\n`);
    assert.notEqual(row.hash, hashRecord(row));
    assert.throws(() => authorizeOnce(env(home, ledger), { now: NOW }), (error) => error.code === "TAMPER");
    fs.writeFileSync(file, original);
    assert.throws(() => authorizeOnce(env(home, ledger), { now: NOW }), (error) => error.code === "NO_RETRY");
  });

  it("refuses a signed unreconciled claim, a waking worker, a shared token, and a tight cap", () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: false }));
    assert.throws(() => authorizeOnce(env(home, ledger), { now: NOW }), (error) => error.code === "ASLEEP");
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    assert.throws(
      () => authorizeOnce(env(home, ledger, { FOUNDRY_MISSION_EXECUTE_TOKEN: AUTH }), { now: NOW }),
      (error) => error.code === "AUTH"
    );
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const wallet = xrpl.Wallet.generate();
    const opened = startMission(ledger, {
      idempotency_key: "signed-open-claim",
      now: NOW,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "100",
      network_fee_drops: "10",
      resource_url: "https://shop.test/open",
    }, { allowlist: { payees: [REVIEWED] } });
    const ready = act(ledger, { mission_id: opened.mission.id, now: NOW }, { wallet: { address: wallet.address } }).mission;
    beginSubmit(ledger, { mission_id: ready.id, now: NOW });
    notePresign(ledger, ready.id, "CD".repeat(32));
    assert.notEqual(ready.id, PERMANENT_HOLD);
    assert.throws(() => authorizeOnce(env(home, ledger), { now: NOW }), (error) => error.code === "NO_RETRY");
    const tight = tmp();
    const tightLedger = path.join(tight, "ledger");
    fs.mkdirSync(tightLedger);
    fs.writeFileSync(path.join(tight, "worker.json"), JSON.stringify({ asleep: true }));
    control(tightLedger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    for (let i = 0; i < 4; i += 1) {
      startMission(tightLedger, {
        idempotency_key: `cap-fill-${i}-0000`,
        now: NOW,
        observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
        payment_drops: "1000000",
        network_fee_drops: "0",
        resource_url: "https://shop.test/cap",
      }, { allowlist: { payees: [REVIEWED] } });
    }
    startMission(tightLedger, {
      idempotency_key: "cap-fill-last-000",
      now: NOW,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "990001",
      network_fee_drops: "0",
      resource_url: "https://shop.test/cap",
    }, { allowlist: { payees: [REVIEWED] } });
    const left = config.DAILY_DROPS - policy.dayUsed(view(tightLedger, NOW), "2026-11-06");
    assert.equal(left < 10000n, true);
    assert.throws(() => authorizeOnce(env(tight, tightLedger), { now: NOW }), (error) => error.code === "CAP");
  });
});
