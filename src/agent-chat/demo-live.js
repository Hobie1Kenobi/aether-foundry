#!/usr/bin/env node
"use strict";

/**
 * Operator live demo. Fails closed when the signer or Ollama key is missing.
 * Does not read a seed. The localhost signer does.
 *
 *   AETHER_NET_CHAT_LIVE=yes FOUNDRY_AGENT_SIGN=yes FOUNDRY_SIGNER_TOKEN=... \\
 *     OLLAMA_API_KEY=... npm run peers:demo:live
 */

const path = require("path");
const protocol = require("./protocol");
const signerPost = require("./signer-post");
const ollama = require("./ollama");
const scribe = require("./scribe-server");
const scout = require("./scout");

const HELP = `Usage: node src/agent-chat/demo-live.js

Requires, all at once:
  FOUNDRY_AGENT_SIGN=yes
  AETHER_NET_CHAT_LIVE=yes
  FOUNDRY_SIGNER_TOKEN (16+ chars, not printed)
  a signer already listening on 127.0.0.1:8787 with signing true and network id 1
  OLLAMA_API_KEY
  OLLAMA_BASE_URL (default https://ollama.com)
  OLLAMA_MODEL (default glm-5.3-flash)

Refuses CI, GITHUB_ACTIONS, VERCEL, and AETHER_SCRIBE_MOCK=1.
Starts Scribe on 127.0.0.1 for this process, then runs scout --live.
Herald must be running with --live-ack in another terminal or the poll times out.
The desk never signs.`;

function fail(message) {
  console.error(message);
  return 1;
}

async function preflight(env, fetchImpl) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return { help: true };
  }
  try {
    signerPost.assertLiveEnv(env);
  } catch (err) {
    throw protocol.coded(err.message || String(err));
  }
  if (env.AETHER_SCRIBE_MOCK === "1" || env.CI || env.GITHUB_ACTIONS) {
    throw protocol.coded("refusing live demo under mock or CI");
  }
  if (!env.OLLAMA_API_KEY) {
    throw protocol.coded("OLLAMA_API_KEY is missing. Set it in the operator env or run npm run peers:demo:sim");
  }
  const health = await signerPost.signerHealth(env, fetchImpl);
  return { health, model: ollama.ollamaModel(env), base: ollama.ollamaBase(env) };
}

async function main(io) {
  const env = (io && io.env) || process.env;
  const fetchImpl = (io && io.fetchImpl) || globalThis.fetch;
  let ready;
  try {
    ready = await preflight(env, fetchImpl);
  } catch (err) {
    return fail(err.message || String(err));
  }
  if (ready.help) return 0;
  const root = path.resolve(__dirname, "..", "..");
  const out = path.join(root, "lab", "peers", "demo", `live-${scout.runId(new Date())}`);
  const started = await scribe.startScribe({ host: "127.0.0.1", port: 0, env, root });
  try {
    console.log(`peers:demo:live scribe=${started.url} model=${ready.model} signer=127.0.0.1`);
    console.log("Herald must already be in --live-ack. This process does not sign except through the signer.");
    const code = await scout.run(["node", "scout.js", "--live", "--scribe", started.url, "--out", out], {
      env,
      fetchImpl,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    });
    return code;
  } finally {
    await started.close();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { HELP, preflight, main };
