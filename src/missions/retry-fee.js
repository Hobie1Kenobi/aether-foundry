#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { exclusive, readEvents, coded } = require("./ledger");
const { fold, safePreSignFee } = require("./engine");
const missionPolicy = require("./policy");
const guard = require("./runtime-guard");

function preSignFeeBlock(mission) {
  return safePreSignFee(mission);
}

function retryPreSignFee(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  const key = String(input.idempotency_key || "");
  if (input.confirm !== config.FEE_RETRY_PHRASE) throw coded("fee retry phrase mismatch", "APPROVAL");
  if (!missionPolicy.tokenOk(input.token, options.token)) throw coded("fee retry token was refused", "AUTH");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("fee retry needs one candidate key", "IDEMPOTENCY");
  const ledger = guard.assertIsolated(dir);
  return exclusive(ledger, (api) => {
    const state = fold(api.read());
    const mission = Object.values(state.missions).find((item) => item.idempotency_key === key);
    if (!mission || !preSignFeeBlock(mission)) throw coded("refusing to retry a claim that may have been signed", "NO_RETRY");
    const children = Object.values(state.missions).filter((item) => item.retry_of === key);
    for (const child of children) {
      if (!preSignFeeBlock(child)) throw coded("refusing to open another successor after an empty or signed retry", "NO_RETRY");
    }
    api.append({
      type: "control.retry_fee",
      at: now,
      idempotency_key: key,
      explicit: true,
      live: false,
      signed: false,
      submitted: false,
      rationale: "Operator audit reopened one named pre-sign fee block. No transaction was signed.",
    });
    const stateFile = path.join(ledger, "worker-state.json");
    if (fs.existsSync(stateFile)) {
      const workerState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const consumed = workerState.consumed || {};
      delete consumed[key];
      workerState.consumed = consumed;
      fs.writeFileSync(stateFile, `${JSON.stringify(workerState)}\n`);
    }
    return { retried: [key], live: false, submitted: false };
  });
}

if (require.main === module) {
  const home = process.env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const dir = process.env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger");
  try {
    const result = retryPreSignFee(dir, {
      token: process.env.FOUNDRY_MISSION_TOKEN,
      confirm: process.env.FOUNDRY_MISSION_CONFIRM,
      idempotency_key: process.env.FOUNDRY_MISSION_RETRY_KEY,
      now: new Date().toISOString(),
    }, { token: process.env.FOUNDRY_MISSION_TOKEN });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "RETRY"}\n`);
    process.exit(1);
  }
}

module.exports = { retryPreSignFee, preSignFeeBlock, readEvents };
