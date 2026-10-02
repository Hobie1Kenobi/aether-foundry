#!/usr/bin/env node
"use strict";

/**
 * Daily W3 outbound buy of someone else's Testnet x402 SKU.
 * Dry-run unless --live. Cap 500000 drops (0.5 XRP).
 * SourceTag plus an aether-foundry memo so an indexer can see the payment.
 * Does not call a facilitator settle endpoint. Does not print a seed.
 * A shop that settles the presigned blob gets PAYMENT-SIGNATURE first
 * (payload.signedTxBlob and payload.invoiceId) and is not submitted by Foundry.
 * payment_not_on_ledger still submits that same blob once, then retries.
 *
 *   npm run x402:citizen
 *   npm run x402:citizen -- --url https://foreign.example/sku
 *   FOUNDRY_DAEMON_LIVE=yes npm run x402:citizen -- --live --url https://foreign.example/sku --record
 */

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const guard = require("./x402-outbound-guard");
const record = require("./x402-outbound-record");
const runtimePolicy = require("./runtime/policy");
const outbound = require("./x402-outbound");

const ROOT = path.resolve(__dirname, "..");
const CANDIDATES = path.join(ROOT, "machines", "x402-citizen", "candidates.json");
const CAP_DROPS = runtimePolicy.OUTBOUND_MAX_DROPS;
const FINGERPRINT_TAG = 202609296;
const FINGERPRINT_MEMO = "aether-foundry:f11";
const MEMO_TYPE = "aether-foundry";

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function loadCandidates(file, io) {
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  if (!exists(file)) return [];
  let doc;
  try {
    doc = JSON.parse(readFile(file, "utf8"));
  } catch {
    throw Object.assign(new Error("candidates.json is not JSON"), { code: "PARSE" });
  }
  const urls = doc && Array.isArray(doc.urls) ? doc.urls : [];
  return urls.map((item) => String(item).trim()).filter(Boolean);
}

function parseArgs(argv) {
  const live = argv.includes("--live");
  const dryFlag = argv.includes("--dry-run");
  if (live && dryFlag) {
    throw Object.assign(new Error("pass either --live or --dry-run"), { code: "PARSE" });
  }
  const recordHit = argv.includes("--record");
  const args = argv.filter((arg) => arg !== "--live" && arg !== "--dry-run" && arg !== "--record");
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
    if (arg.startsWith("--")) {
      throw Object.assign(new Error(`unknown flag ${arg}`), { code: "PARSE" });
    }
    if (!url) url = arg;
    else throw Object.assign(new Error(`unexpected arg ${arg}`), { code: "PARSE" });
  }
  return { url, maxDrops, live, record: recordHit, dryRun: !live };
}

