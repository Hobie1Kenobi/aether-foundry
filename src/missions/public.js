"use strict";

const { publicFeed, publicDetail, publicReplay, view } = require("./engine");
const { readEvents } = require("./ledger");

function handlePublic(request, dir) {
  const method = String(request && request.method ? request.method : "GET").toUpperCase();
  if (method !== "GET") {
    return {
      status: 405,
      body: {
        ok: false,
        code: "PUBLIC_WRITE",
        error: "public mission routes are read-only",
        signed: false,
        submitted: false,
      },
    };
  }
  const route = request.route || "feed";
  if (request.command || request.action) {
    return {
      status: 405,
      body: { ok: false, code: "PUBLIC_WRITE", error: "public mission routes do not accept commands" },
    };
  }
  if (!dir || readEvents(dir).length === 0 && route !== "feed" && route !== "status") {
    if (route === "detail" || route === "replay") {
      return { status: 404, body: { ok: false, code: "NOT_FOUND", error: "mission not found" } };
    }
  }
  if (route === "status") {
    const status = dir ? view(dir) : null;
    return {
      status: 200,
      body: {
        ok: true,
        spending_enabled: false,
        signing_enabled: false,
        authorized_per_mission_drops: "1000000",
        authorized_daily_drops: "5000000",
        timezone: "America/Chicago",
        live_spend_drops: "0",
        source: status && status.source === "ledger" ? "ledger" : "unavailable",
        source_observed_at: status ? status.source_observed_at : null,
        served_at: request.served_at || null,
        killed: status ? status.killed : false,
      },
    };
  }
  if (route === "detail") {
    const body = publicDetail(dir, request.id);
    if (!body) return { status: 404, body: { ok: false, code: "NOT_FOUND", error: "mission not found" } };
    return { status: 200, body };
  }
  if (route === "replay") {
    return { status: 200, body: publicReplay(dir, request.id) };
  }
  return { status: 200, body: publicFeed(dir) };
}

module.exports = { handlePublic };
