#!/usr/bin/env node
"use strict";

/**
 * Zero-chain net-chat demo.
 * Uses the mock scribe unless OLLAMA_API_KEY is set and AETHER_SCRIBE_MOCK is not 1.
 * CI and GITHUB_ACTIONS always mock.
 *
 *   npm run peers:demo:sim
 *   AETHER_SCRIBE_MOCK=1 npm run peers:demo:sim
 */

const path = require("path");
const ollama = require("./ollama");
const scout = require("./scout");

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

async function main() {
  const env = Object.assign({}, process.env);
  const mock = ollama.mockForced(env) || !env.OLLAMA_API_KEY;
  if (mock) env.AETHER_SCRIBE_MOCK = "1";
  const result = await scout.runSim({ env, mock, root: repoRoot() });
  const text = `peers:demo:sim dir=${result.dir} turns=${result.turns.length} scribe=${result.meta.scribe} synthetic=yes`;
  if (/sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) throw new Error("refusing to print a seed");
  console.log(text);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
