"use strict";

/**
 * Unsigned XRPL Testnet OfferCreate and OfferCancel.
 * The mission signer is not used and remains Payment-only.
 * Nothing here signs or submits.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const missionConfig = require("../missions/config");
const missionPolicy = require("../missions/policy");
const { view } = require("../missions/engine");
const { PERMANENT_HOLD, LEGACY_DROPS } = require("./capabilities");

const TF_PASSIVE = 0x00010000;
const TF_TAKING = 0x00020000 | 0x00040000;
const FILE = "offers.jsonl";

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function offerPath(dir) {
  return path.join(dir, FILE);
}

function readOffers(dir) {
  const file = offerPath(dir);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (!text) return [];
  if (!text.endsWith("\n")) throw coded("offer ledger is ambiguous", "TAMPER");
  return text.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw coded("offer ledger is ambiguous", "TAMPER");
    }
  });
}

function fold(events) {
  const offers = {};
  let killed = false;
  for (const event of events) {
    if (!event) continue;
    if (event.type === "business.kill") killed = true;
    if (event.type === "business.clear_kill") killed = false;
    if (event.type === "offer.upsert" && event.offer && event.offer.id) offers[event.offer.id] = event.offer;
  }
  return { killed, offers };
}

function appendOffer(dir, event) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(offerPath(dir), `${JSON.stringify(event)}\n`);
}

function xrpDrops(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function iou(value) {
  if (!value || typeof value !== "object") return null;
  if (value.currency !== anchors.AETH_HEX || value.issuer !== anchors.WALLETS.W0.address) return null;
  if (typeof value.value !== "string" || !/^(?:0|[1-9][0-9]?)(?:\.[0-9]{1,6})?$/.test(value.value)) return null;
  if (Number(value.value) <= 0 || Number(value.value) > 100) return null;
  return value;
}

function legs(takerPays, takerGets) {
  const paysXrp = xrpDrops(takerPays);
  const getsXrp = xrpDrops(takerGets);
  const paysIou = iou(takerPays);
  const getsIou = iou(takerGets);
  if (paysXrp != null && getsIou) return { xrp: paysXrp, iou: getsIou };
  if (getsXrp != null && paysIou) return { xrp: getsXrp, iou: paysIou };
  return null;
}

function exposureOf(xrp, fee, reserve) {
  return xrp + fee + reserve;
}

function openExposure(book) {
  let total = 0n;
  for (const offer of Object.values(book.offers)) {
    if (offer.status === "filled" || offer.status === "cancelled") continue;
    total += BigInt(offer.exposure_drops || "0");
  }
  return total;
}

function dayUsed(input, now) {
  if (input.ledger) return missionPolicy.dayUsed(view(input.ledger, now), missionPolicy.chicagoDay(now));
  if (input.day_used_drops != null) return BigInt(input.day_used_drops);
  throw coded("day used observation is missing", "LEDGER");
}

function assertRoom(total, outstanding) {
  if (total <= 0n || total > missionConfig.PER_MISSION_DROPS) throw coded("offer exposure exceeds 1000000 drops", "CAP");
  if (outstanding + total > missionConfig.DAILY_DROPS) throw coded("Chicago-day cap would be exceeded", "CAP");
}

function assertTrader(input) {
  if (input.wallet_id === "W0") throw coded("refusing W0", "W0");
  if (input.wallet_id !== "W1") throw coded("offer account must be the W1 market wallet", "WALLET");
  const address = anchors.WALLETS.W1.address;
  if (input.account !== address) throw coded("offer account does not match W1", "ACCOUNT");
  if (input.network !== missionConfig.NETWORK || Number(input.network_id) !== missionConfig.NETWORK_ID) {
    throw coded("offer network must be xrpl:1", "MAINNET");
  }
  return address;
}

function publicOffer(offer) {
  return {
    schema: "aether.business.offer",
    id: offer.id,
    status: offer.status,
    signed: false,
    submitted: false,
    armed: false,
    wallet_id: "W1",
    network: missionConfig.NETWORK,
    network_id: missionConfig.NETWORK_ID,
    account: offer.account,
    price_source: "operator_limit",
    book_checked: false,
    activity: offer.activity,
    exposure_drops: offer.exposure_drops,
    fee_drops: offer.fee_drops,
    owner_reserve_drops: offer.owner_reserve_drops,
    legacy_hold: PERMANENT_HOLD,
    legacy_drops: LEGACY_DROPS,
    tx: offer.tx,
    cancel_tx: offer.cancel_tx || null,
  };
}

function prepareOffer(dir, input) {
  const now = input.now || new Date().toISOString();
  const book = fold(readOffers(dir));
  if (book.killed || input.killed === true) throw coded("business kill switch is on", "killed");
  const account = assertTrader(input);
  if (!Number.isInteger(input.sequence) || input.sequence <= 0) throw coded("validated sequence is missing", "LEDGER");
  if (!Number.isInteger(input.last_ledger_sequence) || input.last_ledger_sequence <= 0) {
    throw coded("last ledger sequence is missing", "LEDGER");
  }
  if (Number.isInteger(input.validated_ledger) && input.last_ledger_sequence <= input.validated_ledger) {
    throw coded("last ledger sequence is already behind the validated ledger", "LEDGER");
  }
  const fee = xrpDrops(input.fee_drops);
  const reserve = xrpDrops(input.owner_reserve_drops);
  if (fee == null || fee < 1n || fee > 10000n) throw coded("offer fee is outside the local bound", "FEE_CAP");
  if (reserve == null || reserve <= 0n) throw coded("owner reserve observation is missing", "RESERVE");
  const pair = legs(input.taker_pays, input.taker_gets);
  if (!pair) throw coded("offer must exchange XRP and AETH issued by W0, with a bounded amount", "ASSET");
  if (!Number.isInteger(input.flags) || (input.flags & TF_PASSIVE) !== TF_PASSIVE || (input.flags & TF_TAKING) !== 0) {
    throw coded("offer must be passive and must not take", "TX");
  }
  let destination = null;
  if (input.destination) {
    if (!xrpl.isValidClassicAddress(input.destination)) throw coded("destination is not a classic address", "ADDRESS");
    if (input.destination === account || missionPolicy.isHouse(input.destination)) {
      throw coded("refusing a self or house counterparty", "WASH");
    }
    destination = input.destination;
  }
  const key = String(input.idempotency_key || "");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("idempotency_key is missing", "IDEMPOTENCY");
  const existing = Object.values(book.offers).find((offer) => offer.idempotency_key === key);
  if (existing) return { offer: publicOffer(existing), replay: true };
  const total = exposureOf(pair.xrp, fee, reserve);
  assertRoom(total, dayUsed(input, now) + openExposure(book));
  const tx = {
    TransactionType: "OfferCreate",
    Account: account,
    TakerPays: input.taker_pays,
    TakerGets: input.taker_gets,
    Fee: fee.toString(),
    Sequence: input.sequence,
    LastLedgerSequence: input.last_ledger_sequence,
    Flags: input.flags,
  };
  if (destination) tx.Destination = destination;
  const offer = {
    id: `off-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
    idempotency_key: key,
    status: "prepared",
    account,
    activity: destination ? "demo_counterparty_not_customer_revenue" : "book_resting_offer_not_customer_revenue",
    exposure_drops: total.toString(),
    fee_drops: fee.toString(),
    owner_reserve_drops: reserve.toString(),
    xrp_drops: pair.xrp.toString(),
    tx,
    created_at: now,
  };
  appendOffer(dir, { type: "offer.upsert", at: now, offer });
  return { offer: publicOffer(offer), replay: false };
}

function prepareCancel(dir, input) {
  const now = input.now || new Date().toISOString();
  const book = fold(readOffers(dir));
  if (book.killed) throw coded("business kill switch is on", "killed");
  const offer = book.offers[input.offer_id];
  if (!offer || offer.status === "cancelled" || offer.status === "filled") throw coded("offer cannot be cancelled", "OFFER");
  if (offer.cancel_tx) return { offer: publicOffer(offer), replay: true };
  const fee = xrpDrops(input.fee_drops);
  if (fee == null || fee < 1n || fee > 10000n) throw coded("cancel fee is outside the local bound", "FEE_CAP");
  if (!Number.isInteger(input.sequence) || input.sequence <= 0) throw coded("validated sequence is missing", "LEDGER");
  if (dayUsed(input, now) + openExposure(book) + fee > missionConfig.DAILY_DROPS) {
    throw coded("Chicago-day cap would be exceeded", "CAP");
  }
  offer.cancel_tx = {
    TransactionType: "OfferCancel",
    Account: offer.account,
    OfferSequence: offer.tx.Sequence,
    Fee: fee.toString(),
    Sequence: input.sequence,
  };
  offer.status = "cancel_prepared";
  offer.updated_at = now;
  appendOffer(dir, { type: "offer.upsert", at: now, offer });
  return { offer: publicOffer(offer), replay: false };
}

function observeOffer(dir, input) {
  const now = input.now || new Date().toISOString();
  const book = fold(readOffers(dir));
  const offer = book.offers[input.offer_id];
  if (!offer) throw coded("offer not found", "OFFER");
  const listed = Array.isArray(input.open_offers) && input.open_offers.some((row) => row && row.seq === offer.tx.Sequence && row.account === offer.account);
  if (input.filled === true && typeof input.validated_hash === "string" && /^[0-9A-F]{64}$/.test(input.validated_hash)) {
    offer.status = "filled";
    offer.fill_hash = input.validated_hash;
  } else if (offer.cancel_tx && input.cancelled === true && typeof input.validated_hash === "string" && /^[0-9A-F]{64}$/.test(input.validated_hash)) {
    offer.status = "cancelled";
    offer.cancel_hash = input.validated_hash;
  } else if (listed) {
    offer.status = "open";
  } else if (input.expired === true) {
    offer.status = "unresolved";
  } else {
    offer.status = offer.status === "prepared" || offer.status === "cancel_prepared" ? offer.status : "unresolved";
  }
  offer.updated_at = now;
  appendOffer(dir, { type: "offer.upsert", at: now, offer });
  return { offer: publicOffer(offer), exposure_drops: openExposure(fold(readOffers(dir))).toString() };
}

function kill(dir, now) {
  appendOffer(dir, { type: "business.kill", at: now || new Date().toISOString() });
  return { killed: true, signed: false, submitted: false };
}

function load(dir) {
  return fold(readOffers(dir));
}

module.exports = {
  TF_PASSIVE,
  prepareOffer,
  prepareCancel,
  observeOffer,
  kill,
  load,
};
