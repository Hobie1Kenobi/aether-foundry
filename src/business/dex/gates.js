"use strict";

/**
 * Signer gates for the official RLUSD book.
 * W3 taker orders must be tfImmediateOrCancel.
 * W4 quotes must be passive.
 * OracleSet is W5 and fees only.
 * W0 never signs. The lookalike RLUSD issuer is refused.
 */

const anchors = require("../../director/anchors");

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CURRENCY = "524C555344000000000000000000000000000000";
const AMM = "rPn7kHwycXzS5XNj167CnKwC2t82yAAdNW";
const LOOKALIKE = "rKmPxq";
const TF_IOC = 0x00020000;
const TF_PASSIVE = 0x00010000;
const TF_FOK = 0x00040000;
const TF_NO_RIPPLE = 0x00020000;
const W3_MIN = 100000n;
const W3_MAX = 250000n;
const W4_MAX = 1000000n;
const W3_DAY = 4;
const W4_DAY = 12;
const W5_DAY = 48;
const FEE_MAX = 10000n;
const INTENTS = new Set(["w3_pool_taker", "w4_resting_quote", "w5_rlusd_oracle"]);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function assertNotW0(tx, wallet) {
  if (wallet === "W0" || (tx && tx.Account === anchors.WALLETS.W0.address)) {
    throw coded("refusing to sign as W0", "W0");
  }
}

function hasLookalike(tx) {
  return JSON.stringify(tx || {}).includes(LOOKALIKE);
}

function amountsOf(tx) {
  return [tx && tx.TakerGets, tx && tx.TakerPays, tx && tx.Amount, tx && tx.Amount2, tx && tx.SendMax, tx && tx.DeliverMin, tx && tx.LimitAmount];
}

function touchesOfficial(tx) {
  if (hasLookalike(tx)) return true;
  return amountsOf(tx).some((amount) => amount && typeof amount === "object" && (amount.issuer === ISSUER || amount.currency === CURRENCY));
}

function wantsRole(tx, intent) {
  if (INTENTS.has(intent)) return true;
  if (tx && tx.TransactionType === "OracleSet") return true;
  if (hasLookalike(tx)) return true;
  if (!tx || !touchesOfficial(tx)) return false;
  return tx.Account === anchors.WALLETS.W3.address || tx.Account === anchors.WALLETS.W4.address;
}

function xrpLeg(tx) {
  let total = 0n;
  for (const field of amountsOf(tx)) {
    if (typeof field === "string" && /^[0-9]+$/.test(field)) total += BigInt(field);
  }
  return total;
}

function assertNoLookalike(tx) {
  if (hasLookalike(tx)) throw coded("refusing the unsupported RLUSD issuer", "TX");
}

function assertPinned(tx) {
  assertNoLookalike(tx);
  let saw = tx && tx.TransactionType === "OfferCancel";
  for (const amount of amountsOf(tx)) {
    if (!amount || typeof amount !== "object") continue;
    if (amount.currency === CURRENCY && amount.issuer === ISSUER) {
      saw = true;
      continue;
    }
    if (amount.currency || amount.issuer) throw coded("signer refuses a lookalike RLUSD currency", "TX");
  }
  if (!saw) throw coded("order is not pinned to official RLUSD", "TX");
  if (tx.Destination && tx.Destination !== AMM && tx.Destination !== tx.Account) {
    throw coded("order is not pinned to the official RLUSD pool", "POOL");
  }
}

function assertIoc(tx) {
  if (Number(tx.Flags) !== TF_IOC) throw coded("taker orders require tfImmediateOrCancel", "TX");
}

function assertPassive(tx) {
  const flags = Number(tx.Flags) || 0;
  if ((flags & TF_PASSIVE) !== TF_PASSIVE) throw coded("resting quotes must be passive", "TX");
  if ((flags & TF_IOC) !== 0 || (flags & TF_FOK) !== 0) throw coded("resting quotes cannot take", "TX");
}

function assertTrust(tx) {
  assertPinned(tx);
  if (Number(tx.Flags) !== TF_NO_RIPPLE) throw coded("trust line requires NoRipple", "TX");
  if (!tx.LimitAmount || tx.LimitAmount.value !== "10") throw coded("trust line limit is 10", "TX");
}

