"use strict";

/**
 * W1 RLUSD/XRP trading inside the shared 100 XRP bankroll.
 * AETH stays unpriced. RLUSD may use only the XRP left after that high-water.
 * This is bounded trading. It is not training.
 */

const crypto = require("crypto");
const { coded, exclusive } = require("../../missions/ledger");
const { view } = require("../../missions/engine");
const policy = require("../../missions/policy");
const anchors = require("../../director/anchors");
const bankroll = require("../bankroll");
const bounds = require("./bounds");
const market = require("./market");
const signer = require("./signer");
const snapshot = require("./snapshot");

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CURRENCY = "524C555344000000000000000000000000000000";
const AMM = "rPn7kHwycXzS5XNj167CnKwC2t82yAAdNW";
const REGULAR_KEY = "rDyiGKuMgL2F8S7TjB6m6Wg1pLg5KDPJYY";
const TRUST_LIMIT = "10";
const TF_SET_NO_RIPPLE = 0x00020000;
const MAX_TRADE_DROPS = 2000000n;
const DEFAULT_TRADE_DROPS = 1000000n;
const HAIRCUT_NUM = 90n;
const HAIRCUT_DEN = 100n;
const KIND = "w1-rlusd";
const SCALE = 10n ** 15n;

function isRlusd(value) {
  if (!value || typeof value !== "object" || value.issuer !== ISSUER) return false;
  return value.currency === CURRENCY || value.currency === "RLUSD";
}

function canonical(value) {
  if (!isRlusd(value)) return null;
  const amount = market.scaled(value.value);
  if (amount == null || amount < 0n) return null;
  return { currency: CURRENCY, issuer: ISSUER, value: value.value, amount };
}

function formatAmount(amount) {
  if (amount < 0n) return null;
  const digits = amount.toString();
  if (digits.length > 15) {
    const cut = digits.length - 15;
    const unit = 10n ** BigInt(cut);
    amount = (amount / unit) * unit;
  }
  const whole = amount / SCALE;
  const frac = (amount % SCALE).toString().padStart(15, "0").replace(/0+$/, "");
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
  if (market.scaled(text) == null) return null;
  return text;
}

