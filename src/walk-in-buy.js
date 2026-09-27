#!/usr/bin/env node
"use strict";

/**
 * Stranger buy for the Walk-In Window standing storefront.
 * Discovers the current W2 sell offer. Does not require the OfferID in INBOUND.md.
 * Testnet only. Refuses Foundry labeled wallets. Desk does not sign.
 *
 *   npm run buy:walk-in -- --dry-run
 *   npm run buy:walk-in -- --faucet
 *   WALKIN_BUYER_SEED=... npm run buy:walk-in -- --record
 *   npm run buy:walk-in -- --faucet --with-aeth
 */

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const pub = require("./walk-in-public");
const guard = require("./x402-outbound-guard");

const EXIT = {
  OK: 0,
  ERROR: 1,
  FOUNDRY: 2,
  SOLD_OUT: 3,
};

const BUY_COMMAND = "npm run buy:walk-in";
const W0 = "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs";
const AETH_HEX = "4145544800000000000000000000000000000000";
const HASH_RE = /^[0-9A-F]{64}$/;
const ROOT = path.resolve(__dirname, "..");

function envIsCi(env) {
  return guard.envIsCi(env);
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

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    dryRun: false,
    record: false,
    faucet: false,
    withAeth: false,
    offer: "",
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--faucet") out.faucet = true;
    else if (arg === "--with-aeth") out.withAeth = true;
    else if (arg === "--offer") {
      out.offer = args[i + 1] || "";
      i += 1;
      if (!/^[0-9A-Fa-f]{64}$/.test(out.offer)) {
        throw Object.assign(new Error("--offer must be a 64-hex OfferID"), { code: "ARGS" });
      }
      out.offer = out.offer.toUpperCase();
    } else {
      throw Object.assign(new Error(`unknown flag ${arg}`), { code: "ARGS" });
    }
  }
  if (out.dryRun && out.record) {
    throw Object.assign(
      new Error("--record needs a submitted hash; omit it on --dry-run"),
      { code: "ARGS" }
    );
  }
  return out;
}

function isXrpDrops(amount) {
  return typeof amount === "string" && /^[0-9]+$/.test(amount);
}

function amountText(amount) {
  if (typeof amount === "string") return amount;
  if (amount == null) return "null";
  return JSON.stringify(amount);
}

function selectOffer(offers, pinned) {
  const list = Array.isArray(offers) ? offers : [];
  if (pinned) {
    const found = list.find((row) => row.offerId === pinned);
    if (found) return found;
    if (list.length === 0) {
      throw Object.assign(new Error("SOLD OUT"), { code: "SOLD_OUT" });
    }
    throw Object.assign(
      new Error(`pinned offer ${pinned} is not an open W2 sell offer`),
      { code: "PIN" }
    );
  }
  if (list.length === 0) {
    throw Object.assign(new Error("SOLD OUT"), { code: "SOLD_OUT" });
  }
  const xrp = list.filter((row) => isXrpDrops(row.amount));
  return xrp[0] || list[0];
}

function assertWalkInBuyer(address, index) {
  const id = index.get(address);
  if (id) {
    throw Object.assign(
      new Error(
        `refusing Foundry wallet ${id} (${address}). A labeled Foundry wallet does not count as walk-in.`
      ),
      { code: "FOUNDRY" }
    );
  }
}

function readNamedSeed(env, io, name) {
  if (env[name]) return env[name];
  const file = env.AETHER_SECRETS || pub.SECRETS_PATH;
  const exists = io.existsSync || fs.existsSync;
  const readFile = io.readFileSync || fs.readFileSync;
  if (!exists(file)) return "";
  const parsed = loadEnvText(readFile(file, "utf8"));
  return parsed[name] || "";
}

function safeError(err, seeds) {
  let message = err && err.message ? err.message : String(err || "buy failed");
  for (const seed of seeds) {
    if (seed && message.includes(seed)) message = message.split(seed).join("[redacted]");
  }
  if (/sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(message)) {
    return "buy failed (details omitted because they mentioned a seed)";
  }
  return message;
}

