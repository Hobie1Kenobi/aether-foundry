"use strict";

const local = require("./mission-fold.js");
const remote = require("./mission-remote.js");

async function loadMissionStatus(now) {
  const dir = local.ledgerDir();
  if (dir) return local.fold(local.readEvents(dir), now);
  if (process.env.FOUNDRY_MISSION_REMOTE === "off") return local.fold([], now);
  return remote.fetchPublished(globalThis.fetch, now, {});
}

async function loadMissionRoute(route, id, now) {
  const dir = local.ledgerDir();
  if (dir) return local.loadMissionRoute(route, id, now);
  if (process.env.FOUNDRY_MISSION_REMOTE === "off") {
    return { status: 404, body: { ok: false, code: "NOT_FOUND", error: "mission not found", source: "unavailable" } };
  }
  const published = await remote.fetchPublished(globalThis.fetch, now, {});
  return remote.routeFromPublished(published, route, id);
}

module.exports = { ledgerDir: local.ledgerDir, loadMissionStatus, loadMissionRoute };
