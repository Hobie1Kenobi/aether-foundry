"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startMission, addStep, control, observe, view } = require("./engine");
const { publish, integrityOf } = require("./publish");
const { chicagoDay } = require("./clock");
const config = require("./config");
const remote = require("../../web/lib/mission-remote");

const FOREIGN = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const LATE_NOV5 = "2026-11-06T05:50:00.000Z";
const EARLY_NOV6 = "2026-11-06T06:05:00.000Z";

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-pub-"));
}

function allow() {
  return { allowlist: { payees: [FOREIGN] }, token: TOKEN };
}

function buy(key, now, extra) {
  return Object.assign(
    {
      idempotency_key: key,
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: FOREIGN }], prompt: "sEdTTTTTTTTTTTTTTTTTTTTTTTT hidden" },
      payment_drops: "100000",
      network_fee_drops: "0",
    },
    extra || {}
  );
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

describe("mission runner", () => {
  it("stays dormant and does not treat signer health as mission spend", () => {
    const { main } = require("./runner");
    const root = dir();
    const body = main({
      FOUNDRY_AGENT_SIGN: "yes",
      MISSION_XRPL_SEED: "",
      FOUNDRY_MISSION_HOME: root,
      FOUNDRY_MISSION_LEDGER: root,
    }, root);
    assert.equal(body.dormant, true);
    assert.equal(body.mission_spend_enabled, false);
    assert.equal(body.signer_health_signing_is_not_mission_enabled, true);
    assert.equal(body.evm_gas, "not_authorized");
    assert.equal(body.mission_seed_present, false);
    assert.equal(body.loop, false);
    assert.equal(body.autonomous, false);
    assert.equal(JSON.stringify(body).includes("sEd"), false);
  });
});

describe("control token", () => {
  it("fails closed when the server token is missing, even if the caller token is also missing", () => {
    const root = dir();
    throwsCode(() => control(root, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: undefined, now: NOW }, { token: undefined }), "AUTH");
    throwsCode(() => control(root, { action: "activate", confirm: config.ACTIVATE_PHRASE, now: NOW }, {}), "AUTH");
    assert.equal(fs.existsSync(path.join(root, "events.jsonl")) ? fs.readFileSync(path.join(root, "events.jsonl"), "utf8").includes("control.activate") : false, false);
    assert.equal(view(root, NOW).spending_enabled, false);
  });
});

describe("caps across steps, processes, and days", () => {
  it("sums repeated steps on one mission against 1 XRP", () => {
    const root = dir();
    const row = startMission(root, buy("step-base", NOW, { payment_drops: "600000" }), allow());
    assert.equal(row.mission.status, "awaiting_human_approval");
    throwsCode(() => addStep(root, { mission_id: row.mission.id, idempotency_key: "step-over-1", now: NOW, payment_drops: "500000", network_fee_drops: "0" }, allow()), "CAP");
    const second = addStep(root, { mission_id: row.mission.id, idempotency_key: "step-fit-01", now: NOW, payment_drops: "400000", network_fee_drops: "0" }, allow());
    assert.equal(second.mission.committed_drops, "1000000");
    assert.equal(second.mission.status, "awaiting_human_approval");
    const again = addStep(root, { mission_id: row.mission.id, idempotency_key: "step-fit-01", now: NOW, payment_drops: "400000", network_fee_drops: "0" }, allow());
    assert.equal(again.replay, true);
    assert.equal(view(root, NOW).days[chicagoDay(NOW)].reserved, "1000000");
  });

  it("keeps an unresolved uncertain hold against the next Chicago day", () => {
    const root = dir();
    const held = startMission(root, buy("carry-hold", LATE_NOV5, { payment_drops: "1000000" }), allow());
    observe(root, { mission_id: held.mission.id, now: LATE_NOV5, observe_key: "carry-obs", report: {} });
    for (let i = 0; i < 4; i += 1) {
      const row = startMission(root, buy(`carry-day-${i}`, EARLY_NOV6, { payment_drops: "1000000" }), allow());
      assert.equal(row.mission.status, "awaiting_human_approval");
    }
    const blocked = startMission(root, buy("carry-over", EARLY_NOV6, { payment_drops: "1000000" }), allow());
    assert.equal(blocked.mission.code, "CAP");
    assert.equal(view(root, EARLY_NOV6).days["2026-11-05"].uncertain, "1000000");
    assert.equal(view(root, EARLY_NOV6).days["2026-11-06"].reserved, "4000000");
  });

  it("serializes reservations across processes", async () => {
    const root = dir();
    const script = path.join(__dirname, "reserve-once.js");
    const opts = JSON.stringify(allow());
    const runs = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(
        (index) =>
          new Promise((resolve, reject) => {
            const input = JSON.stringify(buy(`proc-key-${index}`, NOW, { payment_drops: "1000000" }));
            const child = spawn(process.execPath, [script, root, input, opts], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            child.stdout.on("data", (chunk) => {
              out += chunk;
            });
            child.on("error", reject);
            child.on("exit", (code) => {
              if (code !== 0) reject(new Error(`child ${index} exit ${code}`));
              else resolve(JSON.parse(out));
            });
          })
      )
    );
    assert.equal(runs.filter((row) => row.status === "awaiting_human_approval").length, 5);
    assert.equal(runs.filter((row) => row.code === "CAP").length, 1);
    assert.equal(view(root, NOW).days[chicagoDay(NOW)].reserved, "5000000");
  });
});