function exitFor(err) {
  if (err && err.code === "SOLD_OUT") return EXIT.SOLD_OUT;
  if (err && err.code === "FOUNDRY") return EXIT.FOUNDRY;
  return EXIT.ERROR;
}

function printPlan(log, plan) {
  const lines = [
    "dry-run",
    "signed false",
    "network XRPL Testnet",
    `http ${plan.http}`,
    `ws ${plan.ws}`,
    `seller ${plan.seller}`,
    `offer ${plan.offerId}`,
    `nftoken ${plan.nftokenId}`,
    `amount ${plan.amount}`,
    `flags ${plan.flags}`,
    `destination ${plan.destination || "none"}`,
    plan.faucet ? "buyer not loaded (faucet requested — not called)" : "buyer not loaded",
    "tx NFTokenAcceptOffer",
    plan.withAeth
      ? "aeth planned (TrustSet + path-pay ~50 AETH) — not submitted"
      : "aeth skipped (pass --with-aeth after accept; default is off)",
    "published OfferID is not required",
    `command ${BUY_COMMAND}`,
  ];
  for (const line of lines) log(line);
}

function txView(submitted) {
  const result = (submitted && (submitted.result || submitted)) || {};
  const meta = result.meta || result.metaData || {};
  return {
    hash: typeof result.hash === "string" ? result.hash.toUpperCase() : "",
    result: meta.TransactionResult || "",
    ledger_index: result.ledger_index == null ? null : result.ledger_index,
  };
}

function assertHash(hash, label) {
  if (!HASH_RE.test(hash)) {
    throw new Error(`${label} hash missing`);
  }
  return hash;
}

async function assertAltnet(client) {
  const info = await client.request({ command: "server_info" });
  const id = info && info.result && info.result.info ? info.result.info.network_id : undefined;
  if (id === 0 || id === "0") {
    throw Object.assign(new Error("refusing NetworkID 0"), { code: "MAINNET" });
  }
}

function assertPrepared(prepared) {
  if (prepared && prepared.NetworkID === 0) {
    throw Object.assign(new Error("refusing NetworkID 0"), { code: "MAINNET" });
  }
}

async function openClient(ws, io) {
  if (io.connectClient) return io.connectClient(ws);
  const client = new xrpl.Client(ws);
  await client.connect();
  return client;
}

