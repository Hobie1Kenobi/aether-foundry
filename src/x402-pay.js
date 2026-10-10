#!/usr/bin/env node
"use strict";

/**
 * Buyer for the desk x402 routes. Signs on the operator machine, not in web/.
 * Seed comes from XRPL_BUYER_SEED only. Never printed. Testnet only.
 *
 *   DESK_URL=http://127.0.0.1:3000 XRPL_BUYER_SEED=... npm run x402:pay -- reserve-audit
 *   npm run x402:pay -- machine-spec --prompt "channel plus nft receipt" --record
 *   npm run x402:pay -- composition-quote --units 10 --record
 */

const xrpl = require("xrpl");
const hosts = require("./xrpl-hosts");
const rules = require("../web/lib/x402-rules");
const guard = require("./x402-outbound-guard");
const hits = require("./x402-hits");

function die(message) {
  console.error(message);
  process.exit(1);
}

function envIsCi(env) {
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
}

function isMainnetUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const blocked = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link"];
    return blocked.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const record = argv.includes("--record");
  const args = argv.filter((arg) => arg !== "--record");
  let sku = "reserve-audit";
  let prompt = "";
  let units = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--prompt") prompt = args[i + 1] || "";
    else if (args[i] === "--units") units = args[i + 1] || "";
    else if (!args[i].startsWith("--")) sku = args[i];
    else die(`unknown flag ${args[i]}`);
    if (args[i] === "--prompt" || args[i] === "--units") i += 1;
  }
  return { sku, prompt, units, record };
}

async function main() {
  if (envIsCi(process.env)) die("refusing to sign under CI");
  const seed = process.env.XRPL_BUYER_SEED;
  if (!seed) die("Set XRPL_BUYER_SEED to a Testnet seed. This script does not read git.");
  const { sku, prompt, units, record } = parseArgs(process.argv.slice(2));
  const row = rules.getSku(sku);
  if (!row) die(`unknown sku ${sku}`);

  const desk = (process.env.DESK_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const ws = hosts.resolveWs(process.env);
  if (isMainnetUrl(ws)) die("refusing mainnet WebSocket");
  const url = new URL(desk + row.path);
  if (prompt) url.searchParams.set("prompt", prompt);
  if (units) url.searchParams.set("units", units);

  const first = await fetch(url);
  const challenge = first.headers.get("payment-required");
  if (first.status !== 402 || !challenge) {
    const text = await first.text();
    die(`expected 402 with PAYMENT-REQUIRED, got ${first.status}: ${text.slice(0, 500)}`);
  }
  const required = rules.decodeHeader(challenge);
  const accept = required && required.accepts && required.accepts[0];
  if (!accept || accept.network !== rules.NETWORK) die("desk did not require xrpl:1");
  if (accept.payTo !== rules.PAY_TO) die("desk payTo is not W3 CHANNELS");
  if (accept.amount !== row.drops) die("desk price does not match the SKU");
  if (Number(accept.extra && accept.extra.sourceTag) !== row.sourceTag) {
    die("desk sourceTag does not match the SKU");
  }
  const invoiceId = accept.extra.invoiceId;

  const client = await hosts.openClient(ws, {
    assertUrl: (url) => {
      if (isMainnetUrl(url)) die("refusing mainnet WebSocket");
    },
  });
  let wallet;
  try {
    wallet = xrpl.Wallet.fromSeed(seed);
  } catch {
    die("XRPL_BUYER_SEED is not a usable seed");
  }
  try {
    assertNotCircularBuyer(wallet.classicAddress, rules.PAY_TO);
  } catch (err) {
    try { await client.disconnect(); } catch { /* already closed */ }
    die(err.message || String(err));
  }
  console.log("payer", wallet.classicAddress);
  console.log("sku", row.id, "drops", row.drops, "invoice", invoiceId);

  try {
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: accept.payTo,
      Amount: accept.amount,
      SourceTag: Number(accept.extra.sourceTag),
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from("invoice", "utf8").toString("hex").toUpperCase(),
            MemoData: Buffer.from(invoiceId, "utf8").toString("hex").toUpperCase(),
          },
        },
      ],
    });
    if (prepared.NetworkID === 0) die("refusing NetworkID 0");
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const result = submitted.result || submitted;
    const meta = result.meta || result.metaData || {};
    if (meta.TransactionResult !== "tesSUCCESS") {
      die(`payment result ${meta.TransactionResult || "missing"}`);
    }
    const hash = result.hash;
    console.log("paid", hash);

    const payload = guard.buildSignaturePayload({
      required,
      accept,
      txBlob: signed.tx_blob,
      hash,
    });
    const retry = await fetch(url, {
      headers: {
        Accept: "application/json",
        "PAYMENT-SIGNATURE": rules.encodeHeader(payload),
      },
    });
    const text = await retry.text();
    console.log("status", retry.status);
    console.log(text);
    const settled = retry.headers.get("payment-response");
    if (settled) {
      console.log("PAYMENT-RESPONSE", JSON.stringify(rules.decodeHeader(settled), null, 2));
    }
    if (retry.status !== 200) process.exitCode = 1;
    if (record && retry.status === 200) {
      const body = JSON.parse(text);
      console.log("recorded", JSON.stringify(hits.recordHit(body)));
    }
  } finally {
    await client.disconnect();
  }
}

function assertNotCircularBuyer(address, payTo) {
  if (address === payTo) {
    throw new Error("refusing W3 as the desk buyer (circular: desk SKUs settle to W3)");
  }
}

module.exports = { assertNotCircularBuyer, envIsCi, isMainnetUrl };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
