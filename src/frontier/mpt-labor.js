"use strict";

/**
 * F2 labor MPT. AETH-LABOR is an MPTokenIssuance on W5.
 * The AETH IOU stays the AMM pair. This module does not sign.
 * TokenEscrow finish/cancel is F3. Credentials are F4.
 * DynamicMPT is off, so ImmutableFlags is omitted.
 * ConfidentialTransfer is off, so the confidential flag is omitted.
 */

const crypto = require("crypto");
const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const walkIn = require("../walk-in-public");

const ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const ISSUANCE_ID_RE = /^[0-9A-F]{48}$/;
const AMENDMENT = "MPTokensV1";
const TICKER = "LABOR";
const SYMBOL = "AETH-LABOR";
const MAXIMUM_AMOUNT = "1000000";
const ASSET_SCALE = 0;
const TRANSFER_FEE = 0;
const ISSUER_ID = "W5";
const HOLDER_ID = "W2";
const INTENT_CREATE = "mpt_labor_create";
const INTENT_AUTHORIZE = "mpt_labor_authorize";
const README_URL =
  "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/labor-mpt/README.md";

const TF_MPT_CAN_LOCK = 0x00000002;
const TF_MPT_REQUIRE_AUTH = 0x00000004;
const TF_MPT_CAN_ESCROW = 0x00000008;
const TF_MPT_CAN_TRADE = 0x00000010;
const TF_MPT_CAN_TRANSFER = 0x00000020;
const TF_MPT_CAN_CLAWBACK = 0x00000040;
const TF_MPT_CAN_HOLD_CONFIDENTIAL = 0x00000080;
const TF_MPT_UNAUTHORIZE = 0x00000001;

const ISSUANCE_FLAGS = TF_MPT_REQUIRE_AUTH | TF_MPT_CAN_ESCROW | TF_MPT_CAN_TRANSFER | TF_MPT_CAN_CLAWBACK;

const REGULAR_KEY_ENV = {
  W1: "W1_REGULAR_SEED",
  W2: "W2_REGULAR_SEED",
  W3: "W3_REGULAR_SEED",
  W4: "W4_REGULAR_SEED",
  W5: "W5_REGULAR_SEED",
  W6: "W6_REGULAR_SEED",
};

function coded(message, code) {
  return Object.assign(new Error(message), { code: code || "REFUSED" });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function decodeBase58(text) {
  const bytes = [0];
  for (const char of String(text || "")) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw coded(`address ${text} is not base58`, "ADDRESS");
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of String(text || "")) {
    if (char === ALPHABET[0]) bytes.push(0);
    else break;
  }
  return Buffer.from(bytes.reverse());
}

function accountId(address) {
  if (!anchors.ADDRESS_RE.test(address || "")) throw coded(`refusing address ${address}`, "ADDRESS");
  const decoded = decodeBase58(address);
  if (decoded.length < 5) throw coded(`address ${address} is short`, "ADDRESS");
  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expect = sha256(sha256(payload)).subarray(0, 4);
  if (!checksum.equals(expect)) throw coded(`address ${address} checksum failed`, "ADDRESS");
  if (payload.length !== 21 || payload[0] !== 0x00) {
    throw coded(`address ${address} is not an account id`, "ADDRESS");
  }
  return payload.subarray(1);
}

function isIssuanceId(value) {
  return typeof value === "string" && ISSUANCE_ID_RE.test(value.toUpperCase());
}

function issuanceId(sequence, address) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw coded("MPT issuance sequence is not a uint32", "ISSUANCE");
  }
  const seq = sequence.toString(16).toUpperCase().padStart(8, "0");
  const id = `${seq}${accountId(address).toString("hex").toUpperCase()}`;
  if (!ISSUANCE_ID_RE.test(id)) throw coded("MPT issuance id is not 48 hex", "ISSUANCE");
  return id;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

function metadataObject() {
  return {
    t: TICKER,
    n: SYMBOL,
    d: "Foundry labor unit. The AETH IOU remains the AMM pair.",
    i: "raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/docs/assets/mark.svg",
    ac: "other",
    in: "Aether Foundry",
    us: [
      {
        u: "github.com/Hobie1Kenobi/aether-foundry/blob/main/machines/labor-mpt/README.md",
        c: "docs",
        t: "Labor MPT",
      },
    ],
    ai: {
      symbol: SYMBOL,
      unit: "labor",
      cap: MAXIMUM_AMOUNT,
      amm_pair: "AETH/XRP IOU",
    },
  };
}

