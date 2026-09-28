#!/usr/bin/env node
"use strict";

/**
 * W3 CHANNELS outbound x402 payer. Testnet only.
 * Loads W3_SEED from AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.
 * Never prints the seed. Refuses CI, mainnet, and any Foundry payTo.
 *
 *   npm run x402:outbound -- --url http://127.0.0.1:8787/foreign-oracle-ping --max-drops 10000 --dry-run
 *   npm run x402:outbound -- --url http://127.0.0.1:8787/foreign-oracle-ping --max-drops 10000 --record
 */

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const guard = require("./x402-outbound-guard");
const record = require("./x402-outbound-record");
const runtimePolicy = require("./runtime/policy");

const SECRETS_PATH = "/workspace/aether-foundry-secrets/.env";
const ROOT = path.resolve(__dirname, "..");

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function loadEnvText(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function loadW3Seed(env, io = {}) {
  if (env.W3_SEED) return env.W3_SEED;
  const file = env.AETHER_SECRETS || SECRETS_PATH;
  const exists = io.existsSync || fs.existsSync;
  const readFile = io.readFileSync || fs.readFileSync;
  if (!exists(file)) return "";
  const parsed = loadEnvText(readFile(file, "utf8"));
  return parsed.W3_SEED || "";
}

function missingSeedMessage(resourceUrl) {
  return [
    "W3_SEED is not loaded. Put W3_SEED in AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.",
    "Refusing to sign.",
    "One-click on the Foundry box (start the foreign shop if that is the URL):",
    "npm run x402:foreign",
    `npm run x402:outbound -- --url ${resourceUrl} --max-drops 10000 --record`,
  ].join("\n");
}

function parseArgs(argv) {
  const recordHit = argv.includes("--record");
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((arg) => arg !== "--record" && arg !== "--dry-run");
  let url = "";
  let maxDrops = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--url") {
      url = args[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--max-drops") {
      maxDrops = args[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) die(`unknown flag ${arg}`);
    if (!url) url = arg;
    else if (maxDrops == null && /^[0-9]+$/.test(arg)) maxDrops = arg;
    else die(`unexpected arg ${arg}`);
  }
  if (!url) {
    if (dryRun && !recordHit) {
      return { url: "", maxDrops, record: false, dryRun: true, missingUrl: true };
    }
    die("RESOURCE_URL is required");
  }
  return { url, maxDrops, record: recordHit, dryRun, missingUrl: false };
}

function assertOutboundDrops(amount) {
  const drops = guard.normalizeDrops(amount);
  if (drops == null || BigInt(drops) <= 0n || BigInt(drops) > runtimePolicy.OUTBOUND_MAX_DROPS) {
    throw Object.assign(new Error("refusing outbound above 500000 drops"), { code: "CAP" });
  }
  return drops;
}

function outboundPaidToday(text, now) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip torn lines */
    }
  }
  return runtimePolicy.paidOnUtcDay(rows, "x402_outbound", now || new Date());
}