function planTrustLine(account) {
  if (account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  if (account === anchors.WALLETS.W7.address) throw coded("W7 is not an xrpl:1 account", "WALLET");
  const allowed = ["W1", "W2", "W3", "W4", "W5", "W6"].map((id) => anchors.WALLETS[id].address);
  if (!allowed.includes(account)) throw coded("trust line account is not W1-W6", "WALLET");
  return {
    account,
    submit: account === bounds.ACCOUNT,
    currency: CURRENCY,
    issuer: ISSUER,
    limit: TRUST_LIMIT,
    flags: TF_SET_NO_RIPPLE,
    trading: account === bounds.ACCOUNT,
  };
}

function hasLine(lines) {
  return (lines || []).some((line) => line && isRlusd({ currency: line.currency, issuer: line.account, value: "0" }));
}

function outside(account) {
  if (!account || policy.isHouse(account)) return false;
  if (account === AMM || account === anchors.AMM || account === bounds.ACCOUNT) return false;
  return true;
}

function quoteBuy(pool, spendDrops) {
  if (!pool || pool.xrp <= 0n || pool.rlusd < 0n || spendDrops <= 0n) throw coded("RLUSD pool is not priced", "VALUATION");
  const fee = BigInt(pool.tradingFee);
  if (fee < 0n || fee >= 100000n) throw coded("RLUSD trading fee is missing", "VALUATION");
  const net = (spendDrops * (100000n - fee)) / 100000n;
  if (net <= 0n) throw coded("trade is smaller than the fee", "VALUATION");
  const out = (pool.rlusd * net) / (pool.xrp + net);
  const deliver = (out * 99n) / 100n;
  const text = formatAmount(deliver);
  if (!text || market.scaled(text) <= 0n) throw coded("RLUSD deliver amount is empty", "VALUATION");
  return { sendMax: spendDrops, deliver: text };
}

function markInventory(pool, bids, balance) {
  if (balance === 0n) return { proved: true, xrp: 0n };
  const usable = (bids || []).filter((bid) => bid && outside(bid.account) && bid.xrp >= 1000000n && bid.rlusd > 0n);
  if (!pool || pool.rlusd <= 0n || usable.length === 0) return { proved: false, xrp: 0n };
  let best = null;
  for (const bid of usable) {
    const rate = (bid.xrp * SCALE) / bid.rlusd;
    if (best == null || rate > best) best = rate;
  }
  const amm = (pool.xrp * SCALE) / pool.rlusd;
  const rate = (best < amm ? best : amm) * HAIRCUT_NUM / HAIRCUT_DEN;
  return { proved: true, xrp: (balance * rate) / SCALE };
}

async function load(ledger) {
  const info = await ledger.request({ command: "account_info", account: bounds.ACCOUNT, ledger_index: "validated" });
  const data = info && info.result && info.result.account_data;
  if (!info.result || info.result.validated !== true || !data || data.Account !== bounds.ACCOUNT) {
    throw coded("validated W1 account is missing", "LEDGER");
  }
  if (data.RegularKey !== REGULAR_KEY) throw coded("W1 regular key is not the pinned signer", "REGULAR_KEY");
  const lines = await ledger.request({ command: "account_lines", account: bounds.ACCOUNT, ledger_index: "validated" });
  const page = lines && lines.result;
  if (!page || page.validated !== true || page.marker != null || !Array.isArray(page.lines)) {
    throw coded("validated trust lines are missing", "UNCERTAIN");
  }
  const amm = await ledger.request({
    command: "amm_info",
    asset: { currency: "XRP" },
    asset2: { currency: CURRENCY, issuer: ISSUER },
    ledger_index: "validated",
  });
  const body = amm && amm.result && amm.result.amm;
  if (!amm.result || amm.result.validated !== true || !body || body.account !== AMM) throw coded("RLUSD AMM is not the allowlisted pool", "POOL");
  const xrp = typeof body.amount === "string" ? BigInt(body.amount) : null;
  const iou = canonical(body.amount2) || canonical(body.amount);
  const xrpSide = typeof body.amount === "string" ? xrp : (typeof body.amount2 === "string" ? BigInt(body.amount2) : null);
  if (xrpSide == null || !iou || iou.amount <= 0n) throw coded("RLUSD pool assets cannot be valued", "VALUATION");
  if (!Number.isInteger(body.trading_fee)) throw coded("RLUSD trading fee is missing", "VALUATION");
  const bids = await ledger.request({
    command: "book_offers",
    taker_gets: { currency: "XRP" },
    taker_pays: { currency: CURRENCY, issuer: ISSUER },
    ledger_index: "validated",
    limit: 20,
  });
  const asks = await ledger.request({
    command: "book_offers",
    taker_gets: { currency: CURRENCY, issuer: ISSUER },
    taker_pays: { currency: "XRP" },
    ledger_index: "validated",
    limit: 20,
  });
  for (const page of [bids, asks]) {
    if (!page.result || page.result.validated !== true || page.result.marker != null || !Array.isArray(page.result.offers)) {
      throw coded("RLUSD book is incomplete", "UNCERTAIN");
    }
  }
  return {
    trustline: hasLine(page.lines),
    pool: { xrp: xrpSide, rlusd: iou.amount, tradingFee: body.trading_fee, account: body.account },
    bids: bookSide(bids.result.offers, "bid"),
    asks: bookSide(asks.result.offers, "ask"),
  };
}

function bookSide(offers, side) {
  const rows = [];
  for (const row of offers) {
    if (!row || typeof row.Account !== "string") throw coded("RLUSD offer has no account", "UNCERTAIN");
    if (!outside(row.Account)) continue;
    const xrp = side === "bid" ? marketXrp(row.TakerGets) : marketXrp(row.TakerPays);
    const iou = side === "bid" ? canonical(row.TakerPays) : canonical(row.TakerGets);
    if (xrp == null || !iou || iou.amount <= 0n || xrp <= 0n || xrp > bankroll.BANKROLL_DROPS) continue;
    rows.push({ account: row.Account, xrp, rlusd: iou.amount });
  }
  return rows;
}

function marketXrp(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function headroom(position, state) {
  const base = position && typeof position.proved_xrp === "bigint" ? position.proved_xrp : bankroll.BANKROLL_DROPS;
  let extra = 0n;
  for (const mission of Object.values((state && state.missions) || {})) {
    if (!mission || mission.kind !== KIND) continue;
    extra += BigInt(mission.outstanding_drops || "0");
    extra += BigInt(mission.realized_loss_drops || "0");
  }
  const used = base + extra;
  return {
    used,
    headroom: used >= bankroll.BANKROLL_DROPS ? 0n : bankroll.BANKROLL_DROPS - used,
    exit: used + DEFAULT_TRADE_DROPS > bankroll.BANKROLL_DROPS,
  };
}

function findOpen(state) {
  return Object.values(state.missions || {}).find((mission) => mission && mission.kind === KIND && mission.hold !== "released" && mission.status !== "rlusd_proved") || null;
}

function reserve(dir, order, shot, now) {
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    if (state.killed) throw coded("hard stop is on", "killed");
    const existing = Object.values(state.missions || {}).find((mission) => mission && mission.idempotency_key === order.key);
    if (existing) return { mission: existing, created: false };
    const mission = {
      id: `msn${crypto.createHash("sha256").update(`rlusd|${order.key}`).digest("hex").slice(0, 16)}`,
      idempotency_key: order.key,
      kind: KIND,
      status: "rlusd_reserved",
      role: "W1",
      account: bounds.ACCOUNT,
      hold: "uncertain",
      signed: false,
      submitted: false,
      sequence: shot.sequence,
      last_ledger_sequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
      fee_drops: shot.fee.toString(),
      outstanding_drops: order.exposure.toString(),
      realized_loss_drops: "0",
      realized_pnl_drops: "0",
      submit_attempted: false,
      updated_at: now,
      unsigned_tx: order.tx,
    };
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission, created: true };
  });
}