function encodeMetadata(obj) {
  const text = JSON.stringify(sortValue(obj || metadataObject()));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0 || bytes.length > 1024) {
    throw coded(`MPTokenMetadata is ${bytes.length} bytes`, "METADATA");
  }
  return bytes.toString("hex").toUpperCase();
}

function decodeMetadata(hex) {
  const raw = String(hex || "");
  if (raw.length === 0 || raw.length % 2 !== 0 || !/^[0-9A-F]+$/i.test(raw)) {
    throw coded("MPTokenMetadata is not hex", "METADATA");
  }
  return JSON.parse(Buffer.from(raw, "hex").toString("utf8"));
}

function rowsOf(feature) {
  if (feature && Array.isArray(feature.amendments)) return feature.amendments;
  const raw = feature && feature.features;
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([hash, row]) => Object.assign({ hash }, row || {}));
}

function assertMptEnabled(feature, verb) {
  const what = verb || "MPT labor";
  const rows = rowsOf(feature);
  if (!rows) throw coded("feature response omitted features", "AMENDMENT");
  const row = rows.find((item) => item && item.name === AMENDMENT);
  if (!row) throw coded(`feature response omitted ${AMENDMENT}; refusing ${what}`, "AMENDMENT");
  if (row.enabled !== true) throw coded(`${AMENDMENT} is disabled; refusing ${what}`, "AMENDMENT");
  const hash = row.hash == null ? null : String(row.hash).toUpperCase();
  return {
    name: AMENDMENT,
    enabled: true,
    supported: row.supported === true,
    hash: hash && anchors.HASH_RE.test(hash) ? hash : null,
  };
}

function memos(purpose) {
  return [
    grants.memo("purpose", purpose),
    grants.memo("experiment", "labor-mpt"),
    grants.memo("symbol", SYMBOL),
  ];
}

function buildIssuance() {
  if ((ISSUANCE_FLAGS & TF_MPT_CAN_TRANSFER) === 0) throw coded("labor MPT must be transferable", "FLAGS");
  if ((ISSUANCE_FLAGS & TF_MPT_CAN_TRADE) !== 0) throw coded("labor MPT must not trade; AETH stays the AMM pair", "FLAGS");
  if ((ISSUANCE_FLAGS & TF_MPT_CAN_HOLD_CONFIDENTIAL) !== 0) {
    throw coded("refusing confidential MPT while ConfidentialTransfer is a separate amendment", "FLAGS");
  }
  if ((ISSUANCE_FLAGS & TF_MPT_CAN_ESCROW) === 0) throw coded("labor MPT must allow escrow for F3", "FLAGS");
  if ((ISSUANCE_FLAGS & TF_MPT_REQUIRE_AUTH) === 0) throw coded("labor MPT must require holder auth", "FLAGS");
  if ((ISSUANCE_FLAGS & TF_MPT_CAN_CLAWBACK) === 0) throw coded("labor MPT must allow clawback", "FLAGS");
  const metadata = encodeMetadata(metadataObject());
  const tx = {
    TransactionType: "MPTokenIssuanceCreate",
    Account: anchors.WALLETS[ISSUER_ID].address,
    AssetScale: ASSET_SCALE,
    TransferFee: TRANSFER_FEE,
    MaximumAmount: MAXIMUM_AMOUNT,
    MPTokenMetadata: metadata,
    Flags: ISSUANCE_FLAGS,
    Memos: memos("aether-labor"),
  };
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to issue labor from W0", "W0");
  if (Object.prototype.hasOwnProperty.call(tx, "ImmutableFlags")) {
    throw coded("refusing ImmutableFlags while DynamicMPT is not this pack", "FLAGS");
  }
  if (Object.prototype.hasOwnProperty.call(tx, "DomainID")) throw coded("refusing a permissioned domain on labor", "FLAGS");
  return tx;
}

function walletIdOf(address) {
  for (const id of Object.keys(REGULAR_KEY_ENV)) {
    if (anchors.WALLETS[id] && anchors.WALLETS[id].address === address) return id;
  }
  return null;
}

function assertHolder(address) {
  if (!anchors.ADDRESS_RE.test(address || "")) throw coded("holder is not a classic address", "HOLDER");
  if (address === anchors.WALLETS.W0.address) throw coded("refusing W0 as the labor holder", "W0");
  if (address === anchors.WALLETS[ISSUER_ID].address) throw coded("refusing the issuer as the labor holder", "HOLDER");
  return address;
}

