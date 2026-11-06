"use strict";

const fs = require("fs");
const path = require("path");
const { handlePublic } = require("../../src/missions/public.js");

function ledgerDir() {
  const fromEnv = process.env.FOUNDRY_MISSION_LEDGER;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "events.jsonl"))) return fromEnv;
  const candidates = [
    path.resolve(process.cwd(), "lab/missions"),
    path.resolve(process.cwd(), "../lab/missions"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "events.jsonl"))) return dir;
  }
  return null;
}

function loadMissionStatus(now) {
  return handlePublic(
    { method: "GET", route: "status", served_at: now || new Date().toISOString() },
    ledgerDir()
  ).body;
}

function loadMissionRoute(route, id, now) {
  return handlePublic(
    { method: "GET", route, id, served_at: now || new Date().toISOString() },
    ledgerDir()
  );
}

module.exports = { ledgerDir, loadMissionStatus, loadMissionRoute };
