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
const { admitFreshChallenge } = require("./challenge-admit");
const { wake } = require("./wake");
const { uploadIngest, assertIngestUrl } = require("./desk-publish");
const ingest = require("../../web/lib/mission-ingest");
const { publish, integrityOf } = require("./publish");

const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const WAKE_TOKEN = "wake-control-token-32chars-minimum";
const INGEST_SECRET = "ingest-secret-value-32chars-minimum";
const NOW = "2026-11-06T20:57:00.000Z";
const SANCTIONS = "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const FRESH_INVOICE = "1793999217-8ff0cbc91cfe49c6-d1753-3be1077708929724e01824ae";
const RETAINED_INVOICE = "1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-"));
}

function activate(ledger) {
  control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
}

function freshDoc(invoiceId, amount) {
  return {
    retrieved_at: "2026-11-06T20:56:57.160Z",
    http_status: 402,
    paid: false,
    proof_sent: false,
    resource_url_requested: SANCTIONS,
    resource_url_in_body: SANCTIONS,
    resource_url_exact_match: true,
    x402Version: 2,
    reviewed_row: {
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      amount,
      payTo: REVIEWED,
      maxTimeoutSeconds: 600,
      extra: { sourceTag: 26100014, invoiceId },
    },
  };
}

function hold1747(ledger, address) {
  const old = startMission(ledger, {
    idempotency_key: "old-hold-1747",
    now: NOW,
    observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
    payment_drops: "1737",
    network_fee_drops: "10",
    resource_url: "https://shop.test/old",
  }, { allowlist: { payees: [REVIEWED] } });
  const ready = act(ledger, { mission_id: old.mission.id, now: NOW }, { wallet: { address } }).mission;
  beginSubmit(ledger, { mission_id: ready.id, now: NOW });
  notePresign(ledger, ready.id, "AB".repeat(32));
  return ready.id;
}

describe("fresh challenge admission", () => {
  it("records the unpaid 1753 invoice and leaves the 1747 hold and discovery untouched", () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const wallet = xrpl.Wallet.generate();
    const held = hold1747(ledger, wallet.address);
    const discovery = path.join(home, "discovery.json");
    fs.writeFileSync(discovery, "{\"schema\":\"aether.missions.discovery\",\"items\":[]}\n");
    const before = fs.readFileSync(discovery);
    const admitted = admitFreshChallenge(ledger, freshDoc(FRESH_INVOICE, "1753"), NOW);
    assert.equal(admitted.payable, false);
    assert.equal(admitted.event.discovery_rewritten, false);
    assert.equal(admitted.event.new_candidate, false);
    assert.equal(admitted.event.amount, "1753");
    assert.equal(admitted.event.invoice_id, FRESH_INVOICE);
    assert.equal(fs.readFileSync(discovery).equals(before), true);
    const state = view(ledger, NOW);
    assert.equal(state.missions[held].hold, "uncertain");
    assert.equal(state.missions[held].budget.budget_drops, "1747");
    assert.equal(Object.keys(state.missions).length, 1);
    assert.throws(
      () => admitFreshChallenge(ledger, freshDoc(FRESH_INVOICE, "1753"), NOW),
      (error) => error.code === "NO_RETRY"
    );
    assert.throws(
      () => admitFreshChallenge(ledger, freshDoc(RETAINED_INVOICE, "1737"), NOW),
      (error) => error.code === "NO_RETRY"
    );
    assert.equal(view(ledger, NOW).missions[held].hold, "uncertain");
  });
});

describe("held account sequence", () => {
  it("refuses the same account and an override, and allows a different account", () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const heldWallet = xrpl.Wallet.generate();
    const other = xrpl.Wallet.generate();
    const held = hold1747(ledger, heldWallet.address);
    const opened = startMission(ledger, {
      idempotency_key: "same-account-next",
      now: NOW,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "10",
      network_fee_drops: "0",
      resource_url: SANCTIONS,
    }, { allowlist: { payees: [REVIEWED] } });
    const same = act(ledger, { mission_id: opened.mission.id, now: NOW }, { wallet: { address: heldWallet.address } });
    assert.throws(
      () => beginSubmit(ledger, { mission_id: same.mission.id, now: NOW }),
      (error) => error.code === "SEQUENCE_HELD" && error.hold.options.some((item) => item.id === "supersede" && item.available === false)
    );
    assert.throws(
      () => beginSubmit(ledger, { mission_id: same.mission.id, now: NOW, override: true }),
      (error) => error.code === "NO_RETRY"
    );
    assert.equal(view(ledger, NOW).missions[held].hold, "uncertain");
    assert.equal(view(ledger, NOW).missions[same.mission.id].hold, "unsubmitted");
    const moved = startMission(ledger, {
      idempotency_key: "other-account-next",
      now: NOW,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "10",
      network_fee_drops: "0",
      resource_url: SANCTIONS,
    }, { allowlist: { payees: [REVIEWED] } });
    const next = act(ledger, { mission_id: moved.mission.id, now: NOW }, { wallet: { address: other.address } });
    const claimed = beginSubmit(ledger, { mission_id: next.mission.id, now: NOW });
    assert.equal(claimed.proceed, true);
    assert.equal(claimed.mission.claim.account, other.address);
    assert.equal(view(ledger, NOW).missions[held].presigned_hash, "AB".repeat(32));
  });
});