async function submitSigned(client, wallet, tx) {
  const prepared = await client.autofill(tx);
  assertPrepared(prepared);
  const signed = wallet.sign(prepared);
  const submitted = await client.submitAndWait(signed.tx_blob);
  const view = txView(submitted);
  if (view.result !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} ${view.result || "failed"} ${view.hash}`.trim());
  }
  assertHash(view.hash, tx.TransactionType);
  return view;
}

async function pathPayAeth(client, wallet) {
  const trust = await submitSigned(client, wallet, {
    TransactionType: "TrustSet",
    Account: wallet.classicAddress,
    LimitAmount: {
      currency: AETH_HEX,
      issuer: W0,
      value: "1000000",
    },
  });
  const destinationAmount = { currency: AETH_HEX, issuer: W0, value: "50" };
  const found = await client.request({
    command: "ripple_path_find",
    source_account: wallet.classicAddress,
    destination_account: wallet.classicAddress,
    destination_amount: destinationAmount,
    ledger_index: "validated",
  });
  const alternatives = (found.result && found.result.alternatives) || [];
  if (alternatives.length === 0) throw new Error("No path found for 50 AETH");
  const best = alternatives[0];
  const paths = best.paths_computed || best.paths || [];
  let sendMax;
  if (typeof best.source_amount === "string" && /^[0-9]+$/.test(best.source_amount)) {
    sendMax = String(BigInt(best.source_amount) * 3n);
  } else {
    sendMax = xrpl.xrpToDrops("5");
  }
  const payment = await submitSigned(client, wallet, {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: wallet.classicAddress,
    Amount: destinationAmount,
    SendMax: sendMax,
    Paths: paths,
  });
  return { trustHash: trust.hash, payHash: payment.hash, sendMax };
}

function appendText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = "";
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.length && !cur.endsWith("\n")) prefix = "\n";
  }
  fs.appendFileSync(file, prefix + text);
}

function hashAlreadyLogged(file, hash) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.action === "walk_in_buy" && String(row.hash || "").toUpperCase() === hash) {
        return true;
      }
    } catch {
      /* skip */
    }
  }
  return false;
}

function recordBuy(root, row) {
  assertHash(row.hash, "accept");
  const ledger = path.join(root, "lab", "ledger-log.jsonl");
  const results = path.join(root, "machines", "walk-in-window", "RESULTS.md");
  if (hashAlreadyLogged(ledger, row.hash)) return { recorded: false, duplicate: true };
  appendText(ledger, `${JSON.stringify(row)}\n`);
  const aethCell =
    row.aeth === true
      ? `TrustSet \`${row.trustset_hash}\` / Payment \`${row.payment_hash}\``
      : row.aeth === "failed"
        ? "requested; path-pay failed after the accept"
        : "not requested";
  appendText(
    results,
    `
## Walk-in buy ${row.ts}

Stranger accept via \`${BUY_COMMAND}\`. Buyer is not a Foundry labeled wallet.

| Field | Value |
|-------|-------|
| Buyer | \`${row.buyer}\` |
| OfferID | \`${row.offer_id}\` |
| NFTokenID | \`${row.nftoken_id}\` |
| Amount | \`${row.amount}\` |
| Accept hash | \`${row.hash}\` |
| AETH | ${aethCell} |
`
  );
  return { recorded: true, duplicate: false };
}

