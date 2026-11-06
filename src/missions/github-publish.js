#!/usr/bin/env node
"use strict";

/**
 * Upload the sanitized snapshot with the GitHub contents API.
 * The only path is lab/missions/public-status.json. No local git, no other file.
 */

const fs = require("fs");
const path = require("path");
const { publish, SNAPSHOT_NAME } = require("./publish");
const { coded } = require("./ledger");
const guard = require("./runtime-guard");

const ALLOWED_REPO = "Hobie1Kenobi/aether-foundry";
// GitHub tokens are not limited to one file. This process refuses every other path.
const ALLOWED_PATH = "lab/missions/public-status.json";
const API = "https://api.github.com";
const THROTTLE_MS = 15 * 60 * 1000;

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function redactToken(message, token) {
  const text = message == null ? "" : String(message);
  if (token && text.includes(token)) return text.split(token).join("[redacted]");
  return text;
}

function assertRepo(repo) {
  if (repo !== ALLOWED_REPO) throw coded("refusing a repository other than the public desk repo", "PUBLISH");
  return repo;
}

function assertBranch(branch) {
  const value = branch || "main";
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/")) {
    throw coded("refusing that git branch name", "PUBLISH");
  }
  return value;
}

function contentsUrl(repo, branch) {
  assertRepo(repo);
  const ref = assertBranch(branch);
  return `${API}/repos/${repo}/contents/${ALLOWED_PATH}?ref=${encodeURIComponent(ref)}`;
}

async function readRemote(fetchImpl, repo, branch, token) {
  const response = await fetchImpl(contentsUrl(repo, branch), {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "aether-foundry-missions",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw coded(redactToken(`GitHub contents read failed with ${response.status}`, token), "PUBLISH");
  }
  const body = await response.json();
  if (body.path !== ALLOWED_PATH) throw coded("GitHub returned a different path", "PUBLISH");
  const decoded = Buffer.from(String(body.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  return { sha: body.sha, json: JSON.parse(decoded) };
}

async function uploadSnapshot(dir, opts) {
  const options = opts || {};
  const env = options.env || {};
  guard.assertNoHouseSeeds(env);
  const ledger = guard.assertIsolated(dir);
  const clock = options.now || new Date().toISOString();
  const stateFile = path.join(ledger, "publish-state.json");
  const priorState = readJson(stateFile);
  if (priorState && priorState.uploaded_at) {
    const age = new Date(clock).getTime() - new Date(priorState.uploaded_at).getTime();
    if (Number.isFinite(age) && age >= 0 && age < THROTTLE_MS) {
      return { changed: false, uploaded: false, reason: "throttled", sequence: priorState.sequence };
    }
  }
  const local = publish(ledger, clock);
  const file = path.join(ledger, SNAPSHOT_NAME);
  const bytes = fs.readFileSync(file);
  const token = env.FOUNDRY_MISSION_GITHUB_TOKEN;
  if (typeof token !== "string" || token.length < 16) {
    return { changed: local.changed !== false, uploaded: false, reason: "no_token", sequence: local.sequence };
  }
  const repo = assertRepo(env.FOUNDRY_MISSION_GITHUB_REPO || ALLOWED_REPO);
  const branch = assertBranch(env.FOUNDRY_MISSION_GITHUB_BRANCH || "main");
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== "function") throw coded("refusing to upload without an explicit fetch", "PUBLISH");
  const remote = await readRemote(fetchImpl, repo, branch, token);
  if (remote && remote.json && remote.json.integrity && remote.json.integrity === local.integrity) {
    return { changed: false, uploaded: false, reason: "unchanged", sequence: local.sequence };
  }
  const put = await fetchImpl(`${API}/repos/${repo}/contents/${ALLOWED_PATH}`, {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "aether-foundry-missions",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      message: "Publish sanitized mission snapshot",
      content: bytes.toString("base64"),
      branch,
      sha: remote ? remote.sha : undefined,
    }),
  });
  if (!put.ok) throw coded(redactToken(`GitHub contents write failed with ${put.status}`, token), "PUBLISH");
  const written = readJson(stateFile) || {};
  written.uploaded_at = clock;
  fs.writeFileSync(stateFile, `${JSON.stringify(written)}\n`);
  return { changed: true, uploaded: true, sequence: local.sequence, path: ALLOWED_PATH };
}

if (require.main === module) {
  const home = process.env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const dir = process.env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger");
  uploadSnapshot(dir, { env: process.env, fetch: globalThis.fetch })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ uploaded: result.uploaded, changed: result.changed, reason: result.reason || null, path: ALLOWED_PATH })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "PUBLISH"}\n`);
      process.exit(1);
    });
}

module.exports = {
  ALLOWED_REPO,
  ALLOWED_PATH,
  redactToken,
  contentsUrl,
  uploadSnapshot,
  THROTTLE_MS,
};
