#!/usr/bin/env node
"use strict";

/**
 * Batch Heartbeat. One all-or-nothing Batch on XRPL Testnet (network id 1).
 * Dry-run is the default: autofill and print. It does not submit and does not
 * read a seed. --live posts to the loopback signer at 127.0.0.1:8787.
 *
 * W2 prepares a fresh taxon-20261012 sell offer. W1 signs the Batch.
 * Inner transactions, in order: NFTokenAcceptOffer, AMMDeposit, DIDSet.
 * W0 does not sign. The signer never loads the treasury seed.
 *
 *   npm run batch:heartbeat
 *   npm run batch:heartbeat -- --live
 */

const anchors = require("../director/anchors");
const snapshot = require("../director/snapshot");
const grants = require("../grants/policy");
const hosts = require("../xrpl-hosts");
const policy = require("../runtime/policy");

const HELP = `Usage: node src/batch/heartbeat.js [--dry-run] [--live] [--offer-drops N] [--deposit-drops N]

Dry-run is the default. It autofills one tfAllOrNothing Batch and prints it.
It does not submit and does not read a seed.
--live requires the signer on 127.0.0.1:8787, FOUNDRY_AGENT_SIGN=yes, and FOUNDRY_SIGNER_TOKEN.
--live refuses CI and GITHUB_ACTIONS. Network id 1 only.

W2 (${anchors.WALLETS.W2.address}) mints and lists. W1 (${anchors.WALLETS.W1.address}) signs the Batch.
DIDSet updates W1, not W0. Default spend is ${policy.BATCH_HEARTBEAT.offer_drops} drops plus ${policy.BATCH_HEARTBEAT.deposit_drops} drops, plus the Batch fee.`;

const W0_DECISION = "DIDSet is on W1. W0 already publishes the charter DID. A W0 inner would need a BatchSigner, and producing it would load the treasury seed or the board seeds into the signer. This signer does not do that. The heartbeat stamp is the charter URI plus a timestamp on the market wallet.";
const RESERVE_NOTE = "First live run also locks about 0.4 XRP of owner reserve on W1 (DID object and LP trust line) if those objects are new. The W2 sell-offer reserve returns when the accept succeeds. Later runs spend the offer plus the deposit plus the fee.";

function coded(message, code) {
  return policy.coded(message, code);
}

function stampOf(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(date.getTime())) throw coded("batch heartbeat timestamp drifted", "TX");
  return date.toISOString();
}

function hexUtf8(text) {
  return Buffer.from(String(text), "utf8").toString("hex").toUpperCase();
}

function didUri(stamp) {
  return `${policy.BATCH_HEARTBEAT.charter}#heartbeat=${stamp}`;
}

function didData(stamp) {
  return JSON.stringify({ machine: "batch-heartbeat", heartbeat: stamp });
}

function memos() {
  return [
    grants.memo("purpose", policy.BATCH_HEARTBEAT.purpose),
    grants.memo("experiment", policy.BATCH_HEARTBEAT.experiment),
  ];
}

function nftokenId(opts) {
  const xrpl = require("xrpl");
  const options = opts || {};
  const flags = options.flags == null ? policy.BATCH_HEARTBEAT.mint_flags : options.flags;
  const fee = options.fee == null ? 0 : options.fee;
  const sequence = options.sequence == null ? 1 : options.sequence;
  const taxon = options.taxon == null ? policy.BATCH_HEARTBEAT.taxon : options.taxon;
  const issuer = options.issuer || anchors.WALLETS.W2.address;
  const issuerHex = Buffer.from(xrpl.decodeAccountID(issuer)).toString("hex");
  if (issuerHex.length !== 40) throw coded("batch heartbeat issuer drifted", "TX");
  const scramble = (384160001n * BigInt(sequence) + 2459n) % 4294967296n;
  const scrambled = (BigInt(taxon) ^ scramble) & 0xffffffffn;
  return (
    Number(flags).toString(16).padStart(4, "0")
    + Number(fee).toString(16).padStart(4, "0")
    + issuerHex
    + scrambled.toString(16).padStart(8, "0")
    + Number(sequence).toString(16).padStart(8, "0")
  ).toUpperCase();
}

function placeholderOfferId() {
  return "B".repeat(64);
}