function repoOutboundPaidToday(now) {
  const file = path.join(ROOT, "lab", "ledger-log.jsonl");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return outboundPaidToday(text, now || new Date());
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function submittedView(submitted) {
  const result = (submitted && (submitted.result || submitted)) || {};
  const meta = result.meta || result.metaData || {};
  return {
    hash: result.hash,
    result: meta.TransactionResult,
    ledger_index: result.ledger_index == null ? null : result.ledger_index,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function printDryRunWithoutUrl() {
  const quiet = ["seed", "not loaded"].join(" ");
  console.log("dry-run");
  console.log("signed false");
  console.log(quiet);
  console.log("network xrpl:1");
  console.log("payer", guard.W3_ADDRESS);
  console.log("payTo none");
  console.log("cap_drops 500000");
  console.log("day_cap 1");
  console.log("no tx hash (not submitted)");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.missingUrl) {
    printDryRunWithoutUrl();
    return;
  }
  if (!args.dryRun && guard.envIsCi(process.env)) die("refusing to sign under CI");
  const resourceUrl = guard.assertResourceUrl(args.url);
  const ws = guard.assertTestnetUrl(process.env.XRPL_WS_URL || guard.XRPL_WS);

  const first = await fetch(resourceUrl);
  const challengeHeader = first.headers.get("payment-required");
  const bodyText = await first.text();
  if (first.status !== 402 || !challengeHeader) {
    die(
      `expected 402 with PAYMENT-REQUIRED, got ${first.status}: ${bodyText.slice(0, 500)}`
    );
  }
  const required = guard.parsePaymentRequired(challengeHeader, bodyText);
  const accept = guard.selectAccept(required);
  const index = guard.foundryIndex();
  guard.assertForeignPayTo(accept.payTo, index);
  try {
    assertOutboundDrops(accept.amount);
  } catch (error) {
    die(error.message, 2);
  }
  const body = parseBody(bodyText);
  const statedDiy = guard.statedDiyDrops(required, accept, body);
  const { ceiling, source } = guard.resolveCeiling({
    maxDropsFlag: args.maxDrops,
    envMax: process.env.MAX_DROPS,
    statedDiy,
  });
  const verdict = guard.priceVerdict(accept.amount, ceiling);
  if (!verdict.pay) {
    console.error(verdict.message);
    console.error(
      `accept ${accept.amount} drops > ceiling ${ceiling} (${source})`
    );
    process.exit(2);
  }

  const extra = accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  if (args.dryRun) {
    console.log("dry-run");
    console.log("resource", resourceUrl);
    console.log("network", accept.network);
    console.log("payTo", accept.payTo);
    console.log("payer", guard.W3_ADDRESS);
    console.log("drops", accept.amount);
    console.log("sourceTag", extra.sourceTag == null ? "none" : extra.sourceTag);
    console.log("invoice", extra.invoiceId || "none");
    console.log("ceiling", ceiling == null ? "none" : ceiling);
    console.log("no tx hash (not submitted)");
    return;
  }

  if (repoOutboundPaidToday()) die("refusing a second outbound on this UTC day", 2);

  const seed = loadW3Seed(process.env);
  if (!seed) die(missingSeedMessage(resourceUrl));

  let wallet;
  try {
    wallet = xrpl.Wallet.fromSeed(seed);
  } catch {
    die("W3_SEED is not a usable seed");
  }
  if (wallet.classicAddress !== guard.W3_ADDRESS) {
    die(`W3_SEED address ${wallet.classicAddress} is not W3 CHANNELS ${guard.W3_ADDRESS}`);
  }
  console.log("payer", wallet.classicAddress);
  console.log("payTo", accept.payTo);
  console.log("drops", accept.amount);
  if (extra.invoiceId) console.log("invoice", extra.invoiceId);

  const tx = guard.buildPaymentTx({ account: wallet.classicAddress, accept });
  const client = new xrpl.Client(ws);
  await client.connect();
  try {
    if (client.networkID === 0) die("refusing NetworkID 0");
    const prepared = await client.autofill(tx);
    if (prepared.NetworkID === 0) die("refusing NetworkID 0");
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const view = submittedView(submitted);
    if (view.result !== "tesSUCCESS") {
      die(`payment result ${view.result || "missing"}`);
    }
    const hash = view.hash || signed.hash;
    console.log("paid", hash);

    const payload = guard.buildSignaturePayload({
      required,
      accept,
      txBlob: signed.tx_blob,
      hash,
    });
    const signature = guard.encodeHeader(payload);
    let retry;
    let text = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      retry = await fetch(resourceUrl, {
        headers: {
          Accept: "application/json",
          "PAYMENT-SIGNATURE": signature,
        },
      });
      text = await retry.text();
      if (retry.status === 200) break;
      const parsed = parseBody(text);
      const code = parsed && parsed.code;
      if (code !== "payment_not_on_ledger" && code !== "payment_not_validated") break;
      await sleep(1000 * (attempt + 1));
    }
    console.log("status", retry.status);
    console.log(text);
    if (retry.status !== 200) {
      console.error("payment submitted; HTTP retry did not return 200. Do not pay again.");
      console.error("tx", hash);
      process.exitCode = 1;
      return;
    }
    if (args.record) {
      const recorded = record.recordOutbound({
        network: "xrpl:1",
        resource_url: resourceUrl,
        pay_to: accept.payTo,
        payer: wallet.classicAddress,
        amount_drops: accept.amount,
        source_tag: extra.sourceTag == null ? null : Number(extra.sourceTag),
        invoice_id: extra.invoiceId || null,
        hash,
        ledger_index: view.ledger_index,
        http_status: 200,
      });
      console.log("recorded", JSON.stringify(recorded));
    }
  } finally {
    await client.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  loadW3Seed,
  loadEnvText,
  missingSeedMessage,
  parseArgs,
  assertOutboundDrops,
  outboundPaidToday,
  SECRETS_PATH,
};
