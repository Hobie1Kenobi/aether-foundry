"use strict";

/**
 * Agent Work License parameters. Public constants and unsigned tx builders.
 * No seeds, no Wallet, no submit.
 */

const crypto = require("crypto");
const anchors = require("../director/anchors");

const TAXON = 20261012;
const TRANSFER_FEE = 5000;
const TF_BURNABLE = 0x00000001;
const TF_TRANSFERABLE = 0x00000008;
const TF_SELL_NFTOKEN = 0x00000001;
const MINT_FLAGS = TF_BURNABLE | TF_TRANSFERABLE;
const PRICE_DROPS = "2000000";
const URI_PREFIX = "aflic:1:";
const AGENT_ID = "w2-atelier";
const JOBS = ["ledger-analysis-report", "scribe-summary"];
const DEFAULT_EXPIRY = "2027-10-12T00:00:00Z";
const DEFAULT_JOB = "ledger-analysis-report";
const DEFAULT_USES = 1;
const W2 = anchors.WALLETS.W2.address;
const W4 = anchors.WALLETS.W4.address;
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const HEX64 = /^[A-F0-9]{64}$/;
const EXPIRY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function metadata(input) {
  const src = input || {};
  const uses = Number(src.uses == null ? DEFAULT_USES : src.uses);
  if (!Number.isInteger(uses) || uses < 1 || uses > 100) {
    throw coded("license uses must be an integer from 1 to 100", "TX");
  }
  const job = String(src.job_type || src.job || DEFAULT_JOB);
  if (!JOBS.includes(job)) throw coded(`unknown license job ${job}`, "TX");
  const expiry = String(src.expiry || DEFAULT_EXPIRY);
  if (!EXPIRY_RE.test(expiry)) throw coded("license expiry must be UTC YYYY-MM-DDTHH:MM:SSZ", "TX");
  return {
    v: 1,
    machine: "agent-work-license",
    network: "xrpl:1",
    agent_id: AGENT_ID,
    job_type: job,
    uses,
    expiry,
    issuer: W2,
    taxon: TAXON,
    transfer_fee: TRANSFER_FEE,
  };
}

function canonical(doc) {
  const row = metadata(doc);
  return JSON.stringify(row);
}

function contentHash(doc) {
  return sha256(canonical(doc));
}

function uriFor(doc) {
  return `${URI_PREFIX}${contentHash(doc)}`;
}

function uriHex(doc) {
  return Buffer.from(uriFor(doc), "utf8").toString("hex").toUpperCase();
}

function parseUri(text) {
  const raw = String(text || "");
  if (!raw.startsWith(URI_PREFIX)) return null;
  const hash = raw.slice(URI_PREFIX.length).toUpperCase();
  if (!HEX64.test(hash)) return null;
  return { hash, uri: `${URI_PREFIX}${hash}` };
}

function decodeUriHex(hex) {
  if (typeof hex !== "string" || !/^[A-Fa-f0-9]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return parseUri(Buffer.from(hex, "hex").toString("utf8"));
}

function mintTx(doc) {
  const row = metadata(doc);
  return {
    TransactionType: "NFTokenMint",
    Account: W2,
    NFTokenTaxon: TAXON,
    Flags: MINT_FLAGS,
    TransferFee: TRANSFER_FEE,
    URI: uriHex(row),
  };
}

function listTx(nftokenId) {
  const id = String(nftokenId || "").toUpperCase();
  if (!HEX64.test(id)) throw coded("license list requires NFTokenID", "TX");
  return {
    TransactionType: "NFTokenCreateOffer",
    Account: W2,
    NFTokenID: id,
    Amount: PRICE_DROPS,
    Flags: TF_SELL_NFTOKEN,
  };
}

function buyTx(offerId) {
  const id = String(offerId || "").toUpperCase();
  if (!HEX64.test(id)) throw coded("license buy requires NFTokenSellOffer", "TX");
  return {
    TransactionType: "NFTokenAcceptOffer",
    Account: W4,
    NFTokenSellOffer: id,
  };
}

function burnTx(account, nftokenId) {
  const id = String(nftokenId || "").toUpperCase();
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(account || ""))) {
    throw coded("holder burn requires the holder classic address", "TX");
  }
  if (!HEX64.test(id)) throw coded("license burn requires NFTokenID", "TX");
  return {
    TransactionType: "NFTokenBurn",
    Account: account,
    NFTokenID: id,
  };
}

function explorerUrl(hash) {
  return `${EXPLORER}${String(hash || "").toUpperCase()}`;
}

module.exports = {
  TAXON,
  TRANSFER_FEE,
  TF_BURNABLE,
  TF_TRANSFERABLE,
  TF_SELL_NFTOKEN,
  MINT_FLAGS,
  PRICE_DROPS,
  URI_PREFIX,
  AGENT_ID,
  JOBS,
  DEFAULT_EXPIRY,
  DEFAULT_JOB,
  DEFAULT_USES,
  W2,
  W4,
  EXPLORER,
  HEX64,
  coded,
  sha256,
  metadata,
  canonical,
  contentHash,
  uriFor,
  uriHex,
  parseUri,
  decodeUriHex,
  mintTx,
  listTx,
  buyTx,
  burnTx,
  explorerUrl,
};
