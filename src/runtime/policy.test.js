"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const guard = require("../x402-outbound-guard");
const policy = require("./policy");
const daemon = require("./daemon");
const remint = require("./actions/remint");
const heartbeat = require("./actions/heartbeat");
const snapshot = require("./actions/snapshot");

const ROOT = path.resolve(__dirname, "..", "..");
const STRANGER = "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss";
const DAY30 = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const FOREIGN = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
const FRESH = new Date("2026-09-29T05:00:00.000Z");

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

describe("allowlist", () => {
  it("matches the hardcoded spec and public anchors", () => {
    const doc = policy.loadAllowlist();
    assert.equal(doc.network_id, 1);
    assert.deepEqual(doc.refused_network_ids, [0, 21337]);
    assert.equal(doc.actions.walk_in_remint.address, anchors.WALLETS.W2.address);
    assert.equal(doc.actions.walk_in_remint.key_env, "W2_REGULAR_SEED");
    assert.equal(doc.actions.walk_in_remint.max_offer_drops, "10000000");
    assert.equal(doc.actions.grant_pay.address, anchors.WALLETS.W6.address);
    assert.equal(doc.actions.grant_pay.key_env, "W6_REGULAR_SEED");
    assert.equal(doc.actions.grant_pay.max_drops, "1000000");
    assert.equal(doc.actions.heartbeat.address, anchors.WALLETS.W5.address);
    assert.equal(doc.actions.heartbeat.key_env, "W5_REGULAR_SEED");
    assert.equal(doc.actions.heartbeat.default_drops, "1");
    assert.equal(doc.actions.heartbeat.max_drops, "1000");
    assert.deepEqual(doc.actions.heartbeat.destination_addresses, [
      anchors.WALLETS.W3.address,
      anchors.WALLETS.W6.address,
    ]);
    assert.equal(doc.actions.x402_outbound.address, anchors.WALLETS.W3.address);
    assert.equal(doc.actions.x402_outbound.key_env, "W3_REGULAR_SEED");
    assert.equal(doc.actions.x402_outbound.max_drops, "500000");
    assert.equal(doc.actions.director_snapshot.key_env, null);
    assert.equal(doc.actions.director_snapshot.max_drops, "0");
    assert.equal(doc.actions.director_snapshot.signs, false);
    assert.equal(doc.actions.director_snapshot.account, null);
  });

  it("rejects seed key names and seed-shaped values", () => {
    throwsCode(() => policy.assertNoSeedFields({ seed: "x" }), "SCHEMA");
    throwsCode(() => policy.assertNoSeedFields({ private_key: "x" }), "SCHEMA");
    throwsCode(() => policy.assertNoSeedFields({ W2_REGULAR_SEED: "x" }), "SCHEMA");
    const shaped = `s${"n".repeat(28)}`;
    throwsCode(() => policy.assertNoSeedFields({ note: shaped }), "SCHEMA");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allow-"));
    const file = path.join(dir, "allowlist.json");
    fs.writeFileSync(file, JSON.stringify({ seed: "x" }));
    throwsCode(() => policy.loadAllowlist(file), "SCHEMA");
  });
});

