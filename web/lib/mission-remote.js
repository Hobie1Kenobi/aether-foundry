"use strict";

const crypto = require("crypto");

const VERSION = 1;
const GIT_REPO = "Hobie1Kenobi/aether-foundry";
const GIT_PATH = "lab/missions/public-status.json";
const SHA_RE = /^[0-9a-f]{40}$/;

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

function unavailable(error) {
  return {
    ok: false,
    spending_enabled: false,
    spending_enabled_source: "default_off",
    signing_enabled: false,
    authorized_per_mission_drops: "1000000",
    authorized_daily_drops: "5000000",
    timezone: "America/Chicago",
    live_spend_drops: null,
    reserved_drops: null,
    uncertain_drops: null,
    accounted_spent_drops: null,
    source: "unavailable",
    source_observed_at: null,
    stale: true,
    killed: false,
    error,
    note: "No verified mission snapshot is available. Live spend is unknown, not zero.",
    missions: [],
  };
}

function verify(doc, now) {
  if (!doc || doc.schema !== "aether.missions.public-status") return { ok: false, error: "schema" };
  if (doc.version !== VERSION) return { ok: false, error: "version" };
  if (!Number.isInteger(doc.sequence) || doc.sequence < 1) return { ok: false, error: "out_of_order" };
  if (!Number.isInteger(doc.prev_sequence) || doc.prev_sequence !== doc.sequence - 1) return { ok: false, error: "out_of_order" };
  if (doc.integrity !== integrityOf(doc)) return { ok: false, error: "integrity" };
  const observed = doc.source_observed_at;
  if (typeof observed !== "string" || Number.isNaN(new Date(observed).getTime())) return { ok: false, error: "timestamp" };
  const clock = new Date(now || Date.now()).getTime();
  const stale = clock - new Date(observed).getTime() > 15 * 60 * 1000;
  return {
    ok: true,
    body: Object.assign({}, doc, {
      source: "git",
      stale,
      signing_enabled: false,
      note: "Sanitized snapshot from the Foundry box, fetched at the current main commit. The box ledger stays authoritative.",
    }),
  };
}

async function fetchPublished(fetchImpl, now, opts) {
  const options = opts || {};
  if (typeof fetchImpl !== "function") return unavailable("unavailable");
  const repo = options.repo || process.env.FOUNDRY_MISSION_GIT_REPO || GIT_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return unavailable("upstream");
  const timeout = options.timeoutMs == null ? 8000 : options.timeoutMs;
  async function get(url) {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined;
    return fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json, application/json, text/plain, */*",
        "user-agent": "aether-foundry-desk",
      },
      cache: "no-store",
      signal,
    });
  }
  let head;
  try {
    head = await get(`https://api.github.com/repos/${repo}/commits/main`);
  } catch (error) {
    const name = error && (error.name || error.code);
    return unavailable(name === "TimeoutError" || name === "AbortError" ? "timeout" : "upstream");
  }
  if (!head || !head.ok) return unavailable(head && head.status === 404 ? "unavailable" : "upstream");
  let meta;
  try {
    meta = await head.json();
  } catch {
    return unavailable("upstream");
  }
  const sha = String(meta && meta.sha ? meta.sha : "").toLowerCase();
  if (!SHA_RE.test(sha)) return unavailable("upstream");
  let file;
  try {
    file = await get(`https://raw.githubusercontent.com/${repo}/${sha}/${GIT_PATH}`);
  } catch (error) {
    const name = error && (error.name || error.code);
    return unavailable(name === "TimeoutError" || name === "AbortError" ? "timeout" : "upstream");
  }
  if (!file || file.status === 404) return unavailable("unavailable");
  if (!file.ok) return unavailable("upstream");
  let doc;
  try {
    doc = await file.json();
  } catch {
    return unavailable("integrity");
  }
  const checked = verify(doc, now);
  if (!checked.ok) return unavailable(checked.error);
  checked.body.source_commit = sha;
  return checked.body;
}

module.exports = { VERSION, GIT_PATH, integrityOf, verify, fetchPublished, unavailable };