function buildMint() {
  return {
    TransactionType: "NFTokenMint",
    Account: anchors.WALLETS.W2.address,
    NFTokenTaxon: policy.BATCH_HEARTBEAT.taxon,
    Flags: policy.BATCH_HEARTBEAT.mint_flags,
    URI: hexUtf8(policy.BATCH_HEARTBEAT.pack_uri),
    Memos: memos(),
  };
}

function buildOffer(opts) {
  const options = opts || {};
  return {
    TransactionType: "NFTokenCreateOffer",
    Account: anchors.WALLETS.W2.address,
    NFTokenID: options.nftokenId,
    Amount: options.drops || policy.BATCH_HEARTBEAT.offer_drops,
    Flags: policy.BATCH_HEARTBEAT.tf_sell,
    Destination: anchors.WALLETS.W1.address,
    Memos: memos(),
  };
}

function buildBatch(opts) {
  const options = opts || {};
  const stamp = stampOf(options.now);
  const account = anchors.WALLETS.W1.address;
  const offerId = String(options.offerId || "").toUpperCase();
  const deposit = options.depositDrops || policy.BATCH_HEARTBEAT.deposit_drops;
  const inner = policy.BATCH_HEARTBEAT.tf_inner;
  const accept = {
    TransactionType: "NFTokenAcceptOffer",
    Account: account,
    Flags: inner,
    NFTokenSellOffer: offerId,
  };
  const depositTx = {
    TransactionType: "AMMDeposit",
    Account: account,
    Flags: inner | policy.BATCH_HEARTBEAT.tf_single_asset,
    Asset: { currency: "XRP" },
    Asset2: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address },
    Amount: deposit,
  };
  const did = {
    TransactionType: "DIDSet",
    Account: account,
    Flags: inner,
    URI: hexUtf8(didUri(stamp)),
    Data: hexUtf8(didData(stamp)),
  };
  return {
    TransactionType: "Batch",
    Account: account,
    Flags: policy.BATCH_HEARTBEAT.tf_all_or_nothing,
    RawTransactions: [accept, depositTx, did].map((tx) => ({ RawTransaction: tx })),
    Memos: memos(),
  };
}

function fillBatch(tx, opts) {
  const options = opts || {};
  const sequence = Number(options.sequence);
  if (!Number.isInteger(sequence) || sequence <= 0) throw coded("batch heartbeat sequence drifted", "TX");
  const copy = JSON.parse(JSON.stringify(tx));
  copy.Sequence = sequence;
  copy.Fee = options.fee || "40";
  if (options.lastLedger) copy.LastLedgerSequence = options.lastLedger;
  copy.RawTransactions.forEach((row, index) => {
    const inner = row.RawTransaction;
    inner.Sequence = sequence + 1 + index;
    inner.Fee = "0";
    inner.SigningPubKey = "";
    delete inner.TxnSignature;
    delete inner.Signers;
  });
  return copy;
}

function offerUsable(offer, nftokenIdValue) {
  const amount = offer.amount != null ? offer.amount : offer.Amount;
  const flags = offer.flags != null ? offer.flags : offer.Flags;
  const owner = offer.owner || offer.Owner;
  const destination = offer.destination || offer.Destination;
  const index = offer.nft_offer_index || offer.index;
  if (!sellFlag(flags) || owner !== anchors.WALLETS.W2.address) return null;
  if (destination !== anchors.WALLETS.W1.address) return null;
  if (!anchors.HASH_RE.test(String(index || "").toUpperCase())) return null;
  let drops;
  try {
    drops = grants.dropsOf(amount);
  } catch {
    return null;
  }
  if (drops <= 0n || drops > grants.dropsOf(policy.BATCH_HEARTBEAT.max_offer_drops)) return null;
  const id = String(index).toUpperCase();
  return {
    action: "ready",
    nftokenId: nftokenIdValue,
    offerId: id,
    node: {
      LedgerEntryType: "NFTokenOffer",
      Flags: Number(flags),
      Owner: owner,
      Destination: destination,
      Amount: drops.toString(),
      NFTokenID: nftokenIdValue,
      index: id,
    },
  };
}

function sellFlag(flags) {
  return (Number(flags) & policy.BATCH_HEARTBEAT.tf_sell) === policy.BATCH_HEARTBEAT.tf_sell;
}

