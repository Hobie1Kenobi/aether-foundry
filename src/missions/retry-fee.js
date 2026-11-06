#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { exclusive, readEvents, coded } = require("./ledger");
const { fold } = require("./engine");
const missionPolicy = require("./policy");
const guard = require("./runtime-guard");

const FEE_BLOCKS = new Set(["FEE", "FEE_CAP", "FEE_STALE"]);

function preSignFeeBlock(mission) {
  return Boolean(
    mission
    && FEE_BLOCKS.has(mission.code)
    && mission.signed !== true
    && mission.submitted !== true
    && mission.live !== true
    && !mission.submit_state
    && !mission.presigned_hash
    && mission.hold !== "uncertain"
  );
}

function retryPreSignFee(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  if (input.confirm !== config.FEE_RETRY_PHRASE) throw coded("fee retry phrase mismatch", "APPROVAL");
  if (!missionPolicy.tokenOk(input.token, options.token)) throw coded("fee retry token was refused", "AUTH");
  const ledger = guard.assertIsolated(dir);
  return exclusive(ledger, (api) => {
    const events = api.read();
    const state = fold(events);
    const keys = [];
    for (const mission of Object.values(state.missions)) {
      if (!FEE_BLOCKS.has(mission.code)) continue;
      if (!preSignFeeBlock(mission)) throw coded("refusing to retry a claim that may have been signed", "NO_RETRY");
      keys.push(mission.idempotency_key);
    }
    if (!keys.length) return { retried: [], live: false, submitted: false };
    for (const key of keys) {
      api.append({
        type: "control.retry_fee",
        at: now,
        idempotency_key: key,
        live: false,
        signed: false,
        submitted: false,
        rationale: "Operator audit reopened one pre-sign fee block. No transaction was signed.",
      });
    }
    const stateFile = path.join(ledger, "worker-state.json");
    if (fs.existsSync(stateFile)) {
      const workerState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const consumed = workerState.consumed || {};
      for (const key of keys) delete consumed[key];
      workerState.consumed = consumed;
      fs.writeFileSync(stateFile, `${JSON.stringify(workerState)}\n`);
    }
    return { retried: keys, live: false, submitted: false };
  });
}

if (require.main === module) {
  const home = process.env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const dir = process.env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger");
  try {
    const result = retryPreSignFee(dir, {
      token: process.env.FOUNDRY_MISSION_TOKEN,
      confirm: process.env.FOUNDRY_MISSION_CONFIRM,
      now: new Date().toISOString(),
    }, { token: process.env.FOUNDRY_MISSION_TOKEN });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "RETRY"}\n`);
    process.exit(1);
  }
}

module.exports = { retryPreSignFee, preSignFeeBlock, readEvents };
