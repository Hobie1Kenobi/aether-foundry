"use strict";

/**
 * Issue one unused purchase generation. This does not sign, does not
 * rewrite a prior lease line, and does not change a hold.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { coded, readEvents } = require("./ledger");
const { view } = require("./engine");
const guard = require("./runtime-guard");
const policy = require("./policy");
const config = require("./config");
const { chicagoDay } = require("./clock");
const { HARD_MAX_DROPS } = require("./network-fee");
const { readHistory, assertChain, openGeneration, appendRecord } = require("./lease-chain");

const PHRASE = "AUTHORIZE-ONE-MORE-PURCHASE";
const PERMANENT_HOLD = "msn5b5c3223e5e88526";

function assertNote(note) {
  if (typeof note !== "string") throw coded("operator note is missing", "AUTH");
  const text = note.trim();
  if (text.length < 8 || text.length > 160) throw coded("operator note must be 8 to 160 characters", "AUTH");
  if (/[\u0000-\u001f]/.test(text) || /sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text)) {
    throw coded("operator note is not a public note", "AUTH");
  }
  return text;
}

function assertNoteNotToken(note, token) {
  if (note.includes(token)) throw coded("operator note is not a public note", "AUTH");
  return note;
}

function sameToken(left, right) {
  return typeof left === "string" && typeof right === "string" && left.length > 0 && left === right;
}

function assertAuth(env) {
  guard.assertNoHouseSeeds(env || {});
  const token = env.FOUNDRY_MISSION_AUTHORIZE_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("authorize token is missing", "AUTH");
  if (sameToken(token, env.FOUNDRY_MISSION_EXECUTE_TOKEN) || sameToken(token, env.FOUNDRY_MISSION_RECONCILE_TOKEN)) {
    throw coded("authorize token must be distinct", "AUTH");
  }
  if (env.FOUNDRY_MISSION_AUTHORIZE_PHRASE !== PHRASE) throw coded("authorize phrase is missing", "AUTH");
  return assertNoteNotToken(assertNote(env.FOUNDRY_MISSION_AUTHORIZE_NOTE), token);
}

function workerAsleep(home) {
  const file = path.join(home, "worker.json");
  if (!fs.existsSync(file)) return false;
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  return Boolean(body && body.asleep === true);
}

function unreconciled(mission) {
  if (!mission || mission.id === PERMANENT_HOLD) return false;
  if (mission.complete === true || mission.hold === "released" || mission.hold === "spent") return false;
  return Boolean(
    mission.presigned_hash
    || mission.signed === true
    || mission.submitted === true
    || mission.submit_state
    || mission.signer_accepted === true
  );
}

function assertRoom(dir, now) {
  const state = view(dir, now);
  const blocking = Object.values(state.missions || {}).find(unreconciled);
  if (blocking) {
    const error = coded("a signed claim is still unreconciled", "NO_RETRY");
    error.mission_id = blocking.id;
    throw error;
  }
  const used = policy.dayUsed(state, chicagoDay(now));
  const dailyLeft = config.DAILY_DROPS - used;
  if (dailyLeft < HARD_MAX_DROPS || config.PER_MISSION_DROPS < HARD_MAX_DROPS) {
    throw coded("the caps cannot cover the maximum fee reserve", "CAP");
  }
  return { used: used.toString(), daily_left: dailyLeft.toString() };
}

function authorizeOnce(env, opts) {
  const options = opts || {};
  const source = env || {};
  const now = options.now || new Date().toISOString();
  const note = assertAuth(source);
  const home = guard.assertIsolated(source.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime");
  const ledger = guard.assertIsolated(source.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger"));
  if (!workerAsleep(home)) throw coded("the worker is not asleep", "ASLEEP");
  const history = readHistory(home);
  assertChain(history);
  if (openGeneration(history)) throw coded("a lease generation is still unused", "NO_RETRY");
  const before = readEvents(ledger);
  const room = assertRoom(ledger, now);
  const issued = appendRecord(home, {
    type: "lease.issued",
    lease_id: crypto.randomBytes(16).toString("hex"),
    issued_at: now,
    note,
    max_ticks: 1,
  });
  const after = readEvents(ledger);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw coded("authorization changed the mission ledger", "TAMPER");
  }
  return {
    issued: true,
    lease_id: issued.lease_id,
    max_ticks: 1,
    asleep: true,
    daily_left: room.daily_left,
    permanent_hold: PERMANENT_HOLD,
  };
}

if (require.main === module) {
  try {
    const result = authorizeOnce(process.env);
    process.stdout.write(`${JSON.stringify({
      issued: true,
      lease_id: result.lease_id,
      max_ticks: 1,
      asleep: true,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "AUTH"}\n`);
    process.exit(1);
  }
}

module.exports = {
  PHRASE,
  PERMANENT_HOLD,
  authorizeOnce,
  unreconciled,
};