describe("bounded wake", () => {
  it("runs one control tick and does not sign or spend", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const wallet = xrpl.Wallet.generate();
    hold1747(ledger, wallet.address);
    const challenge = path.join(home, "challenge.json");
    fs.writeFileSync(challenge, JSON.stringify(freshDoc(FRESH_INVOICE, "1753")));
    const discovery = path.join(home, "discovery.json");
    fs.writeFileSync(discovery, "{}\n");
    const env = {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WAKE_TOKEN: WAKE_TOKEN,
      FOUNDRY_MISSION_WAKE_PHRASE: "WAKE-MISSION-CONTROL",
      FOUNDRY_MISSION_CHALLENGE_FILE: challenge,
      FOUNDRY_MISSION_EXECUTE: "yes",
    };
    await assert.rejects(() => wake({ FOUNDRY_MISSION_WAKE_TOKEN: "short" }, { now: NOW }), (error) => error.code === "AUTH");
    const result = await wake(env, { now: NOW });
    assert.equal(result.execute, false);
    assert.equal(result.spend, false);
    assert.equal(result.submitted, false);
    assert.equal(result.admitted, true);
    assert.equal(result.payable, false);
    const lease = JSON.parse(fs.readFileSync(path.join(home, "wake.json"), "utf8"));
    assert.equal(lease.execute, false);
    assert.equal(lease.ticks_used, 1);
    assert.equal(JSON.stringify(lease).includes(WAKE_TOKEN), false);
    await assert.rejects(() => wake(env, { now: NOW }), (error) => error.code === "NO_RETRY");
    assert.equal(fs.readFileSync(discovery, "utf8"), "{}\n");
    assert.equal(view(ledger, NOW).missions[Object.keys(view(ledger, NOW).missions)[0]].budget.budget_drops, "1747");
  });
});

describe("desk ingest", () => {
  it("posts the sanitized snapshot to the desk and refuses another host", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    assert.throws(() => assertIngestUrl("https://example.com/api/missions/ingest"), (error) => error.code === "PUBLISH");
    let seen = null;
    const result = await uploadIngest(ledger, {
      now: NOW,
      env: { FOUNDRY_MISSION_INGEST_SECRET: INGEST_SECRET },
      fetch: async (url, init) => {
        seen = { url, authorization: init.headers.authorization, body: JSON.parse(init.body) };
        return { ok: true, status: 200 };
      },
    });
    assert.equal(result.uploaded, true);
    assert.equal(result.transport, "ingest");
    assert.equal(seen.url, "https://aether-foundry-desk.vercel.app/api/missions/ingest");
    assert.equal(seen.authorization, `Bearer ${INGEST_SECRET}`);
    assert.equal(seen.body.integrity, integrityOf(seen.body));
    const missing = await uploadIngest(ledger, {
      now: "2026-11-06T21:20:00.000Z",
      env: {},
      fetch: async () => { throw new Error("should not be called"); },
    });
    assert.equal(missing.reason, "no_ingest_secret");
  });

  it("accepts one bearer write and refuses a rollback or a public bearer", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    publish(ledger, NOW);
    const doc = JSON.parse(fs.readFileSync(path.join(ledger, "public-status.json"), "utf8"));
    const stored = [];
    const first = await ingest.handlePost({
      secret: INGEST_SECRET,
      authorization: `Bearer ${INGEST_SECRET}`,
      raw: JSON.stringify(doc),
      blobToken: "present",
      read: async () => null,
      write: async (_pathname, body) => { stored.push(body.sequence); },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.stored, true);
    const replay = await ingest.handlePost({
      secret: INGEST_SECRET,
      authorization: "Bearer wrong-secret-value-32chars-minimum",
      raw: JSON.stringify(doc),
      blobToken: "present",
      read: async () => doc,
      write: async () => { throw new Error("should not write"); },
    });
    assert.equal(replay.status, 401);
    const older = Object.assign({}, doc, { killed: true });
    delete older.integrity;
    older.integrity = integrityOf(older);
    const rolled = await ingest.handlePost({
      secret: INGEST_SECRET,
      authorization: `Bearer ${INGEST_SECRET}`,
      raw: JSON.stringify(older),
      blobToken: "present",
      read: async () => doc,
      write: async () => { throw new Error("should not write"); },
    });
    assert.equal(rolled.status, 400);
    assert.equal(rolled.body.code, "OUT_OF_ORDER");
    assert.deepEqual(stored, [doc.sequence]);
  });
});