function choosePrepare(nfts, offersByNft) {
  const ids = [];
  const xrpl = require("xrpl");
  for (const nft of nfts || []) {
    if (!nft || !nft.NFTokenID) continue;
    let parsed;
    try {
      parsed = xrpl.parseNFTokenID(String(nft.NFTokenID).toUpperCase());
    } catch {
      continue;
    }
    if (Number(parsed.Taxon) !== policy.BATCH_HEARTBEAT.taxon) continue;
    if (parsed.Issuer !== anchors.WALLETS.W2.address) continue;
    ids.push(String(nft.NFTokenID).toUpperCase());
  }
  if (ids.length === 0) return { action: "mint" };
  let bare = null;
  let blocked = false;
  for (const id of ids) {
    const offers = (offersByNft && offersByNft[id]) || [];
    const ready = offers.map((offer) => offerUsable(offer, id)).find(Boolean);
    if (ready) return ready;
    if (offers.length === 0) {
      if (!bare) bare = id;
      continue;
    }
    blocked = true;
  }
  if (bare) return { action: "offer", nftokenId: bare };
  if (blocked) throw coded("heartbeat NFT already has a sell offer outside the W1 cap", "OFFER");
  return { action: "mint" };
}

function probeFromFeature(featureResult, extra) {
  const batch = snapshot.readBatch(featureResult);
  const options = extra || {};
  return {
    atomic_enabled: batch.atomic_enabled === true,
    ticket_batch_enabled: batch.ticket_batch_enabled === true,
    amendments: batch.amendments,
    network_id: options.networkId == null ? anchors.XRPL_NETWORK_ID : Number(options.networkId),
  };
}

function withBatchProbe(state, probe) {
  const prior = state && typeof state === "object" ? state : {};
  const watched = Object.assign({}, prior.watched);
  watched.batch = {
    atomic_enabled: probe.atomic_enabled === true,
    ticket_batch_enabled: probe.ticket_batch_enabled === true,
    amendments: probe.amendments,
  };
  return Object.assign({}, prior, { watched });
}

function assertProbe(probe) {
  if (!probe || probe.network_id != null && Number(probe.network_id) !== anchors.XRPL_NETWORK_ID) {
    throw coded(`refusing network id ${probe && probe.network_id}`, "MAINNET");
  }
  if (!policy.batchGateOpen({ watched: { batch: probe } })) {
    throw coded("refusing Batch while atomic_enabled is false", "BATCH");
  }
}

function sellOfferId(tx) {
  const inners = tx && Array.isArray(tx.RawTransactions) ? tx.RawTransactions : null;
  const accept = inners && inners[0] && inners[0].RawTransaction;
  const id = accept && String(accept.NFTokenSellOffer || "").toUpperCase();
  if (!anchors.HASH_RE.test(id || "")) throw coded("batch heartbeat requires NFTokenSellOffer", "TX");
  return id;
}

async function postRpc(url, method, params, fetchImpl) {
  policy.assertSigningRpc(url);
  const fetchFn = fetchImpl || globalThis.fetch;
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params: [params || {}] }),
    signal: AbortSignal.timeout(20000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw coded(`RPC ${method} failed`, "RPC");
  }
  const result = body && body.result;
  if (!response.ok || !result || result.error || result.status === "error") {
    throw coded(`RPC ${method} failed`, "RPC");
  }
  return result;
}

async function probeFeatures(env, fetchImpl) {
  const urls = hosts.candidates(hosts.resolveHttp(env));
  let last;
  for (const url of urls) {
    try {
      const feature = await postRpc(url, "feature", {}, fetchImpl);
      const info = await postRpc(url, "server_info", {}, fetchImpl);
      const networkId = info.info && info.info.network_id;
      if (Number(networkId) !== anchors.XRPL_NETWORK_ID) {
        throw coded(`refusing network id ${networkId}`, "MAINNET");
      }
      const probe = probeFromFeature(feature, { networkId: anchors.XRPL_NETWORK_ID });
      probe.rpc = url;
      probe.build_version = info.info && info.info.build_version;
      probe.server_state = info.info && info.info.server_state;
      const ledger = info.info && info.info.validated_ledger;
      probe.ledger_index = ledger && ledger.seq;
      return probe;
    } catch (error) {
      last = error;
      if (!hosts.isTransportFailure(error)) throw error;
    }
  }
  throw last;
}