async function resolveBuyer({ args, env, io, ws, index, seeds }) {
  const walkInSeed = args.faucet ? "" : readNamedSeed(env, io, "WALKIN_BUYER_SEED");
  const buyerSeed = args.faucet || walkInSeed ? "" : readNamedSeed(env, io, "XRPL_BUYER_SEED");
  if (walkInSeed) seeds.push(walkInSeed);
  if (buyerSeed) seeds.push(buyerSeed);
  const fromSeed = io.walletFromSeed || ((seed) => xrpl.Wallet.fromSeed(seed));

  if (walkInSeed || buyerSeed) {
    const source = walkInSeed ? "WALKIN_BUYER_SEED" : "XRPL_BUYER_SEED";
    const seed = walkInSeed || buyerSeed;
    let wallet;
    try {
      wallet = fromSeed(seed);
    } catch {
      throw new Error("buyer seed is not usable");
    }
    const address = wallet.classicAddress || wallet.address;
    wallet.classicAddress = address;
    assertWalkInBuyer(address, index);
    return { wallet, client: null, source };
  }

  const client = await openClient(ws, io);
  await assertAltnet(client);
  const funded = io.fundWallet ? await io.fundWallet(client) : await client.fundWallet();
  const wallet = funded.wallet;
  const address = wallet.classicAddress || wallet.address;
  wallet.classicAddress = address;
  if (wallet.seed) seeds.push(wallet.seed);
  assertWalkInBuyer(address, index);
  return { wallet, client, source: "faucet", balance: funded.balance };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const log = io.log || console.log;
  const error = io.error || console.error;
  const poll = io.pollSellOffers || pub.pollSellOffers;
  const seeds = [];
  let client = null;
  try {
    const args = parseArgs(argv);
    const http = pub.assertTestnetUrl(env.XRPL_HTTP || pub.XRPL_HTTP);
    const ws = pub.assertTestnetUrl(env.XRPL_WS_URL || env.XRPL_WS || pub.XRPL_WS);
    const polled = await poll({ rpc: http, fetchImpl: io.fetchImpl });
    if (!polled.ok) throw new Error(polled.error || "could not read W2 sell offers");
    const offer = selectOffer(polled.offers, args.offer);
    if (args.dryRun) {
      printPlan(log, {
        http,
        ws,
        seller: pub.W2,
        offerId: offer.offerId,
        nftokenId: offer.nftokenId,
        amount: amountText(offer.amount),
        flags: offer.flags,
        destination: offer.destination,
        faucet: args.faucet,
        withAeth: args.withAeth,
      });
      return EXIT.OK;
    }
    if (envIsCi(env)) throw new Error("refusing to sign under CI");

    const index = (io.foundryIndex || guard.foundryIndex)(io.walletsText);
    const buyer = await resolveBuyer({ args, env, io, ws, index, seeds });
    client = buyer.client;
    if (offer.destination && offer.destination !== buyer.wallet.classicAddress) {
      throw new Error(
        `sell offer Destination is ${offer.destination}; this buyer cannot accept it`
      );
    }
    if (!client) {
      client = await openClient(ws, io);
      await assertAltnet(client);
    }
    log("buyer", buyer.wallet.classicAddress);
    log("source", buyer.source);
    if (buyer.balance != null) log("faucet_balance_xrp", buyer.balance);
    log("offer", offer.offerId);
    log("nftoken", offer.nftokenId);
    log("amount", amountText(offer.amount));

    const accepted = await submitSigned(client, buyer.wallet, {
      TransactionType: "NFTokenAcceptOffer",
      Account: buyer.wallet.classicAddress,
      NFTokenSellOffer: offer.offerId,
    });
    log("accepted", accepted.hash);

    let aeth = null;
    let aethError = null;
    if (args.withAeth) {
      try {
        aeth = await pathPayAeth(client, buyer.wallet);
        log("aeth_trustset", aeth.trustHash);
        log("aeth_payment", aeth.payHash);
      } catch (err) {
        aethError = safeError(err, seeds);
        log("aeth_failed", aethError);
      }
    } else {
      log("aeth skipped");
    }

    if (args.record) {
      const when = (io.now ? io.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
      const row = {
        ts: when,
        event: "walk_in_buy",
        action: "walk_in_buy",
        network: "XRPL Testnet",
        buyer: buyer.wallet.classicAddress,
        seller: pub.W2,
        offer_id: offer.offerId,
        nftoken_id: offer.nftokenId,
        amount: amountText(offer.amount),
        hash: accepted.hash,
        result: "tesSUCCESS",
        tx_type: "NFTokenAcceptOffer",
        ledger_index: accepted.ledger_index,
        aeth: aeth ? true : args.withAeth ? "failed" : false,
        signed: true,
      };
      if (aeth) {
        row.trustset_hash = aeth.trustHash;
        row.payment_hash = aeth.payHash;
      }
      const wrote = recordBuy(io.root || ROOT, row);
      log(wrote.duplicate ? "record duplicate" : "recorded");
    }
    if (aethError) {
      throw new Error(`accepted ${accepted.hash}; AETH path-pay failed: ${aethError}`);
    }
    return EXIT.OK;
  } catch (err) {
    const code = exitFor(err);
    const message =
      code === EXIT.SOLD_OUT
        ? "SOLD OUT\nno W2 sell offer (Flags bit 1) on the validated ledger"
        : safeError(err, seeds);
    error(message);
    return code;
  } finally {
    if (client && client.disconnect) {
      try {
        await client.disconnect();
      } catch {
        /* already closed */
      }
    }
  }
}

module.exports = {
  EXIT,
  BUY_COMMAND,
  W0,
  AETH_HEX,
  parseArgs,
  selectOffer,
  assertWalkInBuyer,
  recordBuy,
  run,
};

if (require.main === module) {
  run(process.argv).then((code) => {
    process.exit(code || 0);
  });
}
