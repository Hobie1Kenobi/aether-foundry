"use strict";

/**
 * Push the sanitized snapshot to the desk ingest. The desk stores it.
 * This process does not need a GitHub token and does not write git.
 */

const fs = require("fs");
const path = require("path");
const { publish, SNAPSHOT_NAME } = require("./publish");
const { coded } = require("./ledger");
const guard = require("./runtime-guard");

const INGEST_URL = "https://aether-foundry-desk.vercel.app/api/missions/ingest";
const THROTTLE_MS = 15 * 60 * 1000;
const STATE_NAME = "ingest-state.json";

function assertIngestUrl(raw) {
  let url;
  try {
    url = new URL(raw || INGEST_URL);
  } catch {
    throw coded("refusing an ingest host other than the desk", "PUBLISH");
  }
  if (url.protocol !== "https:" || url.hostname !== "aether-foundry-desk.vercel.app" || url.pathname !== "/api/missions/ingest" || url.username || url.password || url.search) {
    throw coded("refusing an ingest host other than the desk", "PUBLISH");
  }
  return url.toString();
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function uploadIngest(dir, opts) {
  const options = opts || {};
  const env = options.env || {};
  guard.assertNoHouseSeeds(env);
  const ledger = guard.assertIsolated(dir);
  const clock = options.now || new Date().toISOString();
  const stateFile = path.join(ledger, STATE_NAME);
  const prior = readJson(stateFile);
  if (prior && prior.ingested_at) {
    const age = new Date(clock).getTime() - new Date(prior.ingested_at).getTime();
    if (Number.isFinite(age) && age >= 0 && age < THROTTLE_MS) {
      return { changed: false, uploaded: false, reason: "throttled", sequence: prior.sequence, transport: "ingest" };
    }
  }
  const local = publish(ledger, clock);
  const secret = env.FOUNDRY_MISSION_INGEST_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    return { changed: local.changed !== false, uploaded: false, reason: "no_ingest_secret", sequence: local.sequence, transport: "ingest" };
  }
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== "function") throw coded("refusing to upload without an explicit fetch", "PUBLISH");
  const response = await fetchImpl(assertIngestUrl(options.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "user-agent": "aether-foundry-missions",
    },
    body: fs.readFileSync(path.join(ledger, SNAPSHOT_NAME), "utf8"),
  });
  if (!response.ok) {
    throw coded(`desk ingest failed with ${response.status}`, "PUBLISH");
  }
  const written = readJson(stateFile) || {};
  written.ingested_at = clock;
  written.sequence = local.sequence;
  written.transport = "ingest";
  fs.writeFileSync(stateFile, `${JSON.stringify(written)}\n`);
  return { changed: true, uploaded: true, sequence: local.sequence, transport: "ingest", path: "missions/public-status.json" };
}

module.exports = {
  INGEST_URL,
  THROTTLE_MS,
  assertIngestUrl,
  uploadIngest,
};