function assertFeeOnly(tx) {
  if (!tx) throw coded("refusing an empty oracle", "TX");
  if (tx.Amount != null || tx.SendMax != null || tx.TakerGets != null || tx.TakerPays != null || tx.Destination != null) {
    throw coded("oracle is fees only", "CAP");
  }
}

function assertFeeBound(tx) {
  if (!tx || tx.Fee == null) return;
  if (typeof tx.Fee !== "string" || !/^[0-9]+$/.test(tx.Fee)) throw coded("fee is not drops", "FEE_CAP");
  const fee = BigInt(tx.Fee);
  if (fee <= 0n || fee > FEE_MAX) throw coded("fee is outside the local bound", "FEE_CAP");
}

function assertOraclePrice(tx) {
  const series = tx && tx.PriceDataSeries;
  const row = series && series[0] && (series[0].PriceData || series[0]);
  if (!row || row.BaseAsset !== CURRENCY || row.QuoteAsset !== "XRP") {
    throw coded("oracle must price official RLUSD in XRP", "TX");
  }
  if (!Number.isInteger(tx.OracleDocumentID) || tx.OracleDocumentID === 1) {
    throw coded("document 1 is the AETH oracle", "TX");
  }
  if (tx.OracleDocumentID !== 2) throw coded("RLUSD oracle uses document 2", "TX");
  const scale = Number(row.Scale);
  if (!Number.isInteger(scale) || scale < 0 || scale > 10) throw coded("oracle Scale is not 0-10", "TX");
  if (typeof row.AssetPrice !== "string" || !/^[0-9a-fA-F]+$/.test(row.AssetPrice)) {
    throw coded("AssetPrice is not a hex integer", "TX");
  }
  const price = BigInt(`0x${row.AssetPrice}`);
  if (price <= 0n || price > (1n << 64n) - 1n) throw coded("AssetPrice does not fit uint64", "TX");
  if (!Number.isInteger(tx.LastUpdateTime) || tx.LastUpdateTime < 1500000000) {
    throw coded("LastUpdateTime is not unix seconds", "TX");
  }
}

function assertOracleWallet(wallet, tx) {
  assertNotW0(tx, wallet);
  if (wallet !== "W5" || !tx || tx.Account !== anchors.WALLETS.W5.address) {
    throw coded("OracleSet is only W5", "WALLET");
  }
}

function dayCount(history, action, now) {
  const day = (now instanceof Date ? now : new Date(now || Date.now())).toISOString().slice(0, 10);
  return (history || []).filter((row) => {
    if (!row) return false;
    const name = row.action || row.intent;
    if (name !== action) return false;
    if (row.transaction_type && row.transaction_type !== "OfferCreate" && action !== "w5_rlusd_oracle") return false;
    return String(row.ts || "").startsWith(day);
  }).length;
}

function assertDay(history, action, max, now) {
  if (dayCount(history, action, now) >= max) {
    throw coded(`refusing more than ${max} ${action} orders on this UTC day`, "DAY");
  }
}