describe("refusals", () => {
  it("refuses CI, GITHUB_ACTIONS, and CI=1", () => {
    for (const env of [{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true", FOUNDRY_DAEMON_LIVE: "yes" }]) {
      throwsCode(() => policy.assertLiveGate(env), "CI");
    }
    throwsCode(() => policy.assertLiveGate({ FOUNDRY_DAEMON_LIVE: "no" }), "LIVE_GATE");
    throwsCode(() => policy.assertNotCi({ CI: "true" }), "CI");
  });

  it("refuses mainnet network ids and hosts", () => {
    throwsCode(() => policy.assertAltnet({ networkId: 0 }), "MAINNET");
    throwsCode(() => policy.assertAltnet({ networkId: 21337 }), "MAINNET");
    throwsCode(() => policy.assertAltnet({ networkId: "0", url: anchors.XRPL_HTTP }), "MAINNET");
    for (const url of [
      "https://s1.ripple.com",
      "https://xrplcluster.com",
      "wss://xrpl.ws",
      "https://xrpl.link/status",
      "https://xahau.network",
    ]) {
      throwsCode(() => policy.assertAltnet({ url, signing: false }), "MAINNET");
    }
    assert.equal(policy.assertAltnet({ networkId: 1, url: anchors.XRPL_HTTP }), undefined);
  });

  it("validates Xahau with the Xahau assert and refuses the wrong kind", () => {
    assert.equal(anchors.XAHAU_NETWORK_ID, 21338);
    assert.equal(policy.assertAltnet({
      networkId: anchors.XAHAU_NETWORK_ID,
      url: anchors.XAHAU_HTTP,
      kind: "xahau",
    }), undefined);
    assert.equal(policy.assertAltnet({
      networkId: anchors.XAHAU_NETWORK_ID,
      url: anchors.XAHAU_WS,
      kind: "xahau",
      signing: false,
    }), undefined);
    assert.throws(
      () => policy.assertAltnet({ url: anchors.XAHAU_HTTP, networkId: anchors.XAHAU_NETWORK_ID }),
      (error) => error.code === "MAINNET" && /Xahau host for W6 XRPL grants/.test(error.message)
    );
    assert.throws(
      () => policy.assertAltnet({ url: anchors.XAHAU_WS, kind: "xrpl" }),
      (error) => error.code === "MAINNET" && /Xahau host for W6 XRPL grants/.test(error.message)
    );
    throwsCode(() => policy.assertAltnet({
      url: anchors.XRPL_HTTP,
      networkId: anchors.XAHAU_NETWORK_ID,
      kind: "xahau",
    }), "MAINNET");
    throwsCode(() => policy.assertAltnet({
      url: anchors.XRPL_HTTP,
      kind: "xahau",
      signing: false,
    }), "MAINNET");
    throwsCode(() => policy.assertAltnet({
      url: anchors.XAHAU_HTTP,
      networkId: anchors.XRPL_NETWORK_ID,
      kind: "xahau",
    }), "MAINNET");
    throwsCode(() => policy.assertAltnet({
      url: "https://xahau.network",
      networkId: anchors.XAHAU_NETWORK_ID,
      kind: "xahau",
    }), "MAINNET");
  });

  it("refuses circular W3 to W3 and a missing 402", () => {
    throwsCode(() => policy.assertOutbound({
      has402: true,
      payTo: anchors.WALLETS.W3.address,
      drops: "10",
      network: "xrpl:1",
      index: guard.foundryIndex(),
    }), "CIRCULAR");
    throwsCode(() => policy.assertOutbound({
      has402: false,
      payTo: FOREIGN,
      drops: "10",
    }), "MISSING_402");
    throwsCode(() => policy.assertOutbound({
      has402: true,
      payTo: FOREIGN,
      drops: "10",
      network: "xrpl:0",
      index: guard.foundryIndex(),
    }), "MAINNET");
    assert.equal(policy.assertOutbound({
      has402: true,
      payTo: FOREIGN,
      drops: "500000",
      network: "xrpl:1",
      index: guard.foundryIndex(),
    }), "500000");
  });

  it("refuses labeled grants, including STRANGER", () => {
    throwsCode(() => policy.assertGrant({
      destination: STRANGER,
      drops: "1000000",
      index: guard.foundryIndex(),
    }), "LABELED");
    throwsCode(() => policy.assertGrant({
      destination: anchors.WALLETS.W0.address,
      drops: "1000000",
      index: guard.foundryIndex(),
    }), "LABELED");
    throwsCode(() => policy.assertGrant({
      destination: anchors.WALLETS.W6.address,
      drops: "1000000",
      index: guard.foundryIndex(),
    }), "LABELED");
  });

  it("refuses a grant at or above 50 XRP even when a motion matches", () => {
    const motion = `destination: ${DAY30}\namount_drops: 50000000\n`;
    throwsCode(() => policy.assertGrant({
      destination: DAY30,
      drops: "50000000",
      motions: [{ text: motion }],
      index: guard.foundryIndex(),
    }), "FIFTY_XRP");
    throwsCode(() => policy.assertGrant({
      destination: DAY30,
      drops: "1000001",
      index: guard.foundryIndex(),
    }), "CAP");
  });

  it("refuses a grant that would leave W6 under 10 XRP spendable", () => {
    throwsCode(() => policy.assertGrant({
      destination: DAY30,
      drops: "1000000",
      index: guard.foundryIndex(),
      w6: {
        balance: "11000000",
        ownerCount: 0,
        reserveBase: "1000000",
        reserveInc: "200000",
      },
    }), "FLOAT");
  });

  it("refuses remint while the offer is open or offer_count is at least 1", () => {
    throwsCode(() => policy.assertRemint({ status: "open", offer_count: 1 }), "OFFER_OPEN");
    throwsCode(() => policy.assertRemint({ status: "open", offer_count: 0 }), "OFFER_OPEN");
    throwsCode(() => policy.assertRemint({ status: "sold_out", offer_count: 1 }), "OFFER_OPEN");
    assert.equal(policy.assertRemint({ status: "sold_out", offer_count: 0 }), undefined);
    const open = remint.plan({
      state: {
        updated_at: "2026-09-28T12:00:00-05:00",
        watched: { walk_in_offer: { status: "open", offer_count: 1 } },
      },
      now: FRESH,
    });
    assert.equal(open.allow, false);
    assert.equal(open.code, "OFFER_OPEN");
    assert.equal(open.tx, null);
    const sold = remint.plan({
      state: {
        updated_at: "2026-09-28T12:00:00-05:00",
        watched: {
          walk_in_offer: { status: "sold_out", offer_count: 0 },
          batch: { atomic_enabled: false },
        },
      },
      now: FRESH,
    });
    assert.equal(sold.allow, true);
    assert.equal(sold.submitted, false);
    assert.equal(Object.hasOwn(sold.tx.createOffer, "Destination"), false);
    assert.equal(sold.tx.createOffer.Amount, "10000000");
    const built = remint.buildUnsigned();
    assert.equal(Object.hasOwn(built.createOffer, "Destination"), false);
    assert.equal(built.createOffer.Amount, "10000000");
    assert.equal(built.mint.NFTokenTaxon, 20260927);
    assert.equal(built.mint.Account, anchors.WALLETS.W2.address);
  });

  it("refuses signing on stale director state", () => {
    const stale = { updated_at: "2026-09-01T00:00:00-05:00" };
    throwsCode(() => policy.assertFreshForSign(stale, FRESH), "STALE");
    assert.equal(policy.isStale(stale, FRESH), true);
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "director-state.json"), "utf8"));
    assert.equal(policy.isStale(state, FRESH), false);
  });

  it("refuses Batch, escrow finish, and W0", () => {
    const state = { watched: { batch: { atomic_enabled: false } } };
    throwsCode(() => policy.assertSigningTx({ TransactionType: "Batch", Account: anchors.WALLETS.W5.address }, state), "BATCH");
    throwsCode(() => policy.assertSigningTx({ TransactionType: "EscrowFinish", Account: anchors.WALLETS.W4.address }), "BANNED");
    throwsCode(() => policy.assertSigningTx({ TransactionType: "EscrowCancel", Account: anchors.WALLETS.W4.address }), "BANNED");
    throwsCode(() => policy.assertSigningTx({ TransactionType: "Payment", Account: anchors.WALLETS.W0.address, Amount: "1" }), "W0");
    const planned = snapshot.plan({ stale: false, missing: false });
    assert.equal(planned.signs, false);
    assert.equal(planned.tx, null);
    assert.equal(planned.write, false);
    throwsCode(() => policy.assertSnapshotUnsigned({ TransactionType: "Payment" }), "SIGN");
  });

  it("caps heartbeat and refuses a destination outside W3 and W6", () => {
    const now = new Date("2026-09-28T20:00:00.000Z");
    throwsCode(() => policy.assertHeartbeat({
      drops: "1001",
      destination: anchors.WALLETS.W3.address,
      history: [],
      now,
    }), "CAP");
    throwsCode(() => policy.assertHeartbeat({
      drops: "50000000",
      destination: anchors.WALLETS.W3.address,
      history: [],
      now,
    }), "FIFTY_XRP");
    throwsCode(() => policy.assertHeartbeat({
      drops: "1",
      destination: STRANGER,
      history: [],
      now,
    }), "DEST");
    const crowded = [1, 2, 3, 4].map((hours) => ({
      action: "heartbeat",
      ts: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString(),
    }));
    throwsCode(() => policy.assertHeartbeat({
      drops: "1",
      destination: anchors.WALLETS.W6.address,
      history: crowded,
      now,
    }), "RATE");
    throwsCode(() => policy.assertHeartbeat({
      drops: "1",
      destination: anchors.WALLETS.W3.address,
      history: [{ action: "heartbeat", ts: new Date(now.getTime() - 60 * 60 * 1000).toISOString() }],
      now,
    }), "RATE");
    const tx = heartbeat.buildUnsigned({
      drops: "1",
      destination: anchors.WALLETS.W3.address,
      history: [],
      now,
      ledgerIndex: 21102567,
    });
    assert.equal(tx.Account, anchors.WALLETS.W5.address);
    assert.equal(tx.Destination, anchors.WALLETS.W3.address);
    assert.equal(tx.Amount, "1");
    assert.equal(tx.SourceTag, 202609280);
    const memos = grants.decodeMemos(tx);
    assert.equal(memos.purpose, "aether-heartbeat");
    assert.equal(memos.experiment, "foundry-runtime");
    assert.equal(memos.ledger, "21102567");
  });
});

