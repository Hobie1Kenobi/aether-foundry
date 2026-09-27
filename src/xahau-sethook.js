#!/usr/bin/env node
"use strict";

/**
 * Install the W7 split hook on Xahau Testnet.
 * Loads W7_SEED (or XAHAU_SEED) from the environment or the secrets file.
 * Never prints the seed. Refuses CI, mainnet, and plain XRPL Testnet.
 *
 *   npm run xahau:sethook -- --dry-run
 *   npm run xahau:sethook -- --record
 *   npm run xahau:sethook -- --override --record
 */

const fs = require("fs");
const path = require("path");
const xahau = require("xahau");
const guard = require("./xahau-split-guard");

const ROOT = path.resolve(__dirname, "..");
const BOOK = path.join(ROOT, "machines", "xahau-split-treasury", "addresses.json");
const WASM = path.join(ROOT, "hooks", "w7-split", "w7-split.wasm");
const LOG = path.join(ROOT, "lab", "ledger-log.jsonl");

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function parseArgs(argv) {
  const out = { dryRun: false, record: false, override: false };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--override") out.override = true;
    else die(`unknown flag ${arg}`);
  }
  return out;
}

function loadBook() {
  if (!fs.existsSync(BOOK)) {
    die("no Xahau address book. Run npm run xahau:provision on the Foundry box.");
  }
  return JSON.parse(fs.readFileSync(BOOK, "utf8"));
}

function destinationMap(book) {
  const out = {};
  for (const share of guard.SHARES) {
    const row = book.accounts[share.key];
    if (!row || !row.address) die(`address book missing ${share.key}`);
    out[share.key] = row.address;
  }
  return out;
}

function buildTx(book, wasm, override) {
  const treasury = book.accounts.W7.address;
  const parameters = guard.hookParameters(destinationMap(book), treasury);
  const hook = {
    CreateCode: wasm.toString("hex").toUpperCase(),
    HookApiVersion: 0,
    HookNamespace: guard.namespaceHex(),
    HookOnIncoming: guard.hookOnPayment(),
    HookOnOutgoing: guard.hookOnNone(),
    HookCanEmit: guard.hookOnPayment(),
    HookParameters: parameters,
  };
  if (override) hook.Flags = 1;
  return {
    TransactionType: "SetHook",
    Account: treasury,
    NetworkID: guard.NETWORK_ID,
    Hooks: [{ Hook: hook }],
  };
}

function minFeeDrops(wasm, tx) {
  const params = tx.Hooks[0].Hook.HookParameters;
  let paramBytes = 0;
  for (const row of params) {
    const hook = row.HookParameter;
    paramBytes += hook.HookParameterName.length / 2;
    paramBytes += hook.HookParameterValue.length / 2;
  }
  return wasm.length * 500 + paramBytes + 100;
}

function resultView(submitted) {
  const result = (submitted && (submitted.result || submitted)) || {};
  const meta = result.meta || result.metaData || {};
  return {
    hash: result.hash,
    engine: meta.TransactionResult,
    ledger_index: result.ledger_index == null ? null : result.ledger_index,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ws = guard.assertXahauTestnetUrl(process.env.XAHAU_WS_URL || guard.XAHAU_WS);
  const book = loadBook();
  const wasm = fs.readFileSync(WASM);
  guard.assertHookWasm(wasm);
  const tx = buildTx(book, wasm, args.override);
  const floor = minFeeDrops(wasm, tx);
  console.log(`dry-run ${args.dryRun}`);
  console.log(`W7 ${book.accounts.W7.address}`);
  console.log(`wasm ${wasm.length} bytes`);
  console.log(`namespace ${tx.Hooks[0].Hook.HookNamespace}`);
  console.log(`HookOnIncoming ${tx.Hooks[0].Hook.HookOnIncoming}`);
  console.log(`HookOnOutgoing ${tx.Hooks[0].Hook.HookOnOutgoing}`);
  console.log(`HookCanEmit ${tx.Hooks[0].Hook.HookCanEmit}`);
  console.log(`fee floor ${floor} drops`);
  for (const share of guard.SHARES) {
    console.log(`${share.key} ${share.bps == null ? "remainder" : `${share.bps} bps`} tag ${share.tag} ${book.accounts[share.key].address}`);
  }
  const client = new xahau.Client(ws);
  await client.connect();
  try {
    const info = await client.request({ command: "server_info" });
    const networkId = info.result.info.network_id;
    guard.assertNetworkId(networkId);
    console.log(`server network_id ${networkId} ${info.result.info.build_version}`);
    const prepared = await client.autofill(tx);
    guard.assertNetworkId(prepared.NetworkID);
    const autofillFee = BigInt(prepared.Fee);
    if (autofillFee < BigInt(floor)) prepared.Fee = String(floor);
    console.log(`fee ${prepared.Fee} drops sequence ${prepared.Sequence}`);
    if (args.dryRun) {
      console.log("no tx hash (not submitted)");
      return;
    }
    guard.assertCanSign(process.env);
    const seed = guard.lookupSecret(process.env, ["W7_SEED", "XAHAU_SEED"]);
    if (!seed) {
      die(
        [
          "W7_SEED is not loaded. Put W7_SEED in AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.",
          "Refusing to sign.",
          "One-click on the Foundry box:",
          "npm run xahau:sethook -- --record",
        ].join("\n")
      );
    }
    const wallet = guard.walletFromSecret(seed);
    if (wallet.address !== book.accounts.W7.address) {
      die("W7_SEED address does not match the Xahau address book");
    }
    const signed = wallet.sign(prepared);
    const queued = await client.submit(signed.tx_blob);
    const queuedResult = queued.result || queued;
    const engine = queuedResult.engine_result || "";
    console.log(`submit ${engine} ${queuedResult.engine_result_message || ""}`.trim());
    if (engine === "telINSUF_FEE_P") {
      die(`fee too low (${prepared.Fee}). ${queuedResult.engine_result_message || ""}`.trim(), 2);
    }
    if (!engine.startsWith("tes") && !engine.startsWith("ter")) {
      die(queuedResult.engine_result_message || engine || "submit rejected", 2);
    }
    const submitted = await client.submitAndWait(signed.tx_blob);
    const view = resultView(submitted);
    console.log(`submitted ${view.hash || "no-hash"} ${view.engine || "no-result"} ledger ${view.ledger_index}`);
    if (view.engine !== "tesSUCCESS") die(`SetHook ${view.engine || "failed"}`, 2);
    if (args.record && view.hash) {
      const row = {
        ts: new Date().toISOString(),
        action: "xahau_set_hook",
        network: "Xahau Testnet",
        network_id: guard.NETWORK_ID,
        account: wallet.address,
        hash: view.hash.toUpperCase(),
        ledger_index: view.ledger_index,
        wasm_bytes: wasm.length,
        fee_drops: prepared.Fee,
      };
      fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
      console.log("recorded xahau_set_hook");
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
