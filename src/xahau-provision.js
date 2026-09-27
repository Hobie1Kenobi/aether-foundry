#!/usr/bin/env node
"use strict";

/**
 * Create W7 and the five Xahau split destinations, plus a trial payer.
 * Writes seeds only to AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.
 * Writes public addresses to machines/xahau-split-treasury/addresses.json.
 * Refuses CI. Refuses any host that is not Xahau Testnet.
 *
 *   npm run xahau:provision
 */

const fs = require("fs");
const path = require("path");
const guard = require("./xahau-split-guard");

const ROOT = path.resolve(__dirname, "..");
const BOOK = path.join(ROOT, "machines", "xahau-split-treasury", "addresses.json");
const LOG = path.join(ROOT, "lab", "ledger-log.jsonl");

const ROLES = [
  { id: "W7", seed: "W7_SEED", role: "XAHAU treasury (hook account)" },
  { id: "MARKET", seed: "W7_MARKET_SEED", role: "40% MARKET inventory" },
  { id: "ATELIER", seed: "W7_ATELIER_SEED", role: "25% ATELIER mint budget" },
  { id: "RESEARCH", seed: "W7_RD_SEED", role: "20% R&D" },
  { id: "GRANTS", seed: "W7_GRANTS_SEED", role: "10% GRANTS" },
  { id: "SINK", seed: "W7_SINK_SEED", role: "5% sink" },
  { id: "PAYER", seed: "W7_PAYER_SEED", role: "trial payer" },
];

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function appendLog(row) {
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(LOG, line);
}

function writeSecrets(env, pairs) {
  const file = env.AETHER_SECRETS || guard.SECRETS_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const bag = guard.loadEnvText(prior);
  for (const [key, value] of pairs) bag[key] = value;
  const body = Object.keys(bag)
    .sort()
    .map((key) => `${key}=${bag[key]}`)
    .join("\n");
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* mode already applied */
  }
  return file;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function faucet(rpc) {
  let last = "faucet failed";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(`${rpc.replace(/\/$/, "")}/accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "aether-foundry-xahau-provision/1",
        Accept: "application/json",
      },
      body: "{}",
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const account = data && data.account ? data.account : {};
    const address = account.classicAddress || account.address;
    const secret = account.secret;
    if (response.ok && address && secret) {
      return {
        address,
        secret,
        hash: data.trace && data.trace.hash ? String(data.trace.hash).toUpperCase() : null,
        amount: data.amount == null ? null : Number(data.amount),
      };
    }
    last = `faucet HTTP ${response.status} attempt ${attempt}`;
    await sleep(1500 * attempt);
  }
  throw new Error(last);
}

async function main() {
  guard.assertCanSign(process.env);
  const rpc = guard.assertXahauTestnetUrl(process.env.XAHAU_RPC_URL || guard.XAHAU_RPC);
  if (fs.existsSync(BOOK)) {
    const book = JSON.parse(fs.readFileSync(BOOK, "utf8"));
    console.log("addresses already recorded");
    for (const role of ROLES) {
      const row = book.accounts && book.accounts[role.id];
      console.log(`${role.id} ${row ? row.address : "missing"}`);
    }
    return;
  }
  const created = [];
  for (const role of ROLES) {
    const funded = await faucet(rpc);
    writeSecrets(process.env, [[role.seed, funded.secret]]);
    created.push({ role, funded });
    console.log(`${role.id} ${funded.address} faucet ${funded.hash || "no-hash"} amount ${funded.amount}`);
    appendLog({
      ts: new Date().toISOString(),
      action: "xahau_faucet",
      network: "Xahau Testnet",
      network_id: guard.NETWORK_ID,
      wallet: role.id,
      role: role.role,
      address: funded.address,
      amount_xah: funded.amount,
      hash: funded.hash,
    });
    await sleep(1200);
  }
  const secretsFile = process.env.AETHER_SECRETS || guard.SECRETS_PATH;
  const accounts = {};
  for (const row of created) {
    const twin = guard.SHARES.find((share) => share.key === row.role.id);
    accounts[row.role.id] = {
      role: row.role.role,
      address: row.funded.address,
      seed_env: row.role.seed,
      faucet_hash: row.funded.hash,
      amount_xah: row.funded.amount,
      xrpl_testnet_twin: twin && twin.xrplTwin ? guard.XRPL_TWINS[twin.xrplTwin] : null,
      xrpl_testnet_twin_id: twin && twin.xrplTwin ? twin.xrplTwin : null,
    };
  }
  const book = {
    network: "Xahau Testnet",
    network_id: guard.NETWORK_ID,
    ws: guard.XAHAU_WS,
    rpc: guard.XAHAU_RPC,
    note: "Public addresses only. Seeds are not in this file.",
    accounts,
  };
  fs.mkdirSync(path.dirname(BOOK), { recursive: true });
  fs.writeFileSync(BOOK, `${JSON.stringify(book, null, 2)}\n`);
  console.log(`wrote public book ${path.relative(ROOT, BOOK)}`);
  console.log(`wrote seeds to ${secretsFile} (not printed)`);
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