describe("sanitized snapshot publish and desk read", () => {
  it("publishes a sequenced snapshot and refuses an out-of-order rewrite", () => {
    const root = dir();
    startMission(root, buy("publish-key-1", NOW, { payment_drops: "15" }), allow());
    const first = publish(root, NOW);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "public-status.json"), "utf8"));
    assert.equal(first.sequence, 1);
    assert.equal(first.prev_sequence, 0);
    assert.equal(first.version, 1);
    assert.equal(stored.integrity, integrityOf(stored));
    assert.equal(remote.integrityOf(stored), stored.integrity);
    assert.equal(JSON.stringify(first).includes("hidden"), false);
    const same = publish(root, NOW);
    assert.equal(same.changed, false);
    assert.equal(same.sequence, 1);
    startMission(root, buy("publish-key-2", NOW, { payment_drops: "15" }), allow());
    const second = publish(root, NOW);
    assert.equal(second.changed, true);
    assert.equal(second.sequence, 2);
    const snap = path.join(root, "public-status.json");
    const state = path.join(root, "publish-state.json");
    const broken = JSON.parse(fs.readFileSync(snap, "utf8"));
    broken.sequence = 9;
    fs.writeFileSync(snap, JSON.stringify(broken));
    throwsCode(() => publish(root, NOW), "OUT_OF_ORDER");
    assert.equal(fs.existsSync(state), true);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), "public-status.json")), false);
  });

  it("treats a missing, failed, timed out, or inconsistent snapshot as unavailable", async () => {
    const sha = "a".repeat(40);
    function respond(status, body, fail) {
      return async (url) => {
        if (fail) throw fail;
        const isHead = String(url).includes("/commits/main");
        return {
        ok: (isHead ? 200 : status) === 200,
        status: isHead ? 200 : status,
          json: async () => (isHead ? { sha } : body),
        };
      };
    }
    const missing = await remote.fetchPublished(respond(404, {}), NOW, { repo: "Hobie1Kenobi/aether-foundry" });
    assert.equal(missing.source, "unavailable");
    assert.equal(missing.live_spend_drops, null);
    assert.equal(missing.error, "unavailable");
    const upstream = await remote.fetchPublished(respond(500, {}), NOW, { repo: "Hobie1Kenobi/aether-foundry" });
    assert.equal(upstream.error, "upstream");
    assert.equal(upstream.live_spend_drops, null);
    const timed = await remote.fetchPublished(respond(200, {}, Object.assign(new Error("timed out"), { name: "TimeoutError" })), NOW, {
      repo: "Hobie1Kenobi/aether-foundry",
    });
    assert.equal(timed.error, "timeout");
    const root = dir();
    startMission(root, buy("remote-key-1", NOW, { payment_drops: "20" }), allow());
    publish(root, NOW);
    const doc = JSON.parse(fs.readFileSync(path.join(root, "public-status.json"), "utf8"));
    const ok = await remote.fetchPublished(
      async (url) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/commits/main") ? { sha } : doc),
      }),
      NOW,
      { repo: "Hobie1Kenobi/aether-foundry" }
    );
    assert.equal(ok.source, "git");
    assert.equal(ok.source_commit, sha);
    assert.equal(ok.live_spend_drops, "0");
    assert.equal(ok.authenticity, "unsigned");
    assert.match(String(ok.sequence_means), /cannot tell a replaced chain/);
    const gap = Object.assign({}, doc, { sequence: 4, prev_sequence: 2 });
    delete gap.integrity;
    gap.integrity = remote.integrityOf(gap);
    const ordered = await remote.fetchPublished(
      async (url) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/commits/main") ? { sha } : gap),
      }),
      NOW,
      { repo: "Hobie1Kenobi/aether-foundry" }
    );
    assert.equal(ordered.error, "out_of_order");
    assert.equal(ordered.live_spend_drops, null);
    const detail = remote.routeFromPublished(ok, "detail", doc.missions[0].id);
    const replay = remote.routeFromPublished(ok, "replay", doc.missions[0].id);
    assert.equal(detail.body.source, "git");
    assert.equal(detail.body.mission.id, doc.missions[0].id);
    assert.equal(replay.body.source, "git");
    assert.ok(Array.isArray(replay.body.events));
    const replaced = Object.assign({}, doc, { sequence: 1, prev_sequence: 0 });
    delete replaced.integrity;
    replaced.integrity = remote.integrityOf(replaced);
    const stateless = remote.verify(replaced, NOW);
    assert.equal(stateless.ok, true);
    assert.equal(stateless.body.authenticity, "unsigned");
    const raw = String(await (async () => {
      const seen = [];
      await remote.fetchPublished(
        async (url) => {
          seen.push(String(url));
          return { ok: true, status: 200, json: async () => ({ sha }) };
        },
        NOW,
        { repo: "Hobie1Kenobi/aether-foundry" }
      );
      return seen.join(" ");
    })());
    assert.equal(raw.includes(`/${sha}/lab/missions/public-status.json`) || raw.includes("/commits/main"), true);
    assert.equal(raw.includes("raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/"), false);
  });
});
