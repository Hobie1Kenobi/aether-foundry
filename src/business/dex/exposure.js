"use strict";

/**
 * One RLUSD exposure sum for W1, W3, and W4.
 * Each mission id is counted once. Released rows are not exposure.
 * An in-flight uncertain hold on another role blocks new risk.
 */

const bankroll = require("../bankroll");
const bounds = require("./bounds");

const KINDS = {
  W1: "w1-rlusd",
  W3: "w3-rlusd",
  W4: "w4-rlusd",
};
const ALL = new Set(Object.values(KINDS));
const TEAM_CAP_DROPS = bounds.TEAM_RLUSD_CAP_DROPS;
const ROLE_CAP = bounds.ROLE_RLUSD_CAP;
const IN_FLIGHT = new Set(["rlusd_reserved", "rlusd_unknown"]);
const LEGACY_HOLD = "msn5b5c3223e5e88526";

function drops(value) {
  if (typeof value === "bigint") return value >= 0n ? value : 0n;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return 0n;
}

function ownerOf(mission) {
  if (!mission) return null;
  if (mission.role === "W1" || mission.role === "W3" || mission.role === "W4") return mission.role;
  if (mission.kind === KINDS.W1) return "W1";
  if (mission.kind === KINDS.W3) return "W3";
  if (mission.kind === KINDS.W4) return "W4";
  return null;
}

function rows(state) {
  const seen = new Set();
  const out = [];
  for (const mission of Object.values((state && state.missions) || {})) {
    if (!mission || !ALL.has(mission.kind)) continue;
    if (mission.id === LEGACY_HOLD) continue;
    if (mission.id) {
      if (seen.has(mission.id)) continue;
      seen.add(mission.id);
    }
    out.push(mission);
  }
  return out;
}

function countsOpen(mission) {
  if (!mission || mission.hold === "released") return false;
  if (mission.action === "trust" && mission.status === "rlusd_proved") return false;
  if (mission.action === "swap" && mission.status === "rlusd_proved") return false;
  if (mission.action === "cancel" && mission.status === "rlusd_proved") return false;
  return true;
}

function teamOpen(state) {
  return rows(state).reduce((sum, mission) => sum + (countsOpen(mission) ? drops(mission.outstanding_drops) : 0n), 0n);
}

function roleOpen(state, role) {
  return rows(state).reduce((sum, mission) => {
    if (ownerOf(mission) !== role) return sum;
    return sum + (countsOpen(mission) ? drops(mission.outstanding_drops) : 0n);
  }, 0n);
}

function blocksNewRisk(state, role) {
  for (const mission of rows(state)) {
    if (mission.hold !== "uncertain") continue;
    if (!IN_FLIGHT.has(mission.status)) continue;
    if (ownerOf(mission) === role) continue;
    return true;
  }
  return false;
}

function boundedCap(cap) {
  if (typeof cap !== "bigint" || cap <= 0n || cap > TEAM_CAP_DROPS) return TEAM_CAP_DROPS;
  return cap;
}

function allows(state, role, add, cap) {
  if (blocksNewRisk(state, role)) return false;
  const addDrops = typeof add === "bigint" ? add : 0n;
  if (addDrops < 0n) return false;
  const limit = boundedCap(cap);
  if (teamOpen(state) + addDrops > limit) return false;
  const roleCap = ROLE_CAP[role];
  if (typeof roleCap !== "bigint") return false;
  if (roleOpen(state, role) + addDrops > roleCap) return false;
  return true;
}

function tighterRoom(state, role, cap) {
  const limit = boundedCap(cap);
  const team = teamOpen(state);
  const mine = roleOpen(state, role);
  const teamRoom = limit > team ? limit - team : 0n;
  const roleCap = ROLE_CAP[role] || 0n;
  const roleRoom = roleCap > mine ? roleCap - mine : 0n;
  return teamRoom < roleRoom ? teamRoom : roleRoom;
}

function sumKind(state, accept, releasedLoss) {
  const seen = new Set();
  let extra = 0n;
  for (const mission of Object.values((state && state.missions) || {})) {
    if (!mission || mission.id === LEGACY_HOLD || !accept(mission)) continue;
    if (mission.id) {
      if (seen.has(mission.id)) continue;
      seen.add(mission.id);
    }
    const loss = drops(mission.realized_loss_drops);
    if (mission.hold === "released") {
      if (releasedLoss) extra += loss;
      continue;
    }
    extra += drops(mission.outstanding_drops) + loss;
  }
  return extra;
}

function ledgerHeadroom(state) {
  const mark = state && state.missions && state.missions["bankroll-lp-high-water"];
  if (mark && typeof mark.proved_xrp_drops === "string" && /^[0-9]+$/.test(mark.proved_xrp_drops)) {
    const proved = BigInt(mark.proved_xrp_drops);
    let rlusd = sumKind(state, (mission) => ALL.has(mission.kind), true);
    const overlap = drops(mark.rlusd_overlap_drops);
    if (overlap > 0n && rlusd > overlap) rlusd -= overlap;
    const used = proved + rlusd;
    const headroom = used >= bankroll.BANKROLL_DROPS ? 0n : bankroll.BANKROLL_DROPS - used;
    return { used, headroom, proved_xrp: proved };
  }
  let base = 0n;
  if (mark && typeof mark.lp_high_water_drops === "string" && /^[0-9]+$/.test(mark.lp_high_water_drops)) {
    base = BigInt(mark.lp_high_water_drops);
  }
  const extra = sumKind(state, (mission) => {
    const kind = mission.kind;
    return kind === "w1-dex-offer" || kind === "w1-amm-lp" || ALL.has(kind);
  }, false);
  const used = base + extra;
  const headroom = used >= bankroll.BANKROLL_DROPS ? 0n : bankroll.BANKROLL_DROPS - used;
  return { used, headroom, proved_xrp: base };
}

module.exports = {
  KINDS,
  ALL,
  TEAM_CAP_DROPS,
  ROLE_CAP,
  LEGACY_HOLD,
  rows,
  teamOpen,
  roleOpen,
  blocksNewRisk,
  boundedCap,
  allows,
  tighterRoom,
  ledgerHeadroom,
  countsOpen,
};