describe("daemon dry-run", () => {
  it("prints unsigned tx JSON and does not read a seed", async () => {
    let reads = 0;
    let captured = "";
    const code = await daemon.pass({
      argv: ["--dry-run", "--once"],
      env: { CI: "true", W5_REGULAR_SEED: "present-not-used", AETHER_SECRETS: path.join(os.tmpdir(), "missing-secrets.env") },
      now: FRESH,
      loadSeed: () => {
        reads += 1;
        return "present-not-used";
      },
      stdout: (text) => {
        captured = text;
      },
    });
    assert.equal(code, 0);
    assert.equal(reads, 0);
    assert.equal(captured.includes("present-not-used"), false);
    const body = JSON.parse(captured);
    assert.equal(body.mode, "dry-run");
    assert.equal(body.signed, false);
    assert.equal(body.key_loaded, false);
    assert.equal(body.network_id, 1);
    const byName = Object.fromEntries(body.plans.map((row) => [row.action, row]));
    assert.equal(byName.walk_in_remint.allow, false);
    assert.equal(byName.walk_in_remint.code, "OFFER_OPEN");
    assert.equal(byName.walk_in_remint.tx, null);
    assert.equal(byName.director_snapshot.signs, false);
    assert.equal(byName.director_snapshot.tx, null);
    assert.equal(byName.director_snapshot.write, false);
    assert.equal(byName.heartbeat.allow, true);
    assert.equal(byName.heartbeat.tx.TransactionType, "Payment");
    assert.equal(byName.heartbeat.tx.Amount, "1");
    assert.equal(byName.heartbeat.submitted, false);
    assert.equal(byName.x402_outbound.code, "NOT_NAMED");
    assert.equal(byName.x402_outbound.tx, null);
  });

  it("returns 2 on stale state without reading a seed", async () => {
    let reads = 0;
    const code = await daemon.pass({
      argv: ["--dry-run", "--once"],
      env: {},
      now: new Date("2026-10-05T00:00:00.000Z"),
      loadSeed: () => {
        reads += 1;
        return "";
      },
      stdout: () => {},
    });
    assert.equal(code, 2);
    assert.equal(reads, 0);
  });

  it("throws CI for --live and runtime:watch under Actions", () => {
    assert.equal(daemon.parseArgs(["--dry-run", "--once"]).live, false);
    assert.equal(daemon.parseArgs([]).dryRun, true);
    throwsCode(() => daemon.parseArgs(["--dry-run", "--live"]), "ARGS");
    const live = spawnSync(process.execPath, ["src/runtime/daemon.js", "--live", "--once"], {
      cwd: ROOT,
      env: { CI: "true", FOUNDRY_DAEMON_LIVE: "yes" },
      encoding: "utf8",
    });
    assert.equal(live.status, 1);
    assert.match(live.stderr, /CI/);
    const watch = spawnSync(process.execPath, ["src/runtime/daemon.js", "--live"], {
      cwd: ROOT,
      env: { GITHUB_ACTIONS: "true", FOUNDRY_DAEMON_LIVE: "yes" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(watch.status, 1);
    assert.match(watch.stderr, /CI/);
    const ciOne = spawnSync(process.execPath, ["src/runtime/daemon.js", "--live", "--once"], {
      cwd: ROOT,
      env: { CI: "1" },
      encoding: "utf8",
    });
    assert.equal(ciOne.status, 1);
    assert.match(ciOne.stderr, /CI/);
  });
});

describe("pack wiring", () => {
  it("registers the runtime scripts and leaves the detect-only workflow alone", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts["runtime:policy"], "node --test src/runtime/policy.test.js");
    assert.equal(pkg.scripts["runtime:dry"], "node src/runtime/daemon.js --dry-run --once");
    assert.equal(pkg.scripts["runtime:live"], "node src/runtime/daemon.js --live --once");
    assert.equal(pkg.scripts["runtime:watch"], "node src/runtime/daemon.js --live");
    const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "walk-in-remint-watch.yml"), "utf8");
    assert.equal(yml.includes("runtime:live"), false);
    assert.equal(yml.includes("runtime:watch"), false);
    assert.match(yml, /must not mint, sign, or load operator secrets/);
  });
});
