#!/usr/bin/env node
"use strict";

const path = require("path");
const { view } = require("./engine");

function present(value) {
  return typeof value === "string" && value.length > 0;
}

function ready(env, dir) {
  const source = view(dir, new Date().toISOString());
  const run = env.FOUNDRY_MISSION_RUN === "yes";
  return {
    schema: "aether.missions.ready",
    dormant: !run,
    mission_spend_enabled: false,
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
    untouched_listeners: ["127.0.0.1:8787", "127.0.0.1:8792", "127.0.0.1:8793"],
  };
}

function main(env, dir) {
  const body = ready(env || {}, dir);
  if (!body.dormant) {
    body.ran = "ready-check-only";
    body.submitted = false;
    body.note = "FOUNDRY_MISSION_RUN=yes still does not submit. Live submit stays off until FOUNDRY_MISSION_EXECUTE=yes on the box, which this command does not set.";
  }
  return body;
}

if (require.main === module) {
  const dir = path.join(process.cwd(), "lab", "missions");
  const body = main(process.env, dir);
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(0);
}

module.exports = { ready, main };