function assertRoleIntent(tx, intent, options) {
  const opts = options || {};
  if (!tx || typeof tx !== "object") throw coded("refusing empty tx", "TX");
  assertNoLookalike(tx);
  assertNotW0(tx, opts.wallet);
  if (tx.NetworkID != null && Number(tx.NetworkID) !== 1) throw coded("refusing network id", "MAINNET");
  if (tx.TransactionType === "OracleSet" || intent === "w5_rlusd_oracle") {
    assertOracleWallet(opts.wallet, tx);
    if (intent !== "w5_rlusd_oracle") throw coded("OracleSet requires the W5 RLUSD oracle intent", "TX");
    if (tx.TransactionType !== "OracleSet") throw coded("W5 RLUSD oracle is OracleSet", "TX");
    assertFeeOnly(tx);
    assertOraclePrice(tx);
    assertFeeBound(tx);
    assertDay(opts.history, "w5_rlusd_oracle", W5_DAY, opts.now);
    return;
  }
  const taker = intent === "w3_pool_taker" || (touchesOfficial(tx) && tx.Account === anchors.WALLETS.W3.address);
  const quote = intent === "w4_resting_quote" || (touchesOfficial(tx) && tx.Account === anchors.WALLETS.W4.address);
  if (taker) {
    if (opts.wallet !== "W3" || tx.Account !== anchors.WALLETS.W3.address) throw coded("pool taker is only W3", "WALLET");
    if (intent !== "w3_pool_taker") throw coded("RLUSD taker orders require the W3 pool taker intent", "TX");
    assertPinned(tx);
    if (tx.TransactionType === "OfferCreate") {
      assertIoc(tx);
      const leg = xrpLeg(tx);
      if (leg < W3_MIN || leg > W3_MAX) throw coded("taker order is outside 0.1-0.25 XRP", "CAP");
      assertDay(opts.history, "w3_pool_taker", W3_DAY, opts.now);
    } else if (tx.TransactionType === "TrustSet") {
      assertTrust(tx);
    } else if (tx.TransactionType !== "OfferCancel") {
      throw coded("pool taker refuses this transaction type", "TX");
    }
    assertFeeBound(tx);
    return;
  }
  if (quote) {
    if (opts.wallet !== "W4" || tx.Account !== anchors.WALLETS.W4.address) throw coded("resting quoter is only W4", "WALLET");
    if (intent !== "w4_resting_quote") throw coded("RLUSD quotes require the W4 resting intent", "TX");
    assertPinned(tx);
    if (tx.TransactionType === "OfferCreate") {
      assertPassive(tx);
      const leg = xrpLeg(tx);
      if (leg <= 0n || leg > W4_MAX) throw coded("quote is above the 1 XRP role cap", "CAP");
      assertDay(opts.history, "w4_resting_quote", W4_DAY, opts.now);
    } else if (tx.TransactionType === "TrustSet") {
      assertTrust(tx);
    } else if (tx.TransactionType !== "OfferCancel") {
      throw coded("resting quoter refuses this transaction type", "TX");
    }
    assertFeeBound(tx);
    return;
  }
  throw coded("refusing an unpinned RLUSD order", "TX");
}

function same(left, right) {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (!left || !right) return false;
  return left.currency === right.currency && left.issuer === right.issuer && left.value === right.value;
}

function assertDex(tx, expected) {
  if (!tx || !expected) throw coded("refusing an empty transaction", "TX");
  assertNotW0(tx, expected.role);
  if (expected.account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  if (tx.Account !== expected.account) throw coded("signer account is not the role", "WALLET");
  if (tx.TransactionType !== expected.type) throw coded("signer type is not the reserved action", "TX");
  if (tx.Memos != null || tx.NetworkID != null) throw coded("signer refuses memos and network id", "TX");
  if (tx.Sequence !== expected.sequence || tx.LastLedgerSequence !== expected.last || tx.Fee !== expected.fee) {
    throw coded("signer refuses a changed sequence, ledger window, or fee", "TX");
  }
  assertFeeBound(tx);
  if (expected.type === "OfferCreate") {
    if (!same(tx.TakerPays, expected.taker_pays) || !same(tx.TakerGets, expected.taker_gets)) {
      throw coded("signer refuses changed amounts", "TX");
    }
    if (expected.role === "W3") assertIoc(tx);
    if (expected.role === "W4") assertPassive(tx);
    assertPinned(tx);
    const leg = xrpLeg(tx);
    if (expected.role === "W3" && (leg < W3_MIN || leg > W3_MAX)) throw coded("taker order is outside 0.1-0.25 XRP", "CAP");
    if (expected.role === "W4" && leg > W4_MAX) throw coded("quote is above the 1 XRP role cap", "CAP");
  }
  if (expected.type === "TrustSet") assertTrust(tx);
  if (expected.type === "OfferCancel" && tx.OfferSequence !== expected.offer_sequence) {
    throw coded("signer refuses a changed offer sequence", "TX");
  }
  if (expected.role === "W5" || expected.type === "OracleSet") {
    assertOracleWallet("W5", tx);
    assertFeeOnly(tx);
    assertOraclePrice(tx);
  }
}

module.exports = {
  ISSUER,
  CURRENCY,
  AMM,
  LOOKALIKE,
  TF_IOC,
  TF_PASSIVE,
  W3_MIN,
  W3_MAX,
  W4_MAX,
  W3_DAY,
  W4_DAY,
  W5_DAY,
  wantsRole,
  touchesOfficial,
  xrpLeg,
  assertNotW0,
  assertIoc,
  assertPassive,
  assertPinned,
  assertFeeOnly,
  assertOracleWallet,
  assertRoleIntent,
  assertDex,
  dayCount,
};
