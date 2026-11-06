"use strict";

const fs = require("fs");
const path = require("path");

const PER_MISSION = 1000000n;
const DAILY = 5000000n;
const STALE_MS = 15 * 60 * 1000;
const TIMEZONE = "America/Chicago";

function chicagoDay(input) {
  const date = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year").value;
  const month = parts.find((part) => part.type === "month").value;
  const day = parts.find((part) => part.type === "day").value;
  return `${year}-${month}-${day}`;
}

function blankDay() {
  return { reserved: 0n, spent: 0n, uncertain: 0n, released: 0n };
}

function readEvents(dir) {
  if (!dir) return [];
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "ledger.torn", counted: false });
    }
  }
  return events;
}

function fold(events, now) {
  const clock = now || new Date().toISOString();
  if (!events.length) {
    return {
      ok: true,
      spending_enabled: false,
      spending_enabled_source: "default_off",
      signing_enabled: false,
      authorized_per_mission_drops: PER_MISSION.toString(),
      authorized_daily_drops: DAILY.toString(),
      timezone: TIMEZONE,
      live_spend_drops: null,
      reserved_drops: null,
      uncertain_drops: null,
      accounted_spent_drops: null,
      source: "unavailable",
      source_observed_at: null,
      stale: true,
      killed: false,
      note: "No mission ledger is visible to this process. Live spend is unknown, not zero.",
      missions: [],
    };
  }
  let killed = false;
  let spending = false;
  let observed = null;
  let live = 0n;
  const days = {};
  const missions = new Map();
  const dayBucket = (day) => {
    if (!days[day]) days[day] = blankDay();
    return days[day];
  };
  for (const event of events) {
    if (!event || event.counted === false) continue;
    if (event.at) observed = event.at;
    if (event.type === "control.kill") {
      killed = true;
      spending = false;
    } else if (event.type === "control.clear_kill") {
      killed = false;
    } else if (event.type === "control.activate" && !killed) {
      if (BigInt(event.per_mission_drops || "0") === PER_MISSION && BigInt(event.daily_drops || "0") === DAILY) {
        spending = true;
      }
    } else if (event.type === "control.deactivate") {
      spending = false;
    } else if (event.type === "mission.upsert" && event.mission) {
      missions.set(event.mission.id, event.mission);
    } else if (event.type === "budget.reserved") {
      dayBucket(event.day).reserved += BigInt(event.budget_drops || "0");
    } else if (event.type === "budget.released") {
      const bucket = dayBucket(event.day);
      bucket.reserved -= BigInt(event.drops || "0");
      bucket.released += BigInt(event.drops || "0");
    } else if (event.type === "budget.spent") {
      const bucket = dayBucket(event.day);
      const amount = BigInt(event.drops || "0");
      bucket.reserved -= amount;
      bucket.spent += amount;
      if (event.live === true) live += amount;
    } else if (event.type === "budget.fee_spent") {
      const bucket = dayBucket(event.day);
      const fee = BigInt(event.drops || "0");
      bucket.reserved -= fee;
      bucket.spent += fee;
      if (event.live === true) live += fee;
    } else if (event.type === "budget.settled") {
      const bucket = dayBucket(event.day);
      const amount = BigInt(event.drops || "0");
      bucket.uncertain -= amount;
      bucket.spent += amount;
    } else if (event.type === "budget.uncertain") {
      const bucket = dayBucket(event.day);
      const amount = BigInt(event.drops || "0");
      bucket.reserved -= amount;
      bucket.uncertain += amount;
      if (event.live === true) live += amount;
    }
  }
  const day = days[chicagoDay(clock)] || blankDay();
  const stale = !observed || new Date(clock).getTime() - new Date(observed).getTime() > STALE_MS;
  return {
    ok: true,
    spending_enabled: spending && !killed,
    spending_enabled_source: "ledger",
    signing_enabled: false,
    authorized_per_mission_drops: PER_MISSION.toString(),
    authorized_daily_drops: DAILY.toString(),
    timezone: TIMEZONE,
    live_spend_drops: live.toString(),
    reserved_drops: day.reserved.toString(),
    uncertain_drops: day.uncertain.toString(),
    accounted_spent_drops: day.spent.toString(),
    source: "ledger",
    source_observed_at: observed,
    stale,
    killed,
    note: "Figures are folded from the append-only mission ledger. Signing is still a separate box step.",
    missions: [...missions.values()].map((mission) => ({
      id: mission.id,
      status: mission.status,
      code: mission.code || null,
      rationale: mission.rationale || "",
      settlement: mission.settlement || null,
      live: mission.live === true,
    })),
  };
}

function ledgerDir() {
  const fromEnv = process.env.FOUNDRY_MISSION_LEDGER;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "events.jsonl"))) return fromEnv;
  const candidates = [path.resolve(process.cwd(), "lab/missions"), path.resolve(process.cwd(), "../lab/missions")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "events.jsonl"))) return dir;
  }
  return null;
}

function loadMissionStatus(now) {
  return fold(readEvents(ledgerDir()), now);
}

function loadMissionRoute(route, id, now) {
  if (route === "status" || route === "feed") {
    return { status: 200, body: loadMissionStatus(now) };
  }
  const body = loadMissionStatus(now);
  const mission = (body.missions || []).find((item) => item.id === id);
  if (!mission) return { status: 404, body: { ok: false, code: "NOT_FOUND", error: "mission not found" } };
  if (route === "replay") {
    const events = readEvents(ledgerDir())
      .filter((event) => event && (event.mission_id === id || (event.mission && event.mission.id === id)))
      .map((event) => ({
        type: event.type,
        at: event.at || null,
        code: event.code || (event.mission && event.mission.code) || null,
        rationale: event.rationale || (event.mission && event.mission.rationale) || null,
        live: event.live === true,
      }));
    return { status: 200, body: { schema: "aether.missions.replay", id, events } };
  }
  return { status: 200, body: { schema: "aether.missions.detail", mission } };
}

module.exports = { fold, readEvents, ledgerDir, loadMissionStatus, loadMissionRoute };