function memoHex(text) {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

function buildCitizenTx({ account, accept }) {
  const tx = guard.buildPaymentTx({ account, accept });
  const extra = accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  const shopTag = extra.sourceTag != null && extra.sourceTag !== "" ? Number(extra.sourceTag) : null;
  if (shopTag == null) tx.SourceTag = FINGERPRINT_TAG;
  const memos = Array.isArray(tx.Memos) ? tx.Memos.slice() : [];
  memos.push({
    Memo: {
      MemoType: memoHex(MEMO_TYPE),
      MemoData: memoHex(FINGERPRINT_MEMO),
    },
  });
  tx.Memos = memos;
  return tx;
}

function capDrops(amount, maxDropsFlag) {
  const drops = guard.normalizeDrops(amount);
  if (drops == null || BigInt(drops) <= 0n || BigInt(drops) > CAP_DROPS) {
    throw Object.assign(new Error("refusing outbound above 500000 drops"), { code: "CAP" });
  }
  if (maxDropsFlag != null && String(maxDropsFlag).length > 0) {
    if (!/^[0-9]+$/.test(String(maxDropsFlag))) {
      throw Object.assign(new Error("cost ceiling must be drops"), { code: "AMOUNT" });
    }
    if (BigInt(drops) > BigInt(maxDropsFlag)) {
      throw Object.assign(new Error("too expensive vs DIY"), { code: "CAP" });
    }
  }
  return drops;
}

function candidateList(args, env, io) {
  if (args.url) return [guard.assertResourceUrl(args.url)];
  if (env && env.X402_FOREIGN_URL) return [guard.assertResourceUrl(env.X402_FOREIGN_URL)];
  return loadCandidates(CANDIDATES, io).map((item) => guard.assertResourceUrl(item));
}

async function probeUrl(resourceUrl, fetchImpl, index) {
  const response = await fetchImpl(resourceUrl);
  const header = response.headers && response.headers.get ? response.headers.get("payment-required") : "";
  const bodyText = await response.text();
  if (response.status !== 402 || !header) {
    return { ok: false, reason: `expected 402, got ${response.status}` };
  }
  const required = guard.parsePaymentRequired(header, bodyText);
  const accept = guard.selectAccept(required);
  guard.assertForeignPayTo(accept.payTo, index);
  capDrops(accept.amount);
  return { ok: true, resourceUrl, required, accept };
}

function hitReport(text) {
  return {
    x402_foreign_hits: require("../web/lib/x402-facilitator").countForeignX402Hits(text),
    x402_outbound_hits: record.countOutbound(text),
  };
}

function ledgerText(root, io) {
  const file = path.join(root || ROOT, "lab", "ledger-log.jsonl");
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  return exists(file) ? readFile(file, "utf8") : "";
}

function loadSignerSeed(env, io) {
  if (env.W3_REGULAR_SEED) return { seed: env.W3_REGULAR_SEED, key_env: "W3_REGULAR_SEED" };
  if (env.W3_SEED) return { seed: env.W3_SEED, key_env: "W3_SEED" };
  const parsed = outbound.loadEnvText;
  const file = env.AETHER_SECRETS || outbound.SECRETS_PATH;
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  if (!exists(file)) return { seed: "", key_env: "" };
  const values = parsed(readFile(file, "utf8"));
  if (values.W3_REGULAR_SEED) return { seed: values.W3_REGULAR_SEED, key_env: "W3_REGULAR_SEED" };
  if (values.W3_SEED) return { seed: values.W3_SEED, key_env: "W3_SEED" };
  return { seed: "", key_env: "" };
}

function baseReport(extra) {
  return Object.assign(
    {
      network: "xrpl:1",
      network_id: 1,
      payer: guard.W3_ADDRESS,
      cap_drops: String(CAP_DROPS),
      fingerprint_source_tag: FINGERPRINT_TAG,
      fingerprint_memo: FINGERPRINT_MEMO,
      signed: false,
      hash: null,
      settles: false,
    },
    extra || {}
  );
}

async function discover(urls, fetchImpl, index) {
  const notes = [];
  for (const resourceUrl of urls) {
    try {
      const probed = await probeUrl(resourceUrl, fetchImpl, index);
      if (probed.ok) return { chosen: probed, notes };
      notes.push(`${resourceUrl} ${probed.reason}`);
    } catch (error) {
      notes.push(`${resourceUrl} ${error.message || error}`);
    }
  }
  return { chosen: null, notes };
}

async function run(opts) {
  const options = opts || {};
  const env = options.env || {};
  const args = options.args || parseArgs(options.argv || []);
  const index = options.index || guard.foundryIndex();
  const text = options.ledgerText != null ? options.ledgerText : ledgerText(options.root, options.io);
  const hits = hitReport(text);
  let urls = [];
  try {
    urls = options.urls || candidateList(args, env, options.io);
  } catch (error) {
    return baseReport({
      dry_run: true,
      live_requested: Boolean(args.live),
      foreign_shop: null,
      reason: error.message,
      notes: [],
      hits,
    });
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const found = urls.length ? await discover(urls, fetchImpl, index) : { chosen: null, notes: [] };
  if (!found.chosen) {
    return baseReport({
      dry_run: true,
      live_requested: Boolean(args.live),
      foreign_shop: null,
      reason: urls.length ? "no foreign testnet SKU under the cap answered 402" : "no foreign shop configured",
      notes: found.notes,
      hits,
    });
  }
  const accept = found.chosen.accept;
  let drops;
  try {
    drops = capDrops(accept.amount, args.maxDrops);
  } catch (error) {
    return baseReport({
      dry_run: true,
      live_requested: Boolean(args.live),
      foreign_shop: found.chosen.resourceUrl,
      pay_to: accept.payTo,
      reason: error.message,
      code: error.code,
      notes: found.notes,
      hits,
    });
  }
  const tx = buildCitizenTx({ account: guard.W3_ADDRESS, accept });
  const preview = {
    dry_run: !args.live,
    live_requested: Boolean(args.live),
    foreign_shop: found.chosen.resourceUrl,
    pay_to: accept.payTo,
    drops,
    source_tag: tx.SourceTag,
    shop_source_tag: accept.extra && accept.extra.sourceTag != null ? Number(accept.extra.sourceTag) : null,
    invoice: accept.extra && accept.extra.invoiceId ? accept.extra.invoiceId : null,
    notes: found.notes,
    hits,
    tx,
  };
  if (!args.live) return baseReport(preview);
  if (guard.envIsCi(env)) {
    throw Object.assign(new Error("refusing to sign under CI"), { code: "CI" });
  }
  if (!env || env.FOUNDRY_DAEMON_LIVE !== "yes") {
    throw Object.assign(new Error("refusing --live without FOUNDRY_DAEMON_LIVE=yes"), { code: "LIVE_GATE" });
  }
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* torn line */
    }
  }
  if (runtimePolicy.paidOnUtcDay(rows, "x402_outbound", options.now || new Date())) {
    throw Object.assign(new Error("refusing a second outbound on this UTC day"), { code: "NOT_DUE" });
  }
  const fetchPaid = options.fetchImpl || globalThis.fetch;
  async function finishLive(signed, submit, keyEnv) {
    if (!signed || typeof signed.tx_blob !== "string" || !signed.tx_blob || !signed.hash) {
      throw Object.assign(new Error("signer did not return a signed blob"), { code: "SUBMIT" });
    }
    const delivered = await guard.deliverForeignPayment({
      fetchImpl: fetchPaid,
      resourceUrl: found.chosen.resourceUrl,
      required: found.chosen.required,
      accept,
      txBlob: signed.tx_blob,
      hash: signed.hash,
      submit,
      sleep: options.sleep,
    });
    if (args.record && delivered.http_status === 200 && delivered.hash) {
      const write = options.recordOutbound || record.recordOutbound;
      write({
        network: "xrpl:1",
        resource_url: found.chosen.resourceUrl,
        pay_to: accept.payTo,
        payer: guard.W3_ADDRESS,
        amount_drops: drops,
        source_tag: tx.SourceTag,
        invoice_id: preview.invoice,
        hash: delivered.hash,
        ledger_index: delivered.ledger_index,
        http_status: 200,
      });
    }
    return baseReport(
      Object.assign(preview, {
        dry_run: false,
        signed: true,
        submitted: delivered.submitted,
        settlement: delivered.mode,
        hash: delivered.hash,
        result: delivered.result,
        http_status: delivered.http_status,
        body: delivered.body,
        key_env: keyEnv || undefined,
      })
    );
  }
  if (typeof options.sign === "function") {
    const signed = await options.sign(tx);
    return finishLive(signed, options.submit, "");
  }
  const loaded = loadSignerSeed(env, options.io);
  if (!loaded.seed) {
    throw Object.assign(
      new Error("W3_REGULAR_SEED or W3_SEED is not loaded. Refusing to sign."),
      { code: "SEED" }
    );
  }
  let wallet;
  try {
    wallet = xrpl.Wallet.fromSeed(loaded.seed);
  } catch {
    throw Object.assign(new Error("W3 signer seed is not usable"), { code: "SEED" });
  }
  if (wallet.classicAddress !== guard.W3_ADDRESS) {
    throw Object.assign(new Error("signer address is not W3 CHANNELS"), { code: "ACCOUNT" });
  }
  const ws = guard.assertTestnetUrl(env.XRPL_WS_URL || guard.XRPL_WS);
  const client = new xrpl.Client(ws);
  await client.connect();
  try {
    if (client.networkID !== 1) {
      throw Object.assign(new Error(`refusing NetworkID ${client.networkID}`), { code: "invalid_network" });
    }
    const prepared = await client.autofill(tx);
    if (prepared.NetworkID != null && Number(prepared.NetworkID) !== 1) {
      throw Object.assign(new Error("refusing NetworkID other than 1"), { code: "invalid_network" });
    }
    const signed = wallet.sign(prepared);
    return finishLive(
      signed,
      async () => {
        const submitted = await client.submitAndWait(signed.tx_blob);
        const result = (submitted && (submitted.result || submitted)) || {};
        const meta = result.meta || result.metaData || {};
        return {
          hash: result.hash || signed.hash,
          result: meta.TransactionResult,
          ledger_index: result.ledger_index == null ? null : result.ledger_index,
        };
      },
      loaded.key_env
    );
  } finally {
    await client.disconnect();
  }
}