async function accountNfts(url, account, fetchImpl) {
  const nfts = [];
  let marker;
  for (let page = 0; page < 2; page += 1) {
    const params = { account, ledger_index: "validated", limit: 200 };
    if (marker !== undefined) params.marker = marker;
    const result = await postRpc(url, "account_nfts", params, fetchImpl);
    if (result.validated === false) throw coded("account_nfts was not a validated ledger", "RPC");
    nfts.push(...(result.account_nfts || []));
    if (result.marker == null) return nfts;
    marker = result.marker;
  }
  return nfts;
}

async function loadPrepare(env, fetchImpl) {
  const urls = hosts.candidates(hosts.resolveHttp(env));
  let last;
  for (const url of urls) {
    try {
      const nfts = await accountNfts(url, anchors.WALLETS.W2.address, fetchImpl);
      const offersByNft = {};
      for (const nft of nfts) {
        let parsed;
        try {
          parsed = require("xrpl").parseNFTokenID(nft.NFTokenID);
        } catch {
          continue;
        }
        if (Number(parsed.Taxon) !== policy.BATCH_HEARTBEAT.taxon) continue;
        if (parsed.Issuer !== anchors.WALLETS.W2.address) continue;
        const page = await postRpc(url, "nft_sell_offers", {
          nft_id: nft.NFTokenID,
          ledger_index: "validated",
        }, fetchImpl);
        if (page.validated === false) throw coded("nft_sell_offers was not a validated ledger", "RPC");
        offersByNft[String(nft.NFTokenID).toUpperCase()] = page.offers || [];
      }
      return { url, choice: choosePrepare(nfts, offersByNft) };
    } catch (error) {
      last = error;
      if (!hosts.isTransportFailure(error)) throw error;
    }
  }
  throw last;
}

async function readSellOffer(url, offerId, fetchImpl) {
  const id = String(offerId || "").toUpperCase();
  if (!anchors.HASH_RE.test(id)) throw coded("batch heartbeat requires NFTokenSellOffer", "TX");
  const result = await postRpc(url, "ledger_entry", { index: id, ledger_index: "validated" }, fetchImpl);
  if (result.validated !== true) throw coded("sell offer was not a validated ledger", "RPC");
  const node = result.node;
  if (!node || node.LedgerEntryType !== "NFTokenOffer") {
    throw coded("sell offer is not an NFTokenOffer", "OFFER");
  }
  return Object.assign({}, node, { index: id });
}

