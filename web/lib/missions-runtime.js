"use strict";

const local = require("./mission-fold.js");
const remote = require("./mission-remote.js");

async function readIngested() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const blob = await import("@vercel/blob");
    const result = await blob.get("missions/public-status.json", { access: "private", useCache: false });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadMissionStatus(now) {
  const dir = local.ledgerDir();
  if (dir) return local.fold(local.readEvents(dir), now);
  if (process.env.FOUNDRY_MISSION_REMOTE === "off") return local.fold([], now);
  return remote.fetchPublished(globalThis.fetch, now, { readIngested });
}

async function loadMissionRoute(route, id, now) {
  if (route !== "detail" && route !== "replay") {
    return { status: 200, body: await loadMissionStatus(now) };
  }
  const dir = local.ledgerDir();
  if (dir) return local.loadMissionRoute(route, id, now);
  if (process.env.FOUNDRY_MISSION_REMOTE === "off") {
    return { status: 404, body: { ok: false, code: "NOT_FOUND", error: "mission not found", source: "unavailable" } };
  }
  const published = await remote.fetchPublished(globalThis.fetch, now, { readIngested });
  return remote.routeFromPublished(published, route, id);
}

module.exports = { ledgerDir: local.ledgerDir, loadMissionStatus, loadMissionRoute };
