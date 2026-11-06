#!/usr/bin/env node
"use strict";

const path = require("path");
const { view } = require("./engine");
const { check } = require("./arm");

function present(value) {
  return typeof value === "string" && value.length > 0;
}

function ready(env, dir) {
  const source = view(dir, new Date().toISOString());
  const run = env.FOUNDRY_MISSION_RUN === "yes";
  let armed = false;
  try {
    armed = check(env || {}).mission_signer_armed === true;
  } catch {
    armed = false;
  }
  return {
    schema: "aether.missions.ready",
    dormant: !run,
    mission_spend_enabled: armed,
    mission_signer_armed: armed,
    signing_disabled: !armed,
    ordinary_signing: false,
    spending_enabled: source.spending_enabled === true,
    spending_enabled_source: source.spending_enabled_source,
    live_spend_drops: source.live_spend_drops,
    source: source.source,
    source_observed_at: source.source_observed_at,
    stale: source.stale,
    asset: "XRP",
    evm_gas: "not_authorized",
    network: "xrpl:1",
    mission_account_configured: present(env.MISSION_XRPL_ADDRESS),
    mission_seed_present: present(env.MISSION_XRPL_SEED),
    signer_health_signing_is_not_mission_enabled: true,
    loop: false,
    autonomous: false,
    untouched_listeners: ["127.0.0.1:8787", "127.0.0.1:8792", "127.0.0.1:8793"],
  };
}

function main(env, dir) {
  const body = ready(env || {}, dir);
  body.ran = "ready-check-only";
  body.submitted = false;
  body.note = body.dormant
    ? "This command prints one ready check and returns. It is not a scheduled worker. The worker is node src/missions/worker.js and it stays asleep until FOUNDRY_MISSION_WORKER=yes."
    : "FOUNDRY_MISSION_RUN=yes still prints one ready check and returns. It does not poll, sign, or submit.";
  return body;
}

if (require.main === module) {
  const dir = path.join(process.cwd(), "lab", "missions");
  const body = main(process.env, dir);
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(0);
}

module.exports = { ready, main };
