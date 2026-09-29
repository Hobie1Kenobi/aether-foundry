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
const LIVE_HEARTBEAT = "CE97193B6EA982225DD7EDDF09C8A36C5EA7DE35E20F8344B04BC972093BC451";

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

test("live heartbeat only asserts XRPL Testnet id 1", async () => {
  const now = new Date("2026-09-28T18:00:00.000Z");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-xrpl-"));
  let submits = 0;
  let captured = "";
  const code = await heartbeat.run(["--live"], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now,
    state: freshState(now),
    root: dir,
    history: [],
    recordMetrics: false,
    submit: async () => {
      submits += 1;
      return { result: "tesSUCCESS", hash: HASH, ledger_index: 21103002 };
    },
    archive() {},
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(submits, 1);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "live");
  assert.equal(body.network, "xrpl:1");
  assert.equal(body.hash, HASH);
  assert.equal(body.signed, true);
  const source = fs.readFileSync(path.join(ROOT, "src/runtime/actions/heartbeat.js"), "utf8");
  assert.equal(source.includes("XAHAU_HTTP"), false);
  assert.equal(source.includes("XAHAU_NETWORK_ID"), false);
  assert.equal(source.includes('kind: "xahau"'), false);
  assert.equal(policy.assertAltnet({
    networkId: anchors.XAHAU_NETWORK_ID,
    url: anchors.XAHAU_HTTP,
    kind: "xahau",
  }), undefined);
  assert.throws(
    () => policy.assertAltnet({ url: anchors.XAHAU_HTTP, networkId: anchors.XAHAU_NETWORK_ID }),
    (error) => error.code === "MAINNET" && /Xahau host for W6 XRPL grants/.test(error.message)
  );
  assert.throws(
    () => policy.assertAltnet({
      url: anchors.XRPL_HTTP,
      networkId: 1,
      kind: "xahau",
    }),
    (error) => error.code === "MAINNET" && /non-Xahau-Testnet/.test(error.message)
  );
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
  assert.equal(committed.last_heartbeat_hash, LIVE_HEARTBEAT);
  assert.equal(committed.last_heartbeat.hash, LIVE_HEARTBEAT);
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8")).last_heartbeat.hash, LIVE_HEARTBEAT);
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

const ORACLE_ID = "7CD1AB908C3A8D2E3C426E0D3083F4DD9A8A3A753AA60EB73682AA11A06DFA4E";
const ORACLE_TX = "B11B0B87A7C40AFA98540D2F40FF234384466729F90E259E60162714DC4DDE85";
const MPT_ID = "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED";
const DOMAIN_ID = "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4";
const NEXT_HEARTBEAT = "CE".repeat(32);

function frontierDoc(heartbeatHash) {
  return {
    updated_at: "2026-09-29T09:34:05-05:00",
    x402_hits: 0,
    x402_outbound_hits: 1,
    grants_paid: 2,
    inbound_counterparties: 2,
    last_grant_hash: "C75E0AC13941DADBE8B52FE8A7DFF9F8855F150C84613A4FB95B09F1BE3AEAA3",
    last_outbound_hash: "D621848B4C66A940CA0DA51507D61A95D7546B4BB46E7925FC1D6FB414090C4C",
    last_heartbeat_hash: heartbeatHash,
    last_heartbeat: {
      hash: heartbeatHash,
      ledger_index: 21145575,
      ts: "2026-09-29T14:34:05.297Z",
    },
    oracle_id: ORACLE_ID,
    last_oracle: {
      hash: ORACLE_TX,
      oracle_id: ORACLE_ID,
      ledger_index: 21129718,
      last_update_time: 1790639158,
      quote_xrp_per_aeth: "0.01022008",
      ts: "2026-09-28T23:45:58.839Z",
    },
    mpt_issuance_id: MPT_ID,
    domain_id: DOMAIN_ID,
  };
}

function seedFrontier(dir) {
  fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
  fs.mkdirSync(path.join(dir, "market"), { recursive: true });
  fs.writeFileSync(path.join(dir, "market", "pnl.md"), fs.readFileSync(path.join(ROOT, "market", "pnl.md")));
  fs.writeFileSync(
    path.join(dir, "lab", "metrics.json"),
    `${JSON.stringify(frontierDoc(LIVE_HEARTBEAT), null, 2)}\n`
  );
}

function assertFrontierKept(doc) {
  assert.equal(doc.oracle_id, ORACLE_ID);
  assert.equal(doc.last_oracle.hash, ORACLE_TX);
  assert.equal(doc.last_oracle.oracle_id, ORACLE_ID);
  assert.equal(doc.last_oracle.quote_xrp_per_aeth, "0.01022008");
  assert.equal(doc.mpt_issuance_id, MPT_ID);
  assert.equal(doc.domain_id, DOMAIN_ID);
}

test("a partial heartbeat rewrite keeps frontier ids from the previous file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-partial-"));
  seedFrontier(dir);
  const partial = frontierDoc(NEXT_HEARTBEAT);
  delete partial.oracle_id;
  delete partial.last_oracle;
  delete partial.mpt_issuance_id;
  delete partial.domain_id;
  partial.updated_at = "2026-09-29T15:52:23-05:00";
  partial.last_heartbeat = {
    hash: NEXT_HEARTBEAT,
    ledger_index: 21152365,
    ts: "2026-09-29T20:52:23.002Z",
  };
  const written = metrics.writeMetrics(dir, partial);
  assertFrontierKept(written);
  assert.equal(written.last_heartbeat.hash, NEXT_HEARTBEAT);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, "lab", "metrics.json"), "utf8"));
  assertFrontierKept(disk);
  for (const key of metrics.FRONTIER_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(disk, key), true);
  }
  const nulled = frontierDoc(NEXT_HEARTBEAT);
  nulled.oracle_id = null;
  nulled.last_oracle = null;
  nulled.mpt_issuance_id = null;
  nulled.domain_id = null;
  const kept = metrics.writeMetrics(dir, nulled);
  assertFrontierKept(kept);
  const clearing = frontierDoc(NEXT_HEARTBEAT);
  clearing.oracle_id = null;
  clearing.last_oracle = null;
  clearing.mpt_issuance_id = null;
  clearing.domain_id = null;
  const cleared = metrics.writeMetrics(dir, clearing, null, { clear: ["domain_id"] });
  assert.equal(cleared.domain_id, null);
  assert.equal(cleared.mpt_issuance_id, MPT_ID);
  assert.equal(cleared.oracle_id, ORACLE_ID);
  assert.equal(cleared.last_oracle.hash, ORACLE_TX);
  const text = fs.readFileSync(path.join(dir, "lab", "metrics.json"), "utf8");
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(text), "domain_id"), true);
});

