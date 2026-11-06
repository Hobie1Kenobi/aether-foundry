"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exclusive, coded } = require("./ledger");
const { publicFeed, publicReplay } = require("./engine");
const { assertPublic } = require("./redact");

const VERSION = 1;
const SNAPSHOT_NAME = "public-status.json";
const STATE_NAME = "publish-state.json";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "integrity") continue;
    out[key] = stable(value[key]);
  }
  return out;
}

function integrityOf(doc) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(doc))).digest("hex");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAtomic(file, value) {
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function publish(dir, now) {
  const clock = now || new Date().toISOString();
  return exclusive(dir, () => {
    const status = publicFeed(dir, clock);
    if (status.source !== "ledger") throw coded("refusing to publish without a ledger", "UNAVAILABLE");
    const stateFile = path.join(dir, STATE_NAME);
    const snapFile = path.join(dir, SNAPSHOT_NAME);
    const state = readJson(stateFile) || { version: VERSION, sequence: 0, integrity: "" };
    const previous = readJson(snapFile);
    if (previous && Number(previous.sequence) !== Number(state.sequence)) {
      throw coded("publish state and snapshot sequence diverged", "OUT_OF_ORDER");
    }
    const sequence = Number(state.sequence) + 1;
    if (!Number.isInteger(sequence) || sequence < 1) throw coded("publish sequence is invalid", "OUT_OF_ORDER");
    if (previous && Number(previous.sequence) >= sequence) {
      throw coded("refusing an out-of-order snapshot", "OUT_OF_ORDER");
    }
    const replays = {};
    for (const mission of status.missions) {
      replays[mission.id] = publicReplay(dir, mission.id).events;
    }
    const fingerprint = integrityOf({
      spending_enabled: status.spending_enabled,
      live_spend_drops: status.live_spend_drops,
      reserved_drops: status.reserved_drops,
      uncertain_drops: status.uncertain_drops,
      accounted_spent_drops: status.accounted_spent_drops,
      killed: status.killed,
      missions: status.missions,
      replays,
    });
    if (state.content_hash && state.content_hash === fingerprint && previous) {
      return Object.assign({ changed: false }, previous);
    }
    const body = {
      schema: "aether.missions.public-status",
      version: VERSION,
      sequence,
      prev_sequence: Number(state.sequence),
      source_observed_at: status.source_observed_at,
      published_at: clock,
      spending_enabled: status.spending_enabled,
      spending_enabled_source: "ledger",
      signing_enabled: false,
      authorized_per_mission_drops: status.authorized_per_mission_drops,
      authorized_daily_drops: status.authorized_daily_drops,
      timezone: status.timezone,
      live_spend_drops: status.live_spend_drops,
      reserved_drops: status.reserved_drops,
      uncertain_drops: status.uncertain_drops,
      accounted_spent_drops: status.accounted_spent_drops,
      killed: status.killed,
      missions: status.missions,
      replays,
      integrity_means: "sha256 of this document; detects corruption, not who wrote it",
      sequence_means: "prev_sequence must equal sequence-1 inside this file. A stateless reader cannot tell a replaced chain from a real one.",
    };
    assertPublic(body);
    body.integrity = integrityOf(body);
    writeAtomic(snapFile, body);
    writeAtomic(stateFile, { version: VERSION, sequence, integrity: body.integrity, content_hash: fingerprint });
    return Object.assign({ changed: true }, body);
  });
}

function follow(dir, opts) {
  const options = opts || {};
  const env = options.env || {};
  const published = publish(dir, options.now);
  if (published.changed === false) return { changed: false, committed: false, sequence: published.sequence };
  if (env.FOUNDRY_MISSION_PUBLISH !== "yes") return { changed: true, committed: false, sequence: published.sequence };
  const exec = options.exec;
  if (typeof exec !== "function") throw coded("refusing to commit without an explicit git runner", "PUBLISH");
  exec(["git", "add", "--", "lab/missions/public-status.json"]);
  exec(["git", "commit", "-m", "Publish sanitized mission snapshot"]);
  return { changed: true, committed: true, pushed: false, sequence: published.sequence };
}

if (require.main === module) {
  const { spawnSync } = require("child_process");
  const dir = path.join(process.cwd(), "lab", "missions");
  try {
    const result = follow(dir, {
      env: process.env,
      exec(argv) {
        const child = spawnSync(argv[0], argv.slice(1), { cwd: process.cwd(), encoding: "utf8" });
        if (child.status !== 0) throw coded("git publish failed", "PUBLISH");
      },
    });
    process.stdout.write(`${JSON.stringify({ changed: Boolean(result.changed), committed: Boolean(result.committed), sequence: result.sequence })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "PUBLISH"}\n`);
    process.exit(1);
  }
}

module.exports = { VERSION, SNAPSHOT_NAME, integrityOf, publish, follow };
