"use strict";

/**
 * Publish one health snapshot while purchase execution stays off.
 * This does not sign and does not read a seed.
 */

const path = require("path");
const { coded } = require("./ledger");
const guard = require("./runtime-guard");
const { uploadIngest } = require("./desk-publish");

const PHRASE = "PUBLISH-HEALTH-SNAPSHOT";

function assertAuth(env) {
  guard.assertNoHouseSeeds(env);
  if (env.FOUNDRY_MISSION_EXECUTE === "yes") throw coded("health publish refuses an execute environment", "AUTH");
  const token = env.FOUNDRY_MISSION_PUBLISH_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("publish token is missing", "AUTH");
  if (env.FOUNDRY_MISSION_PUBLISH_PHRASE !== PHRASE) throw coded("publish phrase is missing", "AUTH");
}

async function publishHealth(env, opts) {
  const options = opts || {};
  const source = Object.assign({}, env || {});
  assertAuth(source);
  const home = guard.assertIsolated(source.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime");
  const ledger = guard.assertIsolated(source.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger"));
  source.FOUNDRY_MISSION_EXECUTE = "";
  const result = await uploadIngest(ledger, {
    env: source,
    now: options.now,
    fetch: options.fetch,
    heartbeat: true,
  });
  return Object.assign({ execute: false, worker_asleep: true }, result);
}

if (require.main === module) {
  publishHealth(process.env, { fetch: globalThis.fetch })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({
        uploaded: result.uploaded === true,
        changed: result.changed === true,
        reason: result.reason || null,
        sequence: result.sequence,
        execute: false,
        worker_asleep: true,
      })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "AUTH"}\n`);
      process.exit(1);
    });
}

module.exports = {
  PHRASE,
  publishHealth,
};