function save(dir, mission) {
  exclusive(dir, (api) => api.append({ type: "mission.upsert", at: mission.updated_at, mission }));
}

async function shotOf(ledger) {
  const server = await ledger.request({ command: "server_info" });
  const account = await ledger.request({ command: "account_info", account: bounds.ACCOUNT, ledger_index: "validated" });
  const fee = await ledger.request({ command: "fee" });
  return snapshot.parseSnapshot({ server, account, fee });
}

async function signTrade(clients, tx, expected) {
  return signer.sign(tx, expected, clients.sign);
}

async function tick(env, dir, now, clients, position) {
  if (!env || env.FOUNDRY_DEX_RLUSD !== "yes") return null;
  const observed = await load(clients.ledger);
  const state = view(dir, now);
  const room = headroom(position, state);
  const fields = {
    learning: false,
    traded: false,
    realized_pnl_drops: "0",
    rlusd_headroom_drops: room.headroom.toString(),
    aeth_exit_proposal: room.exit ? "w1-exit-sole-lp" : null,
    rlusd_trustline: observed.trustline,
  };
  if (room.exit) {
    return Object.assign(fields, {
      decision: "research",
      rationale: "RLUSD headroom is below one 1 XRP trade after the AETH high-water. The sole-LP exit is only a proposal.",
    });
  }
  const open = findOpen(state);
  if (open) return Object.assign(fields, await reconcile(dir, open, now, clients));
  const shot = await shotOf(clients.ledger);
  if (!observed.trustline) return Object.assign(fields, await trust(dir, now, clients, shot, room));
  return Object.assign(fields, await buy(dir, now, clients, shot, observed, room));
}