async function autofillOnLedger(tx, env, deps) {
  const options = deps || {};
  const ws = hosts.resolveWs(env);
  policy.assertSigningRpc(ws);
  const xrpl = require("xrpl");
  const client = options.clientFactory ? options.clientFactory(ws) : new xrpl.Client(ws);
  try {
    await client.connect();
    const info = await client.request({ command: "server_info" });
    const networkId = info.result && info.result.info && info.result.info.network_id;
    if (Number(networkId) !== anchors.XRPL_NETWORK_ID) {
      throw coded(`refusing network id ${networkId}`, "MAINNET");
    }
    const filled = await client.autofill(tx);
    if (Number(filled.NetworkID) === 0) throw coded("refusing NetworkID 0", "MAINNET");
    return filled;
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

function historyOf(root, options) {
  if (options && options.history) return options.history;
  return policy.readJsonl(require("path").join(root || anchors.repoRoot(), "lab", "ledger-log.jsonl"), options && options.io);
}

function syntheticOffer(nftId, offerId, drops) {
  return {
    LedgerEntryType: "NFTokenOffer",
    Flags: policy.BATCH_HEARTBEAT.tf_sell,
    Owner: anchors.WALLETS.W2.address,
    Destination: anchors.WALLETS.W1.address,
    Amount: drops,
    NFTokenID: nftId,
    index: offerId,
  };
}

function publicBatch(probe, filled, extra) {
  const options = extra || {};
  const amendments = (probe.amendments || []).map((row) => ({
    name: row.name,
    hash: row.hash,
    enabled: row.enabled === true,
    supported: row.supported !== false,
  }));
  const body = {
    mode: options.mode,
    signed: false,
    submitted: options.submitted === true,
    key_loaded: false,
    signer: options.signer,
    network_id: anchors.XRPL_NETWORK_ID,
    rpc: probe.rpc || null,
    build_version: probe.build_version || null,
    ledger_index: probe.ledger_index == null ? null : probe.ledger_index,
    atomic_enabled: probe.atomic_enabled === true,
    amendments,
    wallets: {
      prepare: "W2",
      batch: "W1",
      did: "W1",
      treasury: "W0",
      w0_signs: false,
    },
    w0_decision: W0_DECISION,
    expected_spend_drops: options.expectedSpend,
    fee_drops: filled && filled.Fee ? String(filled.Fee) : null,
    reserve_note: RESERVE_NOTE,
    placeholder_offer: options.placeholder === true,
    offer_id: options.offerId,
    nftoken_id: options.nftokenId || null,
    prepare: options.prepare || null,
    tx: filled,
    note: options.note,
  };
  if (options.verified) body.verified = options.verified;
  policy.assertNoSeedFields(body);
  const text = JSON.stringify(body, null, 2);
  policy.assertPrintSafe(text);
  return body;
}

async function dryRun(opts) {
  const options = opts || {};
  const env = options.env || {};
  const now = options.now || new Date();
  const depositDrops = options.depositDrops || policy.BATCH_HEARTBEAT.deposit_drops;
  const offerDrops = options.offerDrops || policy.BATCH_HEARTBEAT.offer_drops;
  const probe = options.probe || await probeFeatures(env, options.fetchImpl);
  assertProbe(probe);
  const loaded = options.found === undefined ? await loadPrepare(env, options.fetchImpl) : { choice: options.found };
  const choice = loaded.choice || { action: "mint" };
  const placeholder = choice.action !== "ready";
  const nftId = choice.action === "mint" ? nftokenId() : choice.nftokenId;
  const offerId = choice.action === "ready" ? choice.offerId : placeholderOfferId();
  const sellOffer = choice.action === "ready"
    ? choice.node
    : syntheticOffer(nftId, offerId, offerDrops);
  const tx = buildBatch({ offerId, depositDrops, now });
  const filled = options.autofill ? await options.autofill(tx) : await autofillOnLedger(tx, env, options);
  const state = withBatchProbe({}, probe);
  policy.assertBatchHeartbeat(filled, {
    state,
    sellOffer,
    offerAmount: sellOffer.Amount,
    networkId: anchors.XRPL_NETWORK_ID,
    history: historyOf(options.root, options),
    now,
  });
  const spend = (grants.dropsOf(depositDrops) + grants.dropsOf(sellOffer.Amount)).toString();
  return publicBatch(probe, filled, {
    mode: "dry-run",
    signer: "not called",
    expectedSpend: spend,
    placeholder,
    offerId,
    nftokenId: nftId,
    prepare: placeholder ? { mint: buildMint(), offer: buildOffer({ nftokenId: nftId, drops: offerDrops }) } : null,
    note: placeholder
      ? "No heartbeat sell offer is on the ledger. --live mints a taxon 20261012 NFT from W2 and lists it to W1 before this Batch. Do not submit this placeholder."
      : "Sell offer is already on the ledger. --live submits this Batch through the signer.",
  });
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

async function signerCall(env, pathname, body, fetchImpl) {
  const token = String((env || {}).FOUNDRY_SIGNER_TOKEN || "");
  if (token.length < 16) throw coded("FOUNDRY_SIGNER_TOKEN is required for --live", "TOKEN");
  const fetchFn = fetchImpl || globalThis.fetch;
  const response = await fetchFn(`${signerBase(env)}${pathname}`, {
    method: pathname === "/health" ? "GET" : "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: pathname === "/health" ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(90000),
  });
  const text = await response.text();
  if (text.includes(token)) throw coded("refusing to echo the signer token", "TOKEN");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "response was not JSON" };
  }
  policy.assertNoSeedFields(parsed);
  if (!response.ok) throw coded(parsed.error || `HTTP ${response.status}`, parsed.code || "RPC");
  return parsed;
}

async function validatedTx(url, hash, fetchImpl) {
  const result = await postRpc(url, "tx", { transaction: hash, binary: false }, fetchImpl);
  const meta = result.meta || result.metaData || {};
  if (meta.TransactionResult !== "tesSUCCESS") {
    throw coded(`result ${meta.TransactionResult || "missing"}`, "SUBMIT");
  }
  return result;
}

function offerIndexFromMeta(meta) {
  const nodes = (meta && meta.AffectedNodes) || [];
  for (const node of nodes) {
    const created = node && node.CreatedNode;
    if (created && created.LedgerEntryType === "NFTokenOffer" && created.LedgerIndex) {
      return String(created.LedgerIndex).toUpperCase();
    }
  }
  return null;
}

async function ensureOffer(env, choice, offerDrops, fetchImpl) {
  const http = hosts.resolveHttp(env);
  let nftokenIdValue = choice.nftokenId;
  if (choice.action === "mint") {
    const minted = await signerCall(env, "/sign", {
      wallet: "W2",
      intent: "batch_heartbeat_prepare",
      tx: buildMint(),
    }, fetchImpl);
    const done = await validatedTx(http, minted.hash, fetchImpl);
    const meta = done.meta || done.metaData;
    nftokenIdValue = require("xrpl").getNFTokenID(meta);
    if (!nftokenIdValue) throw coded("NFTokenMint succeeded without an NFTokenID", "SUBMIT");
    nftokenIdValue = String(nftokenIdValue).toUpperCase();
  }
  if (choice.action === "ready") {
    const node = await readSellOffer(http, choice.offerId, fetchImpl);
    return { nftokenId: choice.nftokenId, offerId: choice.offerId, node };
  }
  const listed = await signerCall(env, "/sign", {
    wallet: "W2",
    intent: "batch_heartbeat_prepare",
    tx: buildOffer({ nftokenId: nftokenIdValue, drops: offerDrops }),
  }, fetchImpl);
  const created = await validatedTx(http, listed.hash, fetchImpl);
  const offerId = offerIndexFromMeta(created.meta || created.metaData);
  if (!offerId) throw coded("NFTokenCreateOffer succeeded without an offer index", "SUBMIT");
  const node = await readSellOffer(http, offerId, fetchImpl);
  return { nftokenId: nftokenIdValue, offerId, node };
}

async function verifyBatch(url, hash, fetchImpl) {
  const outer = await validatedTx(url, hash, fetchImpl);
  const body = outer.tx_json || outer;
  const raw = body.RawTransactions || [];
  const xrpl = require("xrpl");
  const inners = [];
  for (const row of raw) {
    const inner = row && row.RawTransaction;
    if (!inner) throw coded("batch heartbeat inner missing", "SUBMIT");
    const innerHash = xrpl.hashes.hashSignedTx(inner).toUpperCase();
    let found;
    try {
      found = await validatedTx(url, innerHash, fetchImpl);
    } catch (error) {
      if (error && error.code === "SUBMIT") {
        throw coded(`inner ${inner.TransactionType} ${error.message}`, "SUBMIT");
      }
      throw coded(`inner ${inner.TransactionType} was not on the ledger`, "SUBMIT");
    }
    const meta = found.meta || found.metaData || {};
    inners.push({
      hash: innerHash,
      transaction_type: inner.TransactionType,
      result: meta.TransactionResult,
      ledger_index: found.ledger_index == null ? null : found.ledger_index,
    });
  }
  if (inners.length !== 3) throw coded("batch heartbeat did not yield 3 inner results", "SUBMIT");
  return {
    hash: String(outer.hash || hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: outer.ledger_index == null ? null : outer.ledger_index,
    inners,
  };
}

async function live(opts) {
  const options = opts || {};
  const env = options.env || {};
  policy.assertNotCi(env);
  const now = options.now || new Date();
  const depositDrops = options.depositDrops || policy.BATCH_HEARTBEAT.deposit_drops;
  const offerDrops = options.offerDrops || policy.BATCH_HEARTBEAT.offer_drops;
  const probe = options.probe || await probeFeatures(env, options.fetchImpl);
  assertProbe(probe);
  const health = await signerCall(env, "/health", null, options.fetchImpl);
  if (Number(health.network_id) !== anchors.XRPL_NETWORK_ID) {
    throw coded(`refusing network id ${health.network_id}`, "MAINNET");
  }
  const ready = health.wallets_ready || [];
  if (!ready.includes("W1") || !ready.includes("W2")) {
    throw coded("signer is missing W1 or W2", "NO_SEED");
  }
  const loaded = options.found === undefined
    ? await loadPrepare(env, options.fetchImpl)
    : { choice: options.found || { action: "mint" } };
  const prepared = options.ensureOffer
    ? await options.ensureOffer(loaded.choice)
    : await ensureOffer(env, loaded.choice, offerDrops, options.fetchImpl);
  const tx = buildBatch({
    offerId: prepared.offerId,
    depositDrops,
    now,
  });
  const signed = options.signBatch
    ? await options.signBatch(tx)
    : await signerCall(env, "/sign", { wallet: "W1", intent: "batch_heartbeat", tx }, options.fetchImpl);
  if (!signed || !signed.hash) throw coded("signer did not return a hash", "SUBMIT");
  const verified = options.verifyBatch
    ? await options.verifyBatch(signed.hash)
    : await verifyBatch(hosts.resolveHttp(env), signed.hash, options.fetchImpl);
  const spend = (grants.dropsOf(depositDrops) + grants.dropsOf(prepared.node.Amount)).toString();
  const body = publicBatch(probe, tx, {
    mode: "live",
    signer: signerBase(env),
    submitted: true,
    expectedSpend: spend,
    placeholder: false,
    offerId: prepared.offerId,
    nftokenId: prepared.nftokenId,
    note: "Outer and every inner transaction returned tesSUCCESS.",
    verified,
  });
  body.signed = true;
  body.hash = verified.hash;
  return body;
}

function parseArgs(argv) {
  const out = {
    live: false,
    help: false,
    offerDrops: policy.BATCH_HEARTBEAT.offer_drops,
    depositDrops: policy.BATCH_HEARTBEAT.deposit_drops,
  };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw coded("pass only one of --dry-run or --live", "ARGS");
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--live") out.live = true;
    else if (arg === "--dry-run") out.live = false;
    else if (arg === "--offer-drops" || arg === "--deposit-drops") {
      const value = args[i + 1];
      if (!value || !/^[0-9]+$/.test(value)) throw coded(`${arg} requires drops`, "DROPS");
      i += 1;
      if (arg === "--offer-drops") out.offerDrops = value;
      else out.depositDrops = value;
    } else {
      throw coded(`unknown arg ${arg}`, "ARGS");
    }
  }
  const offer = grants.dropsOf(out.offerDrops);
  const deposit = grants.dropsOf(out.depositDrops);
  if (offer <= 0n || offer > grants.dropsOf(policy.BATCH_HEARTBEAT.max_offer_drops)) {
    throw coded("batch heartbeat offer is above the cap", "CAP");
  }
  if (deposit <= 0n || deposit > grants.dropsOf(policy.BATCH_HEARTBEAT.max_deposit_drops)) {
    throw coded("batch heartbeat deposit is above the cap", "CAP");
  }
  return out;
}

async function main(argv, deps) {
  const options = deps || {};
  const args = parseArgs(Array.isArray(argv) ? argv : []);
  const write = options.stdout || ((text) => console.log(text));
  if (args.help) {
    write(HELP);
    return 0;
  }
  const env = options.env || process.env;
  const shared = {
    env,
    now: options.now,
    offerDrops: args.offerDrops,
    depositDrops: args.depositDrops,
    fetchImpl: options.fetchImpl,
    probe: options.probe,
    found: options.found,
    autofill: options.autofill,
    history: options.history,
    root: options.root,
    io: options.io,
    ensureOffer: options.ensureOffer,
    signBatch: options.signBatch,
    verifyBatch: options.verifyBatch,
    clientFactory: options.clientFactory,
  };
  const body = args.live ? await live(shared) : await dryRun(shared);
  write(JSON.stringify(body, null, 2));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      const token = process.env.FOUNDRY_SIGNER_TOKEN;
      console.error(`${code}: ${policy.redact(error && error.message, [token])}`);
      process.exit(1);
    });
}

module.exports = {
  HELP,
  W0_DECISION,
  RESERVE_NOTE,
  nftokenId,
  placeholderOfferId,
  buildMint,
  buildOffer,
  buildBatch,
  fillBatch,
  choosePrepare,
  probeFromFeature,
  withBatchProbe,
  assertProbe,
  sellOfferId,
  readSellOffer,
  verifyBatch,
  dryRun,
  live,
  parseArgs,
  main,
  didUri,
  didData,
};
