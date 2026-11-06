"use strict";

/**
 * One authenticated control tick. Startup stays asleep. This command does
 * not set execute, does not sign, and does not release a held sequence.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { coded } = require("./ledger");
const guard = require("./runtime-guard");
const { admitFile } = require("./challenge-admit");
const { uploadIngest } = require("./desk-publish");

const PHRASE = "WAKE-MISSION-CONTROL";
const LEASE_MS = 10 * 60 * 1000;
const MAX_TICKS = 1;

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readLease(home) {
  const file = path.join(home, "wake.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeLease(home, lease) {
  const file = path.join(home, "wake.json");
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return lease;
}

function authorizeWake(env, now) {
  const source = env || {};
  guard.assertNoHouseSeeds(source);
  if (source.FOUNDRY_MISSION_WAKE_OVERRIDE === "yes" || source.override === "yes") {
    throw coded("operator override does not release a signed claim", "NO_RETRY");
  }
  const token = source.FOUNDRY_MISSION_WAKE_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("wake token is missing", "AUTH");
  if (source.FOUNDRY_MISSION_WAKE_PHRASE !== PHRASE) throw coded("wake phrase is missing", "AUTH");
  const start = Date.parse(now || new Date().toISOString());
  if (!Number.isFinite(start)) throw coded("wake clock is unusable", "AUTH");
  return {
    schema: "aether.missions.wake",
    phrase: PHRASE,
    max_ticks: MAX_TICKS,
    ticks_used: 0,
    execute: false,
    spend: false,
    publish_only: source.FOUNDRY_MISSION_PUBLISH === "yes",
    until: new Date(start + LEASE_MS).toISOString(),
    token_hash: tokenHash(token),
    sequence_policy: "hold",
  };
}

function leaseOpen(lease, now) {
  if (!lease || lease.schema !== "aether.missions.wake") return false;
  if (lease.execute !== false || lease.spend !== false) return false;
  if (lease.phrase !== PHRASE || lease.max_ticks !== 1) return false;
  if (!Number.isInteger(lease.ticks_used) || lease.ticks_used >= lease.max_ticks) return false;
  const until = Date.parse(lease.until);
  const clock = Date.parse(now || new Date().toISOString());
  return Number.isFinite(until) && Number.isFinite(clock) && clock <= until;
}

async function controlTick(home, ledger, env, now, deps) {
  const root = guard.assertIsolated(home);
  const dir = guard.assertIsolated(ledger);
  const current = readLease(root);
  if (!leaseOpen(current, now)) return { control: false, reason: "asleep", execute: false, submitted: false };
  current.ticks_used += 1;
  current.execute = false;
  current.spend = false;
  writeLease(root, current);
  const result = {
    control: true,
    execute: false,
    spend: false,
    submitted: false,
    signed: false,
    complete: false,
    sequence_policy: "hold",
    admitted: false,
    published: { uploaded: false, reason: "publish_off" },
  };
  const challenge = env && env.FOUNDRY_MISSION_CHALLENGE_FILE;
  if (challenge) {
    const admitted = admitFile(dir, challenge, now);
    result.admitted = true;
    result.payable = false;
    result.invoice_id = admitted.event.invoice_id;
    result.discovery_rewritten = false;
  }
  if (env && env.FOUNDRY_MISSION_PUBLISH === "yes") {
    result.published = await uploadIngest(dir, {
      env,
      now,
      fetch: deps && deps.fetch,
      url: deps && deps.url,
    });
  }
  return result;
}

async function wake(env, opts) {
  const options = opts || {};
  const source = env || {};
  const now = options.now || new Date().toISOString();
  const home = guard.assertIsolated(source.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime");
  const ledger = guard.assertIsolated(source.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger"));
  const existing = readLease(home);
  if (
    existing
    && existing.schema === "aether.missions.wake"
    && existing.ticks_used >= 1
    && Date.parse(existing.until) >= Date.parse(now)
  ) {
    throw coded("the control lease is already used", "NO_RETRY");
  }
  writeLease(home, authorizeWake(source, now));
  return controlTick(home, ledger, source, now, options);
}

if (require.main === module) {
  wake(process.env, { fetch: globalThis.fetch })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({
        control: result.control,
        execute: false,
        spend: false,
        submitted: false,
        admitted: result.admitted === true,
        payable: false,
        published: result.published && result.published.uploaded === true,
        reason: result.published && result.published.reason || null,
      })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "AUTH"}\n`);
      process.exit(1);
    });
}

module.exports = {
  PHRASE,
  LEASE_MS,
  authorizeWake,
  leaseOpen,
  controlTick,
  wake,
};