async function trust(dir, now, clients, shot, room) {
  const need = shot.reserveInc + shot.fee;
  if (room.headroom < need) {
    return { decision: "research", aeth_exit_proposal: "w1-exit-sole-lp", rationale: "The trust-line reserve does not fit the RLUSD headroom." };
  }
  const tx = {
    TransactionType: "TrustSet",
    Account: bounds.ACCOUNT,
    Flags: TF_SET_NO_RIPPLE,
    LimitAmount: { currency: CURRENCY, issuer: ISSUER, value: TRUST_LIMIT },
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const reserved = reserve(dir, { key: "w1-rlusd-trust", exposure: need, tx }, shot, now);
  if (reserved.mission.submit_attempted) return { decision: "trustline", replay: true, status: reserved.mission.status };
  const signed = await signTrade(clients, tx, {
    type: "TrustSet",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    flags: TF_SET_NO_RIPPLE,
    limit: TRUST_LIMIT,
  });
  const mission = Object.assign({}, reserved.mission, {
    signed: true,
    signed_hash: signed.hash,
    status: "rlusd_unknown",
    submit_attempted: true,
    updated_at: now,
  });
  try {
    await clients.submit(signed.tx_blob);
    mission.submitted = true;
  } catch (error) {
    mission.submitted = false;
  }
  save(dir, mission);
  return { decision: "trustline", signed: true, submitted: mission.submitted === true, traded: false, status: mission.status };
}

async function buy(dir, now, clients, shot, observed, room) {
  const spend = DEFAULT_TRADE_DROPS < room.headroom ? DEFAULT_TRADE_DROPS : room.headroom;
  if (spend > MAX_TRADE_DROPS || spend < DEFAULT_TRADE_DROPS) {
    return { decision: "research", rationale: "The next RLUSD trade would exceed the 2 XRP cap or the headroom." };
  }
  const priced = quoteBuy(observed.pool, spend);
  const resting = Object.values(view(dir, now).missions || {}).some((mission) => mission && mission.idempotency_key === "w1-rlusd-rest" && mission.hold !== "released");
  const bid = resting ? null : passiveBid(observed, spend);
  const tx = bid ? {
    TransactionType: "OfferCreate",
    Account: bounds.ACCOUNT,
    Flags: bounds.TF_PASSIVE,
    TakerGets: bid.taker_gets,
    TakerPays: bid.taker_pays,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  } : {
    TransactionType: "Payment",
    Account: bounds.ACCOUNT,
    Destination: bounds.ACCOUNT,
    Amount: { currency: CURRENCY, issuer: ISSUER, value: priced.deliver },
    SendMax: priced.sendMax.toString(),
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const key = bid ? "w1-rlusd-rest" : `w1-rlusd-buy-${shot.sequence}`;
  const exposure = (bid ? BigInt(bid.taker_gets) : priced.sendMax) + shot.fee + (bid ? shot.reserveInc : 0n);
  if (exposure > room.headroom) {
    return { decision: "research", aeth_exit_proposal: "w1-exit-sole-lp", rationale: "The RLUSD order does not fit the headroom." };
  }
  const reserved = reserve(dir, { key, exposure, tx }, shot, now);
  if (reserved.mission.submit_attempted) return { decision: bid ? "place" : "swap", replay: true, traded: false };
  const expected = bid ? {
    type: "OfferCreate",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    taker_gets: tx.TakerGets,
    taker_pays: tx.TakerPays,
  } : {
    type: "Payment",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    send_max: tx.SendMax,
    deliver: tx.Amount.value,
  };
  const signed = await signTrade(clients, tx, expected);
  const mission = Object.assign({}, reserved.mission, {
    signed: true,
    signed_hash: signed.hash,
    status: "rlusd_unknown",
    submit_attempted: true,
    updated_at: now,
  });
  try {
    await clients.submit(signed.tx_blob);
    mission.submitted = true;
  } catch (error) {
    mission.submitted = false;
  }
  save(dir, mission);
  return {
    decision: bid ? "place" : "swap",
    signed: true,
    submitted: mission.submitted === true,
    traded: false,
    send_max_drops: bid ? tx.TakerGets : tx.SendMax,
    deliver_min: bid ? tx.TakerPays.value : tx.Amount.value,
    status: mission.status,
  };
}

function passiveBid(observed, spend) {
  if (!observed.asks.length) return null;
  let best = null;
  for (const ask of observed.asks) {
    const rate = (ask.xrp * SCALE) / ask.rlusd;
    if (best == null || rate < best) best = rate;
  }
  const worse = (best * 99n) / 100n;
  const amm = (observed.pool.xrp * SCALE) / observed.pool.rlusd;
  const rate = worse < amm ? worse : (amm * 99n) / 100n;
  if (rate <= 0n || rate >= best) return null;
  const rlusd = (spend * SCALE) / rate;
  const text = formatAmount(rlusd);
  if (!text) return null;
  return { taker_gets: spend.toString(), taker_pays: { currency: CURRENCY, issuer: ISSUER, value: text } };
}

async function reconcile(dir, mission, now, clients) {
  if (!mission.signed_hash) return { decision: "reconcile", status: mission.status, traded: false };
  const lookup = await clients.ledger.request({ command: "tx", transaction: mission.signed_hash, binary: false });
  const result = lookup && lookup.result;
  if (!result || result.validated !== true || (result.meta || result.metaData || {}).TransactionResult !== "tesSUCCESS") {
    const kept = Object.assign({}, mission, { status: "rlusd_unknown", proof_reason: "unproved", updated_at: now });
    save(dir, kept);
    return { decision: "reconcile", status: "rlusd_unknown", traded: false, proof_reason: "unproved" };
  }
  const tx = result.tx_json || result;
  const hash = String(result.hash || "").toUpperCase();
  if (hash !== String(mission.signed_hash).toUpperCase() || tx.Sequence !== mission.sequence || tx.LastLedgerSequence !== mission.last_ledger_sequence || tx.Fee !== mission.fee_drops) {
    const kept = Object.assign({}, mission, { status: "rlusd_unknown", proof_reason: "bind", updated_at: now });
    save(dir, kept);
    return { decision: "reconcile", status: "rlusd_unknown", traded: false, proof_reason: "bind" };
  }
  const proved = Object.assign({}, mission, {
    status: "rlusd_proved",
    submitted: true,
    proof_hash: hash,
    updated_at: now,
  });
  save(dir, proved);
  return { decision: "reconcile", status: "rlusd_proved", traded: tx.TransactionType === "Payment", realized_pnl_drops: "0", proof_hash: hash };
}

module.exports = {
  ISSUER,
  CURRENCY,
  AMM,
  REGULAR_KEY,
  TRUST_LIMIT,
  MAX_TRADE_DROPS,
  DEFAULT_TRADE_DROPS,
  KIND,
  isRlusd,
  planTrustLine,
  quoteBuy,
  markInventory,
  load,
  tick,
};
