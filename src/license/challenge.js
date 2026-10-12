"use strict";

/**
 * One-time redeem challenges. Canonical text only.
 * Signing a challenge is not a transaction and cannot submit one.
 */

const crypto = require("crypto");
const catalog = require("./catalog");

const PREFIX = "aether-license-redeem/v1";
const TTL_SEC = 120;
const MAX_TTL_SEC = 600;
const NONCE_RE = /^[a-f0-9]{32}$/;
const DRY_SIGNATURE = "dry-run";

function coded(message, code) {
  return catalog.coded(message, code);
}

function buildChallenge(fields) {
  const src = fields || {};
  const account = String(src.account || "");
  const nftokenId = String(src.nftokenId || src.nftoken_id || "").toUpperCase();
  const nonce = String(src.nonce || "").toLowerCase();
  const exp = Number(src.exp);
  const job = String(src.job || src.job_type || "");
  if (!catalog.HEX64.test(nftokenId)) throw coded("challenge requires NFTokenID", "CHALLENGE");
  if (!NONCE_RE.test(nonce)) throw coded("challenge nonce must be 32 hex chars", "CHALLENGE");
  if (!Number.isInteger(exp)) throw coded("challenge exp must be unix seconds", "CHALLENGE");
  if (!catalog.JOBS.includes(job)) throw coded("challenge job is not a license job", "CHALLENGE");
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) {
    throw coded("challenge account is not a classic address", "CHALLENGE");
  }
  return [
    PREFIX,
    `account=${account}`,
    `nftoken_id=${nftokenId}`,
    `nonce=${nonce}`,
    `exp=${exp}`,
    `job=${job}`,
    "",
  ].join("\n");
}

function parseChallenge(text) {
  if (typeof text !== "string" || text.length < 20 || text.length > 512) {
    throw coded("refusing challenge", "CHALLENGE");
  }
  if (text.includes("\r")) throw coded("refusing challenge", "CHALLENGE");
  const lines = text.split("\n");
  if (lines[lines.length - 1] !== "") throw coded("refusing challenge", "CHALLENGE");
  lines.pop();
  if (lines.length !== 6 || lines[0] !== PREFIX) throw coded("refusing challenge", "CHALLENGE");
  const take = (line, key) => {
    const prefix = `${key}=`;
    if (!line.startsWith(prefix) || line.indexOf("=") !== prefix.length - 1) {
      throw coded("refusing challenge", "CHALLENGE");
    }
    return line.slice(prefix.length);
  };
  const account = take(lines[1], "account");
  const nftokenId = take(lines[2], "nftoken_id");
  const nonce = take(lines[3], "nonce");
  const expText = take(lines[4], "exp");
  const job = take(lines[5], "job");
  if (!/^[0-9]+$/.test(expText)) throw coded("refusing challenge", "CHALLENGE");
  const rebuilt = buildChallenge({
    account,
    nftokenId,
    nonce,
    exp: Number(expText),
    job,
  });
  if (rebuilt !== text) throw coded("refusing challenge", "CHALLENGE");
  return {
    account,
    nftokenId: nftokenId.toUpperCase(),
    nonce,
    exp: Number(expText),
    job,
    text,
  };
}

function assertFresh(parsed, now, opts) {
  const clock = now instanceof Date ? now : new Date();
  const skew = opts && opts.maxTtlSec ? opts.maxTtlSec : MAX_TTL_SEC;
  const expMs = parsed.exp * 1000;
  if (expMs <= clock.getTime()) throw coded("challenge expired", "EXPIRED");
  if (expMs > clock.getTime() + skew * 1000) throw coded("challenge expiry is too far", "CHALLENGE");
  return parsed;
}

function issue(fields, now) {
  const clock = now instanceof Date ? now : new Date();
  const nonce = fields && fields.nonce ? String(fields.nonce).toLowerCase() : crypto.randomBytes(16).toString("hex");
  const exp = fields && fields.exp != null
    ? Number(fields.exp)
    : Math.floor(clock.getTime() / 1000) + TTL_SEC;
  const text = buildChallenge({
    account: fields.account,
    nftokenId: fields.nftokenId || fields.nftoken_id,
    nonce,
    exp,
    job: fields.job || fields.job_type,
  });
  const parsed = assertFresh(parseChallenge(text), clock);
  return parsed;
}

function messageHex(message) {
  return Buffer.from(message, "utf8").toString("hex").toUpperCase();
}

function signMessage(message, wallet) {
  const keypairs = require("ripple-keypairs");
  if (!wallet || !wallet.privateKey || !wallet.publicKey) {
    throw coded("refusing to sign a challenge without a key", "NO_SEED");
  }
  const signature = keypairs.sign(messageHex(message), wallet.privateKey).toUpperCase();
  const address = keypairs.deriveAddress(wallet.publicKey);
  return {
    signature,
    public_key: wallet.publicKey,
    address,
  };
}

function verifyMessage(message, signature, publicKey) {
  if (typeof message !== "string" || typeof signature !== "string" || typeof publicKey !== "string") {
    return false;
  }
  if (!/^[A-Fa-f0-9]+$/.test(signature) || !/^[A-Fa-f0-9]+$/.test(publicKey)) return false;
  try {
    const keypairs = require("ripple-keypairs");
    return keypairs.verify(messageHex(message), signature, publicKey) === true;
  } catch {
    return false;
  }
}

function addressOf(publicKey) {
  try {
    const keypairs = require("ripple-keypairs");
    return keypairs.deriveAddress(publicKey);
  } catch {
    return null;
  }
}

function assertSigner(account, publicKey, regularKeys) {
  const derived = addressOf(publicKey);
  if (!derived) throw coded("signature public key is not usable", "SIGNATURE");
  if (derived === account) return { address: derived, via: "account" };
  const rows = Array.isArray(regularKeys) ? regularKeys : [];
  const hit = rows.find((row) => row && row.account === account && row.regular_key === derived);
  if (!hit) throw coded("signature does not match the claimed account", "SIGNATURE");
  return { address: derived, via: "regular_key", wallet: hit.id || null };
}

function assertSignature(fields) {
  const src = fields || {};
  const parsed = parseChallenge(src.challenge);
  if (src.account && parsed.account !== src.account) {
    throw coded("challenge account does not match the claim", "CHALLENGE");
  }
  if (src.nftokenId && parsed.nftokenId !== String(src.nftokenId).toUpperCase()) {
    throw coded("challenge token does not match the claim", "CHALLENGE");
  }
  assertFresh(parsed, src.now || new Date());
  if (src.allowDrySignature === true && src.signature === DRY_SIGNATURE) {
    return { parsed, via: "dry-run", address: parsed.account };
  }
  if (!verifyMessage(parsed.text, src.signature, src.publicKey || src.public_key)) {
    throw coded("challenge signature did not verify", "SIGNATURE");
  }
  const signer = assertSigner(parsed.account, src.publicKey || src.public_key, src.regularKeys || src.regular_keys);
  return { parsed, via: signer.via, address: signer.address, wallet: signer.wallet || null };
}

module.exports = {
  PREFIX,
  TTL_SEC,
  MAX_TTL_SEC,
  DRY_SIGNATURE,
  NONCE_RE,
  buildChallenge,
  parseChallenge,
  assertFresh,
  issue,
  signMessage,
  verifyMessage,
  addressOf,
  assertSigner,
  assertSignature,
};
