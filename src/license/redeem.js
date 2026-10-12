"use strict";

/**
 * Redeem handler. Verifies a one-time challenge, the on-ledger holder,
 * remaining uses, and expiry. Then delivers the job and decides settlement.
 * Does not sign and does not submit.
 */

const path = require("path");
const catalog = require("./catalog");
const challenge = require("./challenge");
const deliverJob = require("./deliver");
const settle = require("./settle");
const ledger = require("./ledger");

function coded(message, code) {
  return catalog.coded(message, code);
}

function ledgerFile(root) {
  return path.join(root, "lab", "ledger-log.jsonl");
}

function nonceFile(root) {
  return path.join(root, "lab", "licenses", "nonces.jsonl");
}

function usesConsumed(root, nftokenId) {
  const id = String(nftokenId || "").toUpperCase();
  return ledger.readJsonl(ledgerFile(root)).filter((row) => {
    return row && row.event === "license_redeemed" && String(row.nftoken_id || "").toUpperCase() === id && row.ok !== false;
  }).length;
}

function nonceSeen(root, nonce, memory) {
  if (memory && memory.has(nonce)) return true;
  return ledger.readJsonl(nonceFile(root)).some((row) => row && row.nonce === nonce);
}

function rememberNonce(root, nonce, memory) {
  if (memory) memory.add(nonce);
  ledger.appendJsonl(nonceFile(root), {
    ts: new Date().toISOString(),
    nonce,
    event: "license_nonce",
  });
}

function licenseExpired(meta, now) {
  const stamp = Date.parse(meta.expiry);
  if (Number.isNaN(stamp)) throw coded("license expiry is unreadable", "EXPIRED");
  return stamp <= now.getTime();
}

function heldToken(nfts, nftokenId) {
  const row = ledger.findHeld(nfts, nftokenId);
  if (!row) throw coded("claimed account does not hold the license NFT", "HOLDER");
  if (row.Issuer && row.Issuer !== catalog.W2) throw coded("license issuer is not W2", "HOLDER");
  if (row.NFTokenTaxon != null && Number(row.NFTokenTaxon) !== catalog.TAXON) {
    throw coded("NFT taxon is not an agent work license", "HOLDER");
  }
  const pointer = row.URI ? catalog.decodeUriHex(row.URI) : catalog.parseUri(row.uri || row.URIText || "");
  if (!pointer) throw coded("license URI is not an aflic pointer", "HOLDER");
  return { nft: row, hash: pointer.hash };
}

async function issueChallenge(opts) {
  const options = opts || {};
  const now = options.now instanceof Date ? options.now : new Date();
  const issued = challenge.issue({
    account: options.account,
    nftokenId: options.nftokenId || options.nftoken_id,
    job: options.job || options.job_type || catalog.DEFAULT_JOB,
    nonce: options.nonce,
    exp: options.exp,
  }, now);
  return {
    challenge: issued.text,
    nonce: issued.nonce,
    exp: issued.exp,
    account: issued.account,
    nftoken_id: issued.nftokenId,
    job: issued.job,
  };
}

async function redeem(opts) {
  const options = opts || {};
  const root = options.root;
  if (!root) throw coded("redeem requires a root", "TX");
  const now = options.now instanceof Date ? options.now : new Date();
  const memory = options.nonces instanceof Set ? options.nonces : null;
  const checked = challenge.assertSignature({
    challenge: options.challenge,
    signature: options.signature,
    publicKey: options.publicKey || options.public_key,
    account: options.account,
    nftokenId: options.nftokenId || options.nftoken_id,
    now,
    allowDrySignature: options.allowDrySignature === true,
    regularKeys: options.regularKeys || options.regular_keys,
  });
  const parsed = checked.parsed;
  if (nonceSeen(root, parsed.nonce, memory)) throw coded("challenge nonce was already used", "REPLAY");
  rememberNonce(root, parsed.nonce, memory);

  const nfts = typeof options.accountNfts === "function"
    ? await options.accountNfts(parsed.account)
    : options.nfts;
  const held = heldToken(nfts, parsed.nftokenId);
  const meta = options.metadata || ledger.loadMetadata(root, held.hash);
  if (!meta) throw coded("license metadata for the URI hash is not on disk", "TX");
  if (catalog.contentHash(meta) !== held.hash) throw coded("license metadata does not match the URI", "TX");
  if (meta.job_type !== parsed.job) throw coded("challenge job does not match the license", "TX");
  if (licenseExpired(meta, now)) throw coded("license is expired", "EXPIRED");
  const used = usesConsumed(root, parsed.nftokenId);
  if (used >= meta.uses) throw coded("license uses are spent", "USED_UP");

  const delivered = await deliverJob.deliver({
    account: parsed.account,
    accountInfo: options.accountInfo,
    accountObjects: options.accountObjects,
    ledgerIndex: options.ledgerIndex,
    readAccount: options.readAccount,
    scribe: options.scribe,
    scribeUrl: options.scribeUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    allowAnyAccount: true,
  });
  const usesAfter = used + 1;
  const decision = settle.decide(meta, usesAfter);
  const ts = now.toISOString();
  const receipt = {
    ts,
    event: "license_redeemed",
    action: "license_redeemed",
    network: "XRPL Testnet",
    network_id: 1,
    account: parsed.account,
    nftoken_id: parsed.nftokenId,
    job_type: meta.job_type,
    uses_consumed: usesAfter,
    uses_allowed: meta.uses,
    summary_source: delivered.summary_source,
    summary: delivered.summary,
    report: delivered.report,
    signature_via: checked.via,
    ok: true,
    signed: false,
  };
  const settled = {
    ts,
    event: "license_settled",
    action: decision.action,
    network: "XRPL Testnet",
    network_id: 1,
    account: parsed.account,
    nftoken_id: parsed.nftokenId,
    uses_consumed: usesAfter,
    uses_allowed: meta.uses,
    uses_remaining: decision.uses_remaining,
    reason: decision.reason,
    signed: false,
  };
  ledger.appendJsonl(ledgerFile(root), receipt);
  ledger.appendJsonl(ledgerFile(root), settled);
  const burn = decision.action === "burn" ? settle.burnFor(parsed.account, parsed.nftokenId) : null;
  return {
    ok: true,
    receipt,
    settled,
    report: delivered.report,
    summary: delivered.summary,
    summary_source: delivered.summary_source,
    settle: decision,
    burn_tx: burn,
    uses_consumed: usesAfter,
    uses_allowed: meta.uses,
  };
}

module.exports = {
  usesConsumed,
  nonceSeen,
  issueChallenge,
  redeem,
  heldToken,
};
