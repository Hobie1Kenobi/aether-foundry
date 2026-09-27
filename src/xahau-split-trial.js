#!/usr/bin/env node
"use strict";

/**
 * Send a native payment to W7 so the split hook can emit.
 * Loads W7_PAYER_SEED from the secrets file. Never prints it.
 * Refuses CI, mainnet, and XRPL Testnet hosts.
 *
 *   npm run xahau:trial -- --dry-run
 *   npm run xahau:trial -- --drops 1000000 --record
 */

const fs = require("fs");
const path = require("path");
const xahau = require("xahau");
const guard = require("./xahau-split-guard");

const ROOT = path.resolve(__dirname, "..");
const BOOK = path.join(ROOT, "machines", "xahau-split-treasury", "addresses.json");
const LOG = path.join(ROOT, "lab", "ledger-log.jsonl");
const TRIAL_TAG = 7707;

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function parseArgs(argv) {
  const out = { dryRun: false, record: false, drops: "1000000" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--drops") {
      out.drops = argv[i + 1] || "";
      i += 1;
    } else die(`unknown flag ${arg}`);
  }
  return out;
}

function loadBook() {
  if (!fs.existsSync(BOOK)) die("no Xahau address book. Run npm run xahau:provision");
  return JSON.parse(fs.readFileSync(BOOK, "utf8"));
}

function resultView(submitted) {
  const result = (submitted && (submitted.result || submitted)) || {};
  const meta = result.meta || result.metaData || {};
  return {
    hash: result.hash ? String(result.hash).toUpperCase() : null,
    engine: meta.TransactionResult,
    ledger_index: result.ledger_index == null ? null : result.ledger_index,
    meta,
  };
}

function hookExecutions(meta) {
  const affected = meta && meta.AffectedNodes ? meta.AffectedNodes : [];
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.HookExecutions) found.push(node.HookExecutions);
    for (const value of Object.values(node)) visit(value);
  };
  visit(affected);
  return found;
}

async function dropsOf(client, address) {
  const info = await client.request({
    command: "account_info",
    account: address,
    ledger_index: "validated",
  });
  return BigInt(info.result.account_data.Balance);
}

async function findEmits(client, book, minLedger) {
  const found = {};
  for (const share of guard.SHARES) {
    const address = book.accounts[share.key].address;
    const page = await client.request({
      command: "account_tx",
      account: address,
      ledger_index_min: minLedger,
      limit: 20,
      forward: false,
    });
    const txs = (page.result && page.result.transactions) || [];
    for (const row of txs) {
      const tx = row.tx || row.tx_json || row;
      if (!tx || tx.TransactionType !== "Payment") continue;
      if (tx.Account !== book.accounts.W7.address) continue;
      if (tx.Destination !== address) continue;
      if (Number(tx.SourceTag) !== share.tag) continue;
      const meta = row.meta || {};
      if (meta.TransactionResult && meta.TransactionResult !== "tesSUCCESS") continue;
      found[share.key] = {
        hash: String(tx.hash || row.hash || "").toUpperCase(),
        amount: String(tx.Amount),
        ledger_index: row.ledger_index == null ? tx.ledger_index : row.ledger_index,
      };
    }
  }
  return found;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const split = guard.splitDrops(args.drops);
  const book = loadBook();
  const ws = guard.assertXahauTestnetUrl(process.env.XAHAU_WS_URL || guard.XAHAU_WS);
  console.log(`dry-run ${args.dryRun}`);
  console.log(`drops ${split.drops} action ${split.action}`);
  for (const share of guard.SHARES) {
    const amount = split.shares[share.key];
    console.log(`${share.key} ${amount} -> ${book.accounts[share.key].address} tag ${share.tag}`);
  }
  if (split.action !== "split") die("trial amount is below the dust threshold", 2);
  if (args.dryRun) {
    console.log("no tx hash (not submitted)");
    return;
  }
  guard.assertCanSign(process.env);
  const seed = guard.lookupSecret(process.env, ["W7_PAYER_SEED"]);
  if (!seed) {
    die(
      [
        "W7_PAYER_SEED is not loaded.",
        "Refusing to sign.",
        "One-click on the Foundry box:",
        "npm run xahau:trial -- --drops 1000000 --record",
      ].join("\n")
    );
  }
  const wallet = guard.walletFromSecret(seed);
  if (wallet.address !== book.accounts.PAYER.address) {
    die("W7_PAYER_SEED address does not match the Xahau address book");
  }
  const client = new xahau.Client(ws);
  await client.connect();
  try {
    const info = await client.request({ command: "server_info" });
    guard.assertNetworkId(info.result.info.network_id);
    const before = {};
    before.W7 = await dropsOf(client, book.accounts.W7.address);
    for (const share of guard.SHARES) {
      before[share.key] = await dropsOf(client, book.accounts[share.key].address);
    }
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: book.accounts.W7.address,
      Amount: split.drops.toString(),
      SourceTag: TRIAL_TAG,
      NetworkID: guard.NETWORK_ID,
    });
    guard.assertNetworkId(prepared.NetworkID);
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const view = resultView(submitted);
    console.log(`payment ${view.hash} ${view.engine} ledger ${view.ledger_index}`);
    if (view.engine !== "tesSUCCESS") die(`payment ${view.engine || "failed"}`, 2);
    const execs = hookExecutions(view.meta);
    console.log(`hook executions ${execs.length}`);
    let emits = {};
    const minLedger = view.ledger_index == null ? -1 : Number(view.ledger_index);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      emits = await findEmits(client, book, minLedger);
      const keys = Object.keys(emits);
      console.log(`emit scan ${attempt + 1} found ${keys.join(",") || "none"}`);
      if (keys.length === guard.SHARES.length) break;
      await sleep(2000);
    }
    const after = {};
    after.W7 = await dropsOf(client, book.accounts.W7.address);
    for (const share of guard.SHARES) {
      after[share.key] = await dropsOf(client, book.accounts[share.key].address);
      const delta = after[share.key] - before[share.key];
      const want = split.shares[share.key];
      const got = emits[share.key];
      console.log(
        `${share.key} delta ${delta} want ${want} hash ${got ? got.hash : "missing"}`
      );
      if (!got) die(`missing emit for ${share.key}`, 2);
      if (got.amount !== want.toString()) die(`${share.key} amount ${got.amount} != ${want}`, 2);
      if (delta !== want) die(`${share.key} balance delta ${delta} != ${want}`, 2);
    }
    console.log(`W7 delta ${after.W7 - before.W7}`);
    if (args.record) {
      const row = {
        ts: new Date().toISOString(),
        action: "xahau_split_trial",
        network: "Xahau Testnet",
        network_id: guard.NETWORK_ID,
        payer: wallet.address,
        treasury: book.accounts.W7.address,
        amount_drops: split.drops.toString(),
        source_tag: TRIAL_TAG,
        hash: view.hash,
        ledger_index: view.ledger_index,
        emits: Object.fromEntries(
          guard.SHARES.map((share) => [
            share.key,
            {
              address: book.accounts[share.key].address,
              drops: split.shares[share.key].toString(),
              hash: emits[share.key].hash,
              tag: share.tag,
            },
          ])
        ),
        w7_delta_drops: (after.W7 - before.W7).toString(),
      };
      fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
      console.log("recorded xahau_split_trial");
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
