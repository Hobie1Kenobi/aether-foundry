#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const policy = require("./policy");
const planner = require("./plan");
const status = require("./status");
const storeMod = require("./store");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_WALLETS = path.join(ROOT, "machines", "axelar-its-bridge", "wallets.json");
const DEFAULT_STORE = path.join(ROOT, "lab", "bridge", "axelar-plans.json");

function arg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] || null;
}

function flag(argv, name) {
  return argv.includes(name);
}

function readJson(file, code) {
  if (!file) throw policy.coded("missing json file", code || "CONFIG");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw policy.coded(`unreadable json ${file}`, code || "CONFIG");
  }
  policy.assertNoSecretText(parsed);
  return parsed;
}

function print(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  policy.assertNoSecretText(text);
  process.stdout.write(text);
}

function fail(error) {
  const body = {
    ok: false,
    error: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : "ERROR",
    signed: false,
    submitted: false,
    signable: false,
    key_loaded: false,
  };
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exit(1);
}

function help() {
  return {
    ok: true,
    mode: "dry-run",
    signed: false,
    submitted: false,
    signable: false,
    commands: ["plan", "review", "status", "stellar"],
    disabled: ["sign", "submit"],
    note: "Testnet planning only. Signing and submission are disabled. No faucet. No W0.",
  };
}

function main(argv) {
  const cmd = argv[2] || "help";
  if (cmd === "sign" || cmd === "submit") planner.refuseSign();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return help();
  if (cmd === "stellar") return config.stellarRoute();
  const store = storeMod.fileStore(arg(argv, "--store") || DEFAULT_STORE);
  if (cmd === "plan") {
    const wallets = readJson(arg(argv, "--wallets") || DEFAULT_WALLETS, "WALLET");
    return planner.plan(
      {
        direction: arg(argv, "--direction"),
        client_id: arg(argv, "--client-id"),
        asset: arg(argv, "--asset") || "XRP",
        amount_drops: arg(argv, "--amount-drops"),
        gas_drops: arg(argv, "--gas-drops"),
        amount_wei: arg(argv, "--amount-wei"),
        gas_value_wei: arg(argv, "--gas-value-wei"),
        from: arg(argv, "--from"),
        to: arg(argv, "--to"),
        payload: arg(argv, "--payload"),
        network: arg(argv, "--network"),
        network_id: arg(argv, "--network-id"),
        evm_chain_id: arg(argv, "--evm-chain-id"),
        wallets,
      },
      store
    );
  }
  if (cmd === "review") {
    return planner.review(store, arg(argv, "--plan-id"), arg(argv, "--confirm"));
  }
  if (cmd === "status") {
    const planId = arg(argv, "--plan-id");
    const row = planId ? store.get(planId) : null;
    if (flag(argv, "--fetch")) {
      throw policy.coded("live status fetch is disabled; pass --gmp-file, --xrpl-file, and --proof-file", "READ");
    }
    const gmp = arg(argv, "--gmp-file") ? readJson(arg(argv, "--gmp-file"), "STATUS") : null;
    const xrpl = arg(argv, "--xrpl-file") ? readJson(arg(argv, "--xrpl-file"), "STATUS") : null;
    const proof = arg(argv, "--proof-file") ? readJson(arg(argv, "--proof-file"), "STATUS") : null;
    return status.classify({
      direction: row && row.direction,
      local_status: row && row.status,
      network_id: row && row.network_id,
      evm_chain_id: row && row.evm_chain_id,
      expected_xrpl_destination: row && row.destination_account,
      xrpl,
      gmp,
      destination_proof: proof,
    });
  }
  throw policy.coded(`unknown command ${cmd}`, "COMMAND");
}

if (require.main === module) {
  try {
    print(main(process.argv));
  } catch (error) {
    fail(error);
  }
}

module.exports = { main };
