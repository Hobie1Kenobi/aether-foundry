#!/usr/bin/env node
"use strict";

/**
 * Agent Work License demo. Dry-run is the default and loads no seed.
 * Live mode asks the loopback signer to sign. This process never reads a seed.
 *
 *   npm run license:demo
 *   npm run license:demo -- --pace 1.5s
 *   FOUNDRY_SIGNER_TOKEN=... npm run license:demo -- --live --pace 1.5s
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const catalog = require("./catalog");
const ledger = require("./ledger");
const server = require("./server");

const HELP = `Usage: node src/license/demo.js [--dry-run] [--live] [--pace 1.5s] [--root DIR] [--job JOB] [--uses N]

Default is --dry-run. It prints the mint, list, buy, redeem, deliver, and settle
steps with explorer links and does not load a seed or call the signer.

--live requires the signer on 127.0.0.1:8787 (FOUNDRY_AGENT_SIGN=yes, FOUNDRY_SIGNER_TOKEN).
The signer holds W2 and W4. This process does not.

--pace 1.5s waits between steps. --pace 0 does not wait.`;

const STEPS = ["MINT", "LIST", "BUY", "REDEEM", "DELIVER", "SETTLE"];

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function coded(message, code) {
  return catalog.coded(message, code);
}

function parsePace(raw) {
  if (raw == null || raw === "") return 0;
  const text = String(raw).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
  if (!match) throw coded(`refusing pace ${raw}`, "ARGS");
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) throw coded(`refusing pace ${raw}`, "ARGS");
  const unit = match[2] || (value > 30 ? "ms" : "s");
  const ms = unit === "ms" ? value : value * 1000;
  if (ms > 30000) throw coded("refusing a pace above 30s", "ARGS");
  return Math.round(ms);
}

function parseArgs(argv) {
  const out = {
    help: false,
    live: false,
    dryRun: true,
    paceMs: 0,
    root: null,
    job: catalog.DEFAULT_JOB,
    uses: catalog.DEFAULT_USES,
    expiry: catalog.DEFAULT_EXPIRY,
  };
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--live") {
      out.live = true;
      out.dryRun = false;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
      out.live = false;
    } else if (arg === "--pace") {
      const pace = args[i + 1];
      if (pace == null) throw coded("--pace requires a duration", "ARGS");
      out.paceMs = parsePace(pace);
      i += 1;
    } else if (arg === "--root") {
      out.root = args[i + 1];
      i += 1;
      if (!out.root) throw coded("--root requires a directory", "ARGS");
    } else if (arg === "--job") {
      out.job = args[i + 1];
      i += 1;
      if (!out.job) throw coded("--job requires a job type", "ARGS");
    } else if (arg === "--uses") {
      out.uses = Number(args[i + 1]);
      i += 1;
    } else throw coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function dryHash(label) {
  return crypto.createHash("sha256").update(`aether-license-demo:${label}`).digest("hex").toUpperCase();
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function banner(index, title, dry) {
  const rule = "─".repeat(72);
  const mode = dry ? "DRY-RUN" : "LIVE";
  return [
    "",
    rule,
    `  ${mode}   Agent Work License   XRPL Testnet   ${index}/${STEPS.length}  ${title}`,
    rule,
  ].join("\n");
}

function field(label, value) {
  return `  ${String(label).padEnd(12)} ${value}`;
}

function txLines(hash, dry) {
  const id = String(hash).toUpperCase();
  return [
    field("tx", id),
    field("explorer", catalog.explorerUrl(id)),
    dry ? field("note", "synthetic hash — nothing was submitted") : field("result", "tesSUCCESS"),
  ].join("\n");
}

function printStep(io, index, title, lines, dry) {
  const write = io.log || console.log;
  write(banner(index, title, dry));
  for (const line of lines) write(line);
}

function summaryTable(rows, dry) {
  const head = `  ${"step".padEnd(10)} ${"what".padEnd(28)} ${"hash".padEnd(20)} link`;
  const rule = `  ${"-".repeat(Math.min(head.length, 100))}`;
  const body = rows.map((row) => {
    const hash = row.hash ? `${row.hash.slice(0, 8)}…${row.hash.slice(-6)}` : "off-ledger";
    const link = row.hash ? catalog.explorerUrl(row.hash) : "—";
    return `  ${row.step.padEnd(10)} ${row.what.padEnd(28)} ${hash.padEnd(20)} ${link}`;
  });
  return [
    "",
    bannerText(dry),
    head,
    rule,
    ...body,
    "",
    dry
      ? "  Dry-run finished. No seed loaded. No transaction submitted."
      : "  Live demo finished. Hashes are on XRPL Testnet.",
    "",
  ].join("\n");
}

function bannerText(dry) {
  return dry
    ? "  Summary   DRY-RUN   network id 1   signer not called"
    : "  Summary   LIVE   network id 1   signer 127.0.0.1:8787";
}

function envIsCi(env) {
  const source = env || {};
  return source.CI === "true" || source.CI === "1" || source.GITHUB_ACTIONS === "true";
}

function signerBase(env) {
  const source = env || {};
  const host = String(source.FOUNDRY_SIGNER_BIND || "127.0.0.1").trim().toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw coded("refusing non-loopback signer", "BIND");
  }
  const port = Number(source.FOUNDRY_SIGNER_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw coded("refusing signer port", "BIND");
  return `http://127.0.0.1:${port}`;
}

async function postJson(url, body, headers, fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const res = await fetchFn(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", accept: "application/json" }, headers || {}),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "response was not JSON" };
  }
  if (!res.ok) {
    throw coded(parsed.error || `HTTP ${res.status}`, parsed.code || "RPC");
  }
  return parsed;
}

function liveClient(env, fetchImpl) {
  const token = String((env || {}).FOUNDRY_SIGNER_TOKEN || "");
  if (token.length < 16) throw coded("FOUNDRY_SIGNER_TOKEN is required for --live", "TOKEN");
  const base = signerBase(env);
  const auth = { authorization: `Bearer ${token}` };
  return {
    async prove() {
      const proved = await ledger.proveNetwork(env, fetchImpl);
      return proved;
    },
    async sign(payload) {
      return postJson(`${base}/sign`, payload, auth, fetchImpl);
    },
    async signChallenge(payload) {
      if (payload.tx) throw coded("refusing tx on the challenge path", "TX");
      return postJson(`${base}/sign-challenge`, {
        wallet: payload.wallet,
        challenge: payload.challenge,
      }, auth, fetchImpl);
    },
    async tx(url, hash) {
      const result = await ledger.post(url, "tx", { transaction: hash, binary: false }, fetchImpl);
      return result;
    },
    async accountNfts(url, account) {
      return ledger.accountNfts(url, account, fetchImpl);
    },
    async readAccount(url, account) {
      const info = await ledger.accountInfo(url, account, fetchImpl);
      const objects = await ledger.accountObjects(url, account, fetchImpl);
      const data = info.account_data || {};
      return {
        info: data,
        objects: objects.objects,
        ledgerIndex: info.ledger_index != null ? info.ledger_index : objects.ledgerIndex,
      };
    },
  };
}

async function runDry(args, io) {
  const log = io.log || console.log;
  const root = args.root ? path.resolve(args.root) : fs.mkdtempSync(path.join(os.tmpdir(), "license-demo-"));
  const doc = catalog.metadata({ job_type: args.job, uses: args.uses, expiry: args.expiry });
  const stored = ledger.writeMetadata(root, doc);
  const nftokenId = dryHash("nftoken");
  const offerId = dryHash("offer");
  const mintHash = dryHash("mint");
  const listHash = dryHash("list");
  const buyHash = dryHash("buy");
  const burnHash = dryHash("burn");
  const fixture = {
    balance_drops: "42000000",
    owner_count: 3,
    sequence: 186,
    ledger_index: 21423010,
  };
  const started = await server.startServer({
    host: "127.0.0.1",
    port: 0,
    root,
    allowDrySignature: true,
    scribe: false,
    now: () => new Date("2026-10-12T04:00:00.000Z"),
    accountNfts: async () => [{
      NFTokenID: nftokenId,
      Issuer: catalog.W2,
      NFTokenTaxon: catalog.TAXON,
      URI: catalog.uriHex(doc),
    }],
    accountInfo: fixture,
    accountObjects: [{ type: "nft" }, { type: "offer" }, { type: "signer" }],
    ledgerIndex: fixture.ledger_index,
  });
  const rows = [];
  try {
    printStep(io, 1, "MINT", [
      field("who", `W2 Atelier  ${catalog.W2}`),
      field("job", doc.job_type),
      field("uses", String(doc.uses)),
      field("expiry", doc.expiry),
      field("flags", "burnable + transferable (9)"),
      field("fee", "TransferFee 5000  ·  5% on a later resale"),
      field("uri", stored.uri),
      txLines(mintHash, true),
    ], true);
    rows.push({ step: "mint", what: "W2 minted the license", hash: mintHash });
    await sleep(args.paceMs);

    const listed = catalog.listTx(nftokenId);
    printStep(io, 2, "LIST", [
      field("who", "W2 sell offer, no Destination"),
      field("price", `${listed.Amount} drops  ·  2 XRP`),
      field("shop", "Walk-In pattern, license line"),
      field("nft", nftokenId),
      txLines(listHash, true),
    ], true);
    rows.push({ step: "list", what: "W2 listed at 2 XRP", hash: listHash });
    await sleep(args.paceMs);

    printStep(io, 3, "BUY", [
      field("who", `W4 Escrow  ${catalog.W4}`),
      field("offer", offerId),
      field("pays", "2 XRP to the issuer"),
      field("note", "issuer sale does not charge the 5% fee"),
      txLines(buyHash, true),
    ], true);
    rows.push({ step: "buy", what: "W4 accepted the offer", hash: buyHash });
    await sleep(args.paceMs);

    const challenged = await postJson(`${started.url}/v1/license/challenge`, {
      account: catalog.W4,
      nftoken_id: nftokenId,
      job: doc.job_type,
    });
    const redeemed = await postJson(`${started.url}/v1/license/redeem`, {
      account: catalog.W4,
      nftoken_id: nftokenId,
      challenge: challenged.challenge,
      signature: "dry-run",
      public_key: "dry-run",
    });
    printStep(io, 4, "REDEEM", [
      field("who", catalog.W4),
      field("check", "signature, holder, uses, expiry, nonce"),
      field("nonce", challenged.nonce),
      field("holder", "account_nfts contains the license"),
      field("uses", `${redeemed.uses_consumed} of ${redeemed.uses_allowed}`),
      field("tx", "(off-ledger verification)"),
    ], true);
    rows.push({ step: "redeem", what: "holder check passed", hash: null });
    await sleep(args.paceMs);

    printStep(io, 5, "DELIVER", [
      field("job", redeemed.job_type),
      field("summary", redeemed.summary),
      field("source", redeemed.summary_source),
      field("balance", `${redeemed.report.balance_drops} drops`),
      field("receipt", "lab/ledger-log.jsonl"),
      field("tx", "(off-ledger receipt)"),
    ], true);
    rows.push({ step: "deliver", what: redeemed.summary_source === "scribe" ? "Scribe summary" : "fallback summary", hash: null });
    await sleep(args.paceMs);

    const burn = redeemed.burn_tx;
    printStep(io, 6, "SETTLE", [
      field("action", redeemed.settle.action),
      field("why", redeemed.settle.reason),
      field("burn", burn ? `${burn.TransactionType} by ${burn.Account}` : "counter only"),
      field("nft", nftokenId),
      burn ? txLines(burnHash, true) : field("tx", "(no burn while uses remain)"),
    ], true);
    rows.push({
      step: "settle",
      what: burn ? "W4 burned the license" : "use counter advanced",
      hash: burn ? burnHash : null,
    });
    log(summaryTable(rows, true));
    return 0;
  } finally {
    await started.close();
  }
}

async function runLive(args, io) {
  const env = io.env || process.env;
  if (envIsCi(env)) throw coded("refusing --live under CI", "CI");
  const log = io.log || console.log;
  const root = path.resolve(args.root || repoRoot());
  const hooks = io.client;
  const fetchImpl = io.fetchImpl || globalThis.fetch;
  const client = hooks || liveClient(env, fetchImpl);
  const proved = hooks && hooks.networkId ? { url: hooks.url, networkId: hooks.networkId } : await client.prove();
  if (Number(proved.networkId) !== 1) throw coded(`refusing network id ${proved.networkId}`, "MAINNET");
  const doc = catalog.metadata({ job_type: args.job, uses: args.uses, expiry: args.expiry });
  const stored = ledger.writeMetadata(root, doc);
  const mintBody = await client.sign({ wallet: "W2", intent: "license_mint", tx: catalog.mintTx(doc) });
  const mintResult = await client.tx(proved.url, mintBody.hash);
  const nftokenId = ledger.extractNFTokenID(mintResult.meta || mintResult);
  if (!nftokenId) throw coded("mint succeeded but NFTokenID was missing", "SUBMIT");
  printStep(io, 1, "MINT", [
    field("who", `W2 Atelier  ${catalog.W2}`),
    field("job", doc.job_type),
    field("uses", String(doc.uses)),
    field("uri", stored.uri),
    field("nft", nftokenId),
    txLines(mintBody.hash, false),
  ], false);
  await sleep(args.paceMs);

  const listBody = await client.sign({
    wallet: "W2",
    intent: "license_list",
    tx: catalog.listTx(nftokenId),
  });
  const listResult = await client.tx(proved.url, listBody.hash);
  const offerId = ledger.extractOfferID(listResult.meta || listResult);
  if (!offerId) throw coded("list succeeded but OfferID was missing", "SUBMIT");
  printStep(io, 2, "LIST", [
    field("who", "W2 sell offer, no Destination"),
    field("price", `${catalog.PRICE_DROPS} drops  ·  2 XRP`),
    field("offer", offerId),
    txLines(listBody.hash, false),
  ], false);
  await sleep(args.paceMs);

  const buyBody = await client.sign({
    wallet: "W4",
    intent: "license_buy",
    tx: catalog.buyTx(offerId),
  });
  printStep(io, 3, "BUY", [
    field("who", `W4 Escrow  ${catalog.W4}`),
    field("offer", offerId),
    field("pays", "2 XRP"),
    txLines(buyBody.hash, false),
  ], false);
  await sleep(args.paceMs);

  const started = await server.startServer({
    host: "127.0.0.1",
    port: 0,
    root,
    allowDrySignature: false,
    regularKeys: io.regularKeys,
    scribe: io.scribe !== false,
    accountNfts: async (account) => client.accountNfts(proved.url, account),
    readAccount: async (account) => client.readAccount(proved.url, account),
    fetchImpl,
  });
  const rows = [
    { step: "mint", what: "W2 minted the license", hash: String(mintBody.hash).toUpperCase() },
    { step: "list", what: "W2 listed at 2 XRP", hash: String(listBody.hash).toUpperCase() },
    { step: "buy", what: "W4 accepted the offer", hash: String(buyBody.hash).toUpperCase() },
  ];
  try {
    const challenged = await postJson(`${started.url}/v1/license/challenge`, {
      account: catalog.W4,
      nftoken_id: nftokenId,
      job: doc.job_type,
    });
    const signed = await client.signChallenge({ wallet: "W4", challenge: challenged.challenge });
    const redeemed = await postJson(`${started.url}/v1/license/redeem`, {
      account: catalog.W4,
      nftoken_id: nftokenId,
      challenge: challenged.challenge,
      signature: signed.signature,
      public_key: signed.public_key,
    });
    printStep(io, 4, "REDEEM", [
      field("who", catalog.W4),
      field("signer", signed.address || signed.account || "W4"),
      field("via", "challenge signature + account_nfts"),
      field("uses", `${redeemed.uses_consumed} of ${redeemed.uses_allowed}`),
      field("tx", "(off-ledger verification)"),
    ], false);
    rows.push({ step: "redeem", what: "holder check passed", hash: null });
    await sleep(args.paceMs);

    printStep(io, 5, "DELIVER", [
      field("job", redeemed.job_type),
      field("summary", redeemed.summary),
      field("source", redeemed.summary_source),
      field("balance", `${redeemed.report.balance_drops} drops`),
      field("receipt", "lab/ledger-log.jsonl"),
      field("tx", "(off-ledger receipt)"),
    ], false);
    rows.push({
      step: "deliver",
      what: redeemed.summary_source === "scribe" ? "Scribe summary" : "fallback summary",
      hash: null,
    });
    await sleep(args.paceMs);

    let burnHash = null;
    if (redeemed.burn_tx) {
      const burned = await client.sign({
        wallet: "W4",
        intent: "license_burn",
        tx: redeemed.burn_tx,
      });
      burnHash = String(burned.hash).toUpperCase();
      ledger.appendJsonl(path.join(root, "lab", "ledger-log.jsonl"), {
        ts: new Date().toISOString(),
        event: "license_burned",
        action: "license_burn",
        network: "XRPL Testnet",
        network_id: 1,
        account: catalog.W4,
        nftoken_id: nftokenId,
        hash: burnHash,
        result: "tesSUCCESS",
        signed: true,
      });
    }
    printStep(io, 6, "SETTLE", [
      field("action", redeemed.settle.action),
      field("why", redeemed.settle.reason),
      burnHash ? txLines(burnHash, false) : field("tx", "(no burn while uses remain)"),
    ], false);
    rows.push({
      step: "settle",
      what: burnHash ? "W4 burned the license" : "use counter advanced",
      hash: burnHash,
    });
    log(summaryTable(rows, false));
    return 0;
  } finally {
    await started.close();
  }
}

async function run(argv, io) {
  const options = io || {};
  const log = options.log || console.log;
  const error = options.error || console.error;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }
  if (args.help) {
    log(HELP);
    return 0;
  }
  if (!args.dryRun && envIsCi(options.env || process.env)) {
    error("refusing --live under CI");
    return 1;
  }
  try {
    if (args.dryRun) return await runDry(args, options);
    return await runLive(args, options);
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }
}

module.exports = {
  HELP,
  parseArgs,
  parsePace,
  dryHash,
  run,
  runDry,
  runLive,
};

if (require.main === module) {
  run(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
