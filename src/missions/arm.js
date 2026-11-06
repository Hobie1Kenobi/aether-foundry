#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { coded, readEvents } = require("./ledger");
const { fold, control } = require("./engine");
const missionPolicy = require("./policy");
const guard = require("./runtime-guard");

function homeOf(env) {
  return guard.assertIsolated((env && env.FOUNDRY_MISSION_HOME) || "/workspace/foundry-ops/missions-runtime");
}

function accountPath(env) {
  return path.join(homeOf(env), "account.json");
}

function armPath(env) {
  return path.join(homeOf(env), "arm.json");
}

function readAccount(env) {
  const file = accountPath(env);
  if (!fs.existsSync(file)) throw coded("isolated account file is missing", "WALLET");
  const stat = fs.statSync(file);
  if ((stat.mode & 0o777) !== 0o600) throw coded("account file must be mode 0600", "WALLET");
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!body || typeof body.address !== "string" || typeof body.seed !== "string") {
    throw coded("account file is missing the isolated address", "WALLET");
  }
  if (Object.keys(body).some((key) => key !== "address" && key !== "seed")) {
    throw coded("account file has an unexpected field", "WALLET");
  }
  if (missionPolicy.isHouse(body.address)) throw coded("isolated account is a house wallet", "W0");
  return { address: body.address };
}

function writeJson(file, value) {
  const tmp = `${file}.partial`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function assertCaps(input) {
  const per = input && input.per_mission_drops;
  const daily = input && input.daily_drops;
  if (per && per !== config.PER_MISSION_DROPS.toString()) throw coded("refusing to raise the per-mission cap", "CAP");
  if (daily && daily !== config.DAILY_DROPS.toString()) throw coded("refusing to raise the daily cap", "CAP");
}

function arm(options) {
  const opts = options || {};
  const env = opts.env || {};
  guard.assertNoHouseSeeds(env);
  if (opts.confirm !== config.ACTIVATE_PHRASE) throw coded("activation phrase mismatch", "APPROVAL");
  if (!missionPolicy.tokenOk(opts.token, opts.expected || env.FOUNDRY_MISSION_TOKEN)) {
    throw coded("arm token was refused", "AUTH");
  }
  assertCaps(opts);
  const home = homeOf(env);
  const ledger = guard.assertIsolated(opts.ledger || env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger"));
  const account = readAccount(env);
  const events = fs.existsSync(path.join(ledger, "events.jsonl")) ? readEvents(ledger) : [];
  const state = fold(events);
  if (!state.spending_enabled) {
    control(ledger, {
      action: "activate",
      confirm: config.ACTIVATE_PHRASE,
      token: opts.token,
      per_mission_drops: config.PER_MISSION_DROPS.toString(),
      daily_drops: config.DAILY_DROPS.toString(),
      now: opts.now,
    }, { token: opts.expected || env.FOUNDRY_MISSION_TOKEN });
  }
  writeJson(armPath(env), {
    schema: "aether.missions.arm",
    armed: true,
    address: account.address,
    per_mission_drops: config.PER_MISSION_DROPS.toString(),
    daily_drops: config.DAILY_DROPS.toString(),
    at: opts.now || new Date().toISOString(),
  });
  return {
    armed: true,
    address: account.address,
    mission_signer_armed: true,
    signing_disabled: false,
    per_mission_drops: config.PER_MISSION_DROPS.toString(),
    daily_drops: config.DAILY_DROPS.toString(),
  };
}

function check(env) {
  const source = env || {};
  try {
    guard.assertNoHouseSeeds(source);
    const file = armPath(source);
    if (!fs.existsSync(file)) return { armed: false, signing_disabled: true, mission_signer_armed: false };
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    const account = readAccount(source);
    if (body.armed !== true || body.address !== account.address) {
      return { armed: false, signing_disabled: true, mission_signer_armed: false };
    }
    if (body.per_mission_drops !== config.PER_MISSION_DROPS.toString() || body.daily_drops !== config.DAILY_DROPS.toString()) {
      throw coded("arm file caps do not match the authorized ceilings", "CAP");
    }
    return {
      armed: true,
      address: account.address,
      mission_signer_armed: true,
      signing_disabled: false,
      per_mission_drops: body.per_mission_drops,
      daily_drops: body.daily_drops,
    };
  } catch (error) {
    if (error && (error.code === "CAP" || error.code === "W0" || error.code === "HOUSE_SEED")) throw error;
    return { armed: false, signing_disabled: true, mission_signer_armed: false };
  }
}

if (require.main === module) {
  try {
    if (process.argv.includes("--check")) {
      const status = check(process.env);
      process.stdout.write(status.armed ? "armed\n" : "off\n");
      process.exit(0);
    }
    const result = arm({
      env: process.env,
      token: process.env.FOUNDRY_MISSION_TOKEN,
      confirm: process.env.FOUNDRY_MISSION_CONFIRM,
      now: new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify({ armed: result.armed, address: result.address, signing_disabled: result.signing_disabled })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "ARM"}\n`);
    process.exit(1);
  }
}

module.exports = { arm, check, readAccount, accountPath, armPath };