test("recordHeartbeat and refresh keep frontier ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-keep-"));
  seedFrontier(dir);
  const now = new Date("2026-09-29T20:52:23.002Z");
  const beaten = metrics.recordHeartbeat(dir, {
    hash: NEXT_HEARTBEAT,
    ledger_index: 21152365,
    ts: "2026-09-29T20:52:23.002Z",
    now,
  });
  assertFrontierKept(beaten);
  assert.equal(beaten.last_heartbeat.hash, NEXT_HEARTBEAT);
  assert.equal(beaten.last_heartbeat.ledger_index, 21152365);
  fs.appendFileSync(
    path.join(dir, "lab", "ledger-log.jsonl"),
    `${JSON.stringify({
      ts: "2026-09-29T20:52:23.002Z",
      source: "agent-signer",
      action: "heartbeat",
      hash: NEXT_HEARTBEAT,
      ledger_index: 21152365,
      result: "tesSUCCESS",
    })}\n`
  );
  const refreshed = metrics.refresh(dir, { now });
  assertFrontierKept(refreshed);
  assert.equal(refreshed.last_heartbeat.hash, NEXT_HEARTBEAT);
  const replaced = metrics.recordOracle(dir, {
    hash: "CD".repeat(32),
    oracle_id: "EF".repeat(32),
    quote_xrp_per_aeth: "0.02000000",
    ledger_index: 21153000,
    last_update_time: 1790700000,
    ts: "2026-09-29T21:00:00.000Z",
    now,
  });
  assert.equal(replaced.oracle_id, "EF".repeat(32));
  assert.equal(replaced.last_oracle.hash, "CD".repeat(32));
  assert.equal(replaced.mpt_issuance_id, MPT_ID);
  assert.equal(replaced.domain_id, DOMAIN_ID);
});