function buildAuthorize(opts) {
  const options = opts || {};
  const id = options.issuanceId == null ? "" : String(options.issuanceId).toUpperCase();
  if (!ISSUANCE_ID_RE.test(id)) throw coded("MPTokenIssuanceID is not 48 hex", "ISSUANCE");
  const holder = assertHolder(options.holder || anchors.WALLETS[HOLDER_ID].address);
  const optIn = options.optIn === true;
  const tx = {
    TransactionType: "MPTokenAuthorize",
    Account: optIn ? holder : anchors.WALLETS[ISSUER_ID].address,
    MPTokenIssuanceID: id,
    Memos: memos(optIn ? "aether-labor-opt-in" : "aether-labor-authorize"),
  };
  if (!optIn) tx.Holder = holder;
  if ((tx.Flags || 0) & TF_MPT_UNAUTHORIZE) throw coded("refusing tfMPTUnauthorize", "FLAGS");
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to authorize as W0", "W0");
  return { tx, holder, optIn, issuanceId: id, signerId: optIn ? walletIdOf(holder) : ISSUER_ID };
}

function receiptSketch(issuanceIdValue) {
  const id = issuanceIdValue == null ? "" : String(issuanceIdValue).toUpperCase();
  const fragment = id && ISSUANCE_ID_RE.test(id) ? id : "";
  const uri = `${README_URL}#mpt=${fragment}&symbol=${encodeURIComponent(SYMBOL)}`;
  return {
    submitted: false,
    note: "Unsigned NFT receipt. This pack does not submit it. TokenEscrow of the MPT is F3.",
    mint: {
      TransactionType: "NFTokenMint",
      Account: anchors.WALLETS[HOLDER_ID].address,
      URI: walkIn.toHexUri(uri),
      Flags: walkIn.TF_TRANSFERABLE,
      TransferFee: walkIn.TRANSFER_FEE,
      NFTokenTaxon: walkIn.TAXON,
    },
  };
}

function issuanceIdFromMeta(meta, issuer) {
  const node = meta && typeof meta === "object" ? meta : {};
  const direct = node.mpt_issuance_id || node.mptIssuanceID;
  if (isIssuanceId(direct)) return String(direct).toUpperCase();
  const affected = Array.isArray(node.AffectedNodes) ? node.AffectedNodes : [];
  for (const row of affected) {
    const created = row && row.CreatedNode;
    if (!created || created.LedgerEntryType !== "MPTokenIssuance") continue;
    const fields = created.NewFields || {};
    const fromFields = fields.MPTokenIssuanceID || fields.mpt_issuance_id;
    if (isIssuanceId(fromFields)) return String(fromFields).toUpperCase();
    const seq = Number(fields.Sequence);
    if (Number.isInteger(seq) && issuer) return issuanceId(seq, issuer);
  }
  return null;
}

function keyEnvFor(walletId) {
  if (walletId === "W0" || walletId === "W7") throw coded(`refusing to sign as ${walletId}`, walletId === "W0" ? "W0" : "HOLDER");
  const env = REGULAR_KEY_ENV[walletId];
  if (!env) throw coded("opt-in holder is not a Foundry regular key", "HOLDER");
  return env;
}

module.exports = {
  ISSUANCE_ID_RE,
  AMENDMENT,
  TICKER,
  SYMBOL,
  MAXIMUM_AMOUNT,
  ASSET_SCALE,
  TRANSFER_FEE,
  ISSUER_ID,
  HOLDER_ID,
  INTENT_CREATE,
  INTENT_AUTHORIZE,
  README_URL,
  TF_MPT_CAN_LOCK,
  TF_MPT_REQUIRE_AUTH,
  TF_MPT_CAN_ESCROW,
  TF_MPT_CAN_TRADE,
  TF_MPT_CAN_TRANSFER,
  TF_MPT_CAN_CLAWBACK,
  TF_MPT_CAN_HOLD_CONFIDENTIAL,
  TF_MPT_UNAUTHORIZE,
  ISSUANCE_FLAGS,
  REGULAR_KEY_ENV,
  coded,
  accountId,
  isIssuanceId,
  issuanceId,
  metadataObject,
  encodeMetadata,
  decodeMetadata,
  assertMptEnabled,
  buildIssuance,
  buildAuthorize,
  receiptSketch,
  issuanceIdFromMeta,
  walletIdOf,
  keyEnvFor,
  assertHolder,
};
