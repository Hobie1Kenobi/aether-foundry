"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const heartbeat = require("./actions/heartbeat");
const metrics = require("./metrics");
const policy = require("./policy");

const ROOT = anchors.repoRoot();
const HASH = "AB".repeat(32);

function freshState(now) {
  return {
    updated_at: anchors.formatChicago(new Date(now.getTime() - 60 * 60 * 1000)),
    networks: {
      xrpl_testnet: { network_id: 1, validated_ledger_index: 21102567 },
    },
    wallets: {
      W5: { regular_key: "rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q" },
    },
    watched: { batch: { atomic_enabled: false } },
  };
}

test("dry-run prints an unsigned Payment and does not read a seed", async () => {
  const now = new Date("2026-09-28T18:00:00.000Z");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-dry-"));
  const before = fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8");
  let reads = 0;
  let captured = "";
  const code = await heartbeat.run(["--dry-run"], {
    env: {
      CI: "true",
      W5_REGULAR_SEED: "present-not-used",
      AETHER_SECRETS: path.join(dir, "missing.env"),
    },
    now,
    state: freshState(now),
    root: dir,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.equal(captured.includes("present-not-used"), false);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "dry-run");
  assert.equal(body.signed, false);
  assert.equal(body.submitted, false);
  assert.equal(body.key_loaded, false);
  assert.equal(body.key_env, "W5_REGULAR_SEED");
  assert.equal(body.tx.TransactionType, "Payment");
  assert.equal(body.tx.Account, anchors.WALLETS.W5.address);
  assert.equal(body.tx.Destination, anchors.WALLETS.W3.address);
  assert.equal(body.tx.Amount, "1");
  assert.equal(body.tx.SourceTag, 202609280);
  const memos = grants.decodeMemos(body.tx);
  assert.equal(memos.purpose, "aether-heartbeat");
  assert.equal(memos.experiment, "foundry-runtime");
  assert.equal(memos.ledger, "21102567");
  assert.equal(Object.prototype.hasOwnProperty.call(body.tx, "hash"), false);
  assert.equal(fs.existsSync(path.join(dir, "lab", "metrics.json")), false);
  assert.equal(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"), before);
});

test("live refuses CI and mainnet before a seed read", async () => {
  let reads = 0;
  await assert.rejects(
    () => heartbeat.run(["--live"], {
      env: { CI: "true", FOUNDRY_DAEMON_LIVE: "yes", W5_REGULAR_SEED: "present-not-used" },
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "CI"
  );
  await assert.rejects(
    () => heartbeat.run(["--live"], {
      env: { GITHUB_ACTIONS: "true", FOUNDRY_DAEMON_LIVE: "yes" },
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "CI"
  );
  assert.throws(
    () => policy.assertAltnet({ networkId: 0, url: "https://s1.ripple.com:51234" }),
    (error) => error.code === "MAINNET"
  );
  assert.throws(
    () => policy.assertAltnet({ networkId: 21337, url: "https://xahau.network" }),
    (error) => error.code === "MAINNET"
  );
  assert.equal(reads, 0);
  const workflows = fs.readdirSync(path.join(ROOT, ".github", "workflows"));
  for (const name of workflows) {
    const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
    assert.equal(text.includes("heartbeat:live"), false, name);
    assert.equal(text.includes("W5_REGULAR_SEED"), false, name);
  }
});

test("rate limit is 4 per UTC day, a 24h backstop, and 6 hours", () => {
  const now = new Date("2026-09-28T20:00:00.000Z");
  const today = [1, 7, 13, 19].map((hour) => ({
    action: "heartbeat",
    ts: new Date(Date.UTC(2026, 8, 28, hour, 0, 0)).toISOString(),
  }));
  assert.throws(
    () => policy.assertHeartbeat({ drops: "1", history: today, now }),
    (error) => error.code === "RATE" && /UTC day/.test(error.message)
  );
  const yesterday = [20, 21, 22, 23].map((hour) => ({
    event: "heartbeat",
    ts: new Date(Date.UTC(2026, 8, 27, hour, 0, 0)).toISOString(),
  }));
  assert.throws(
    () => policy.assertHeartbeat({
      drops: "1",
      history: yesterday,
      now: new Date("2026-09-28T18:30:00.000Z"),
    }),
    (error) => error.code === "RATE" && /24h/.test(error.message)
  );
  const allowed = policy.assertHeartbeat({
    drops: "1",
    destination: anchors.WALLETS.W6.address,
    history: [{ action: "heartbeat", ts: "2026-09-27T19:00:00.000Z" }],
    now: new Date("2026-09-28T02:00:00.000Z"),
  });
  assert.equal(allowed.drops, "1");
  assert.equal(allowed.destination, anchors.WALLETS.W6.address);
});

test("metrics skeleton copies pnl counts and refuses a missing hash", () => {
  const pnl = fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8");
  const parsed = metrics.parsePnlCounts(pnl);
  assert.deepEqual(parsed.errors, []);
  const doc = metrics.skeletonFromPnl(pnl, new Date("2026-09-28T21:15:00.000Z"));
  assert.equal(doc.x402_hits, parsed.counts.x402_hits);
  assert.equal(doc.grants_paid, parsed.counts.grants_paid);
  assert.equal(doc.inbound_counterparties, parsed.counts.inbound_counterparties);
  assert.equal(doc.last_heartbeat_hash, null);
  assert.equal(doc.last_grant_hash, null);
  assert.equal(doc.last_outbound_hash, null);
  assert.equal(doc.last_heartbeat.hash, null);
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"));
  assert.equal(committed.last_heartbeat_hash, null);
  assert.equal(committed.last_heartbeat.hash, null);
  assert.equal(committed.x402_hits, parsed.counts.x402_hits);
  assert.equal(committed.grants_paid, parsed.counts.grants_paid);
  assert.throws(
    () => metrics.recordHeartbeat(ROOT, { hash: "not-a-hash" }),
    (error) => error.code === "METRICS" || error.code === "RECORD"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-metrics-"));
  fs.mkdirSync(path.join(dir, "market"), { recursive: true });
  fs.writeFileSync(path.join(dir, "market", "pnl.md"), pnl);
  const written = metrics.recordHeartbeat(dir, {
    hash: HASH,
    ledger_index: 21103000,
    ts: "2026-09-28T21:20:00.000Z",
    now: new Date("2026-09-28T21:20:00.000Z"),
  });
  assert.equal(written.last_heartbeat.hash, HASH);
  assert.equal(written.last_heartbeat.ledger_index, 21103000);
  assert.equal(written.last_grant_hash, null);
  assert.equal(written.grants_paid, parsed.counts.grants_paid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8")).last_heartbeat.hash, null);
});

test("live execute archives heartbeat and does not invent a hash when submit fails", async () => {
  const now = new Date("2026-09-28T18:00:00.000Z");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-live-"));
  fs.mkdirSync(path.join(dir, "market"), { recursive: true });
  fs.writeFileSync(path.join(dir, "market", "pnl.md"), fs.readFileSync(path.join(ROOT, "market", "pnl.md")));
  const archived = [];
  await assert.rejects(
    () => heartbeat.execute({
      state: freshState(now),
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now,
      root: dir,
      live: true,
      history: [],
      submit: async () => ({ result: "tecUNFUNDED_PAYMENT", hash: null }),
      archive(row) {
        archived.push(row);
      },
    }),
    (error) => error.code === "SUBMIT"
  );
  assert.equal(archived.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "lab", "metrics.json")), false);
  const done = await heartbeat.execute({
    state: freshState(now),
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now,
    root: dir,
    live: true,
    history: [],
    submit: async () => ({ result: "tesSUCCESS", hash: HASH.toLowerCase(), ledger_index: 21103001 }),
    archive(row) {
      archived.push(row);
    },
  });
  assert.equal(done.hash, HASH);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].action, "heartbeat");
  assert.equal(archived[0].event, "heartbeat");
  assert.equal(archived[0].result, "tesSUCCESS");
  assert.equal(archived[0].hash, HASH);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "lab", "metrics.json"), "utf8"));
  assert.equal(saved.last_heartbeat.hash, HASH);
  assert.equal(saved.last_heartbeat.ledger_index, 21103001);
});
