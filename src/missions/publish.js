"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exclusive, coded } = require("./ledger");
const { publicFeed } = require("./engine");
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
    };
    assertPublic(body);
    body.integrity = integrityOf(body);
    writeAtomic(snapFile, body);
    writeAtomic(stateFile, { version: VERSION, sequence, integrity: body.integrity });
    return body;
  });
}

module.exports = { VERSION, SNAPSHOT_NAME, integrityOf, publish };
