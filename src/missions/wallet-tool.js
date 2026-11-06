#!/usr/bin/env node
"use strict";

/**
 * Parent-only isolated XRPL Testnet wallet tool.
 * Uses xrpl.Wallet.generate. Funding connects to XRPL Labs first and pays the
 * public faucet only after that server reports network id 1.
 * This file does not contain a seed. The cloud agent must not run it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const guard = require("./runtime-guard");
const { coded } = require("./ledger");

const LABS_WS = "wss://testnet.xrpl-labs.com";
const FAUCET_HOST = "faucet.altnet.rippletest.net";

function assertOut(file, testRoot) {
  const resolved = path.resolve(String(file || ""));
  guard.assertIsolated(resolved);
  if (testRoot) {
    const root = path.resolve(testRoot);
    const tmp = path.resolve(os.tmpdir());
    if ((root === tmp || root.startsWith(`${tmp}/`)) && resolved.startsWith(`${root}/`)) return resolved;
    throw coded("refusing a test output outside its temp directory", "WALLET");
  }
  const home = path.resolve("/workspace/foundry-ops/missions-runtime");
  if (resolved !== path.join(home, "account.json")) {
    throw coded("refusing to write the mission account outside /workspace/foundry-ops/missions-runtime/account.json", "WALLET");
  }
  return resolved;
}

async function createIsolated(options) {
  const opts = options || {};
  const env = opts.env || {};
  guard.assertNoHouseSeeds(env);
  if (env.FOUNDRY_MISSION_WALLET_TOOL !== "yes") throw coded("wallet tool is off", "WALLET");
  const out = assertOut(opts.out, opts.testRoot);
  const generate = opts.generate;
  if (typeof generate !== "function") throw coded("wallet generator is missing", "WALLET");
  const wallet = await generate();
  const address = wallet.classicAddress || wallet.address;
  const seed = wallet.seed;
  if (!address || !seed) throw coded("wallet generator returned no account", "WALLET");
  if (guard.present(env.FOUNDRY_MISSION_FAUCET) && env.FOUNDRY_MISSION_FAUCET !== "yes") {
    throw coded("refusing an ambiguous faucet flag", "WALLET");
  }
  let funded = false;
  if (env.FOUNDRY_MISSION_FAUCET === "yes") {
    if (typeof opts.fund !== "function") throw coded("faucet caller is missing", "WALLET");
    await opts.fund(wallet, { websocket: LABS_WS, faucetHost: FAUCET_HOST });
    funded = true;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify({ address, seed })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(out, 0o600);
  return { address, funded, wrote: true };
}

function defaultGenerate() {
  return require("xrpl").Wallet.generate();
}

async function proveFaucet(client) {
  if (!client || typeof client.request !== "function") throw coded("faucet proof needs the connected client", "HOST");
  const info = await client.request({ command: "server_info" });
  const networkId = info && info.result && info.result.info ? info.result.info.network_id : null;
  if (Number(networkId) !== 1 || Number(client.networkID) !== 1) {
    throw coded("refusing faucet until the server reports network id 1", "MAINNET");
  }
  return { websocket: LABS_WS, faucetHost: FAUCET_HOST, network_id: 1 };
}

async function defaultFund(wallet, deps) {
  const options = deps || {};
  const xrpl = options.xrpl || require("xrpl");
  const client = options.client || new xrpl.Client(LABS_WS);
  const opened = !options.client;
  if (opened) await client.connect();
  try {
    const proof = await proveFaucet(client);
    await client.fundWallet(wallet, { faucetHost: proof.faucetHost, usageContext: "aether-foundry-mission" });
  } finally {
    if (opened) await client.disconnect();
  }
}

if (require.main === module) {
  const outFlag = process.argv.indexOf("--out");
  const out = outFlag === -1 ? "" : process.argv[outFlag + 1];
  createIsolated({
    env: process.env,
    out,
    generate: defaultGenerate,
    fund: defaultFund,
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ address: result.address, funded: result.funded, wrote: result.wrote })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "WALLET"}\n`);
      process.exit(1);
    });
}

module.exports = {
  LABS_WS,
  FAUCET_HOST,
  proveFaucet,
  createIsolated,
  defaultGenerate,
  defaultFund,
};