function printReport(report) {
  console.log(report.dry_run ? "dry-run" : "live");
  console.log("network", report.network);
  console.log("network_id", report.network_id);
  console.log("payer", report.payer);
  console.log("foreign_shop", report.foreign_shop || "none");
  console.log("pay_to", report.pay_to || "none");
  console.log("drops", report.drops == null ? "none" : report.drops);
  console.log("source_tag", report.source_tag == null ? report.fingerprint_source_tag : report.source_tag);
  console.log("fingerprint_memo", report.fingerprint_memo);
  console.log("cap_drops", report.cap_drops);
  console.log("signed", report.signed ? "true" : "false");
  console.log("x402_foreign_hits", report.hits ? report.hits.x402_foreign_hits : 0);
  console.log("x402_outbound_hits", report.hits ? report.hits.x402_outbound_hits : 0);
  if (report.reason) console.log("reason", report.reason);
  if (report.notes && report.notes.length) console.log("notes", report.notes.join(" | "));
  if (report.settlement) console.log("settlement", report.settlement);
  if (report.http_status != null) console.log("http_status", report.http_status);
  if (report.hash) console.log("hash", report.hash);
  else console.log("no tx hash (not submitted)");
}

async function main() {
  try {
    const report = await run({ argv: process.argv.slice(2), env: process.env });
    printReport(report);
    if (report.code === "CAP") process.exitCode = 2;
    else if (!report.dry_run && report.http_status != null && report.http_status !== 200) process.exitCode = 1;
  } catch (error) {
    console.error(error.message || error);
    process.exit(error.code === "CAP" || error.code === "NOT_DUE" || error.code === "LIVE_GATE" ? 2 : 1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CAP_DROPS,
  FINGERPRINT_TAG,
  FINGERPRINT_MEMO,
  MEMO_TYPE,
  CANDIDATES,
  parseArgs,
  loadCandidates,
  buildCitizenTx,
  capDrops,
  candidateList,
  probeUrl,
  hitReport,
  loadSignerSeed,
  run,
  printReport,
};
