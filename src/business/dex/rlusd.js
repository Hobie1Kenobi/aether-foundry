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
const live = require("./live");

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

const MAX_TRADES_PER_TICK = 1;
const VANISH_TICKS = 3;
const MIN_TRADE_DROPS = 100000n;
const MAX_TRADES_PER_DAY = 2;
const TRUST_KEY = "w1-rlusd-trust";
const REST_KEY = "w1-rlusd-rest";
const TF_PARTIAL = 0x00020000;

function isRlusd(value) {
  if (!value || typeof value !== "object" || value.issuer !== ISSUER) return false;
  return value.currency === CURRENCY;
}

function exactOf(value) {
  if (!isRlusd(value)) return null;
  const exact = market.exactIou(value.value);
  if (!exact || exact.coeff <= 0n) return null;
  return exact;
}

function formatCoeff(coeff, exp) {
  if (coeff <= 0n) return null;
  let digits = coeff.toString();
  let point = exp;
  while (digits.endsWith("0") && digits.length > 1) {
    digits = digits.slice(0, -1);
    point += 1;
  }
  if (digits.length > 16) return null;
  if (point >= 0) return `${digits}${"0".repeat(point)}`;
  const index = digits.length + point;
  if (index > 0) return `${digits.slice(0, index)}.${digits.slice(index)}`;
  return `0.${"0".repeat(-index)}${digits}`;
}

function formatDiv(num, den, exp, round) {
  if (num <= 0n || den <= 0n) return null;
  const scale = 40;
  const shift = exp + scale;
  if (shift < 0 || shift > 90) return null;
  const product = num * (10n ** BigInt(shift));
  let scaled = product / den;
  if (round === "up" && product % den !== 0n) scaled += 1n;
  if (scaled <= 0n) return null;
  let digits = scaled.toString();
  let e = -scale;
  if (digits.length > 16) {
    const cut = digits.length - 16;
    let kept = BigInt(digits.slice(0, 16));
    if (round === "up" && /[1-9]/.test(digits.slice(16))) kept += 1n;
    digits = kept.toString();
    e += cut;
    if (digits.length > 16) {
      e += digits.length - 16;
      digits = digits.slice(0, 16);
    }
  }
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    e += 1;
  }
  const text = formatCoeff(BigInt(digits), e);
  if (!text || !market.exactIou(text)) return null;
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

function rateLess(xrpA, exactA, xrpB, exactB) {
  const scaleA = -exactA.exp;
  const scaleB = -exactB.exp;
  let left = xrpA * exactB.coeff;
  let right = xrpB * exactA.coeff;
  if (scaleA > scaleB) left *= 10n ** BigInt(scaleA - scaleB);
  else if (scaleB > scaleA) right *= 10n ** BigInt(scaleB - scaleA);
  return left < right;
}

function quoteBuy(pool, spendDrops) {
  if (!pool || pool.xrp <= 0n || !pool.exact || pool.exact.coeff <= 0n || spendDrops <= 0n) throw coded("RLUSD pool is not priced", "VALUATION");
  const fee = BigInt(pool.tradingFee);
  if (fee < 0n || fee >= 100000n) throw coded("RLUSD trading fee is missing", "VALUATION");
  const net = (spendDrops * (100000n - fee)) / 100000n;
  if (net <= 0n) throw coded("trade is smaller than the fee", "VALUATION");
  const text = formatDiv(pool.exact.coeff * net * 99n, (pool.xrp + net) * 100n, pool.exact.exp, "down");
  if (!text) throw coded("RLUSD deliver amount is empty", "VALUATION");
  return { sendMax: spendDrops, deliver: text };
}

function markInventory(pool, bids, balance) {
  if (!balance || balance.coeff === 0n) return { proved: true, xrp: 0n };
  const usable = (bids || []).filter((bid) => bid && outside(bid.account) && bid.xrp >= 1000000n && bid.xrp <= bankroll.BANKROLL_DROPS && bid.exact && bid.exact.coeff > 0n);
  if (!pool || !pool.exact || pool.exact.coeff <= 0n || usable.length === 0) return { proved: false, xrp: 0n };
  let best = usable[0];
  for (const bid of usable) {
    if (rateLess(best.xrp, best.exact, bid.xrp, bid.exact)) best = bid;
  }
  const mark = rateLess(pool.xrp, pool.exact, best.xrp, best.exact) ? pool : best;
  const num = balance.coeff * mark.xrp * HAIRCUT_NUM;
  const den = mark.exact.coeff * HAIRCUT_DEN;
  const shift = balance.exp - mark.exact.exp;
  if (shift >= 0) return { proved: true, xrp: (num * (10n ** BigInt(shift))) / den };
  return { proved: true, xrp: num / (den * (10n ** BigInt(-shift))) };
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
  const iouValue = body.amount2 && typeof body.amount2 === "object" ? body.amount2 : body.amount;
  const exact = exactOf(iouValue);
  const xrpSide = typeof body.amount === "string" ? xrp : (typeof body.amount2 === "string" ? BigInt(body.amount2) : null);
  if (xrpSide == null || !exact) throw coded("RLUSD pool assets cannot be valued", "VALUATION");
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
  const offers = await ledger.request({ command: "account_offers", account: bounds.ACCOUNT, ledger_index: "validated" });
  const ownPage = offers && offers.result;
  if (!ownPage || ownPage.validated !== true || ownPage.marker != null || !Array.isArray(ownPage.offers)) {
    throw coded("validated W1 offers are missing", "UNCERTAIN");
  }
  return {
    trustline: hasLine(page.lines),
    pool: { xrp: xrpSide, exact, tradingFee: body.trading_fee, account: body.account },
    bids: bookSide(bids.result.offers, "bid"),
    asks: bookSide(asks.result.offers, "ask"),
    own: ownPage.offers,
    balance: lineBalance(page.lines),
  };
}

function lineBalance(lines) {
  const held = (lines || []).filter((line) => line && isRlusd({ currency: line.currency, issuer: line.account, value: "0" }));
  if (held.length > 1) throw coded("RLUSD balance is ambiguous", "UNCERTAIN");
  if (held.length === 0) return { coeff: 0n, exp: 0 };
  if (typeof held[0].balance === "string" && held[0].balance.startsWith("-")) throw coded("RLUSD balance is debt", "UNCERTAIN");
  const exact = market.exactIou(held[0].balance || "0");
  if (!exact) throw coded("RLUSD balance cannot be valued", "UNCERTAIN");
  return exact;
}

function atLeast(left, right) {
  const span = Math.max(-left.exp, -right.exp, 0);
  const width = (exact, scale) => exact.coeff * (10n ** BigInt(scale + exact.exp));
  return width(left, span) >= width(right, span);
}

function bookSide(offers, side) {
  const rows = [];
  for (const row of offers) {
    if (!row || typeof row.Account !== "string") throw coded("RLUSD offer has no account", "UNCERTAIN");
    if (!outside(row.Account)) continue;
    const xrp = side === "bid" ? marketXrp(row.TakerGets) : marketXrp(row.TakerPays);
    const raw = side === "bid" ? row.TakerPays : row.TakerGets;
    const exact = exactOf(raw);
    if (xrp == null || !exact || xrp <= 0n) throw coded("RLUSD offer amount cannot be priced", "UNCERTAIN");
    rows.push({ account: row.Account, xrp, exact, value: raw.value });
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

function rowsOf(state) {
  return Object.values((state && state.missions) || {}).filter((mission) => mission && mission.kind === KIND);
}

function findPending(state) {
  return rowsOf(state).find((mission) => mission.hold !== "released" && mission.status !== "rlusd_resting" && mission.status !== "rlusd_proved" && mission.status !== "rlusd_filled" && mission.status !== "rlusd_partial" && mission.status !== "rlusd_vanished_unattributed" && mission.status !== "rlusd_cancelled" && mission.status !== "rlusd_expired") || null;
}

function findResting(state) {
  return rowsOf(state).find((mission) => mission.hold !== "released" && (mission.action === "rest" || mission.action === "replace" || mission.action === "sell") && (mission.status === "rlusd_resting" || mission.status === "rlusd_proved" || mission.status === "rlusd_partial")) || null;
}

function openExposure(state) {
  let open = 0n;
  for (const mission of rowsOf(state)) {
    if (mission.hold === "released") continue;
    if (mission.action === "trust" && mission.status === "rlusd_proved") continue;
    if (mission.action === "swap" && mission.status === "rlusd_proved") continue;
    if (mission.action === "cancel" && mission.status === "rlusd_proved") continue;
    open += BigInt(mission.outstanding_drops || "0");
  }
  return open;
}

function dayTrades(state, day) {
  return rowsOf(state).filter((mission) => mission.submit_attempted === true && mission.chicago_day === day && (mission.action === "rest" || mission.action === "swap" || mission.action === "replace" || mission.action === "sell")).length;
}

function reserve(dir, order, shot, now) {
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    if (state.killed) throw coded("hard stop is on", "killed");
    const existing = Object.values(state.missions || {}).find((mission) => mission && mission.idempotency_key === order.key);
    if (existing && existing.hold === "released" && existing.status === "rlusd_unsent" && existing.submit_attempted !== true) {
      const mission = Object.assign({}, existing, {
        hold: "uncertain",
        status: "rlusd_reserved",
        sequence: shot.sequence,
        last_ledger_sequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
        fee_drops: shot.fee.toString(),
        outstanding_drops: order.exposure.toString(),
        unsigned_tx: order.tx,
        proof_reason: null,
        updated_at: now,
      });
      api.append({ type: "mission.upsert", at: now, mission });
      return { mission, created: false };
    }
    if (existing) return { mission: existing, created: false, terminal: existing.status === "rlusd_cancelled" || existing.status === "rlusd_expired" || existing.status === "rlusd_filled" };
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
      action: order.action,
      chicago_day: order.day,
      sequence: shot.sequence,
      last_ledger_sequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
      fee_drops: shot.fee.toString(),
      outstanding_drops: order.exposure.toString(),
      realized_loss_drops: "0",
      realized_pnl_drops: "0",
      rlusd_baseline: order.baseline || null,
      cost_basis: order.cost_basis || null,
      cost_basis_drops: order.cost_basis_drops || null,
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

function offerSequence(row) {
  const seq = row && (row.seq != null ? row.seq : row.Sequence);
  return Number.isInteger(seq) ? seq : null;
}

function stillResting(observed, sequence) {
  return (observed.own || []).some((row) => offerSequence(row) === sequence);
}

function crosses(spend, exact, asks) {
  return (asks || []).some((ask) => !rateLess(spend, exact, ask.xrp, ask.exact));
}

async function tick(env, dir, now, clients, position) {
  if (!env || env.FOUNDRY_DEX_RLUSD !== "yes") return null;
  const observed = await load(clients.ledger);
  const state = view(dir, now);
  const room = headroom(position, state);
  const day = policy.chicagoDay(now);
  const gate = { signed: 0 };
  const fields = {
    learning: false,
    traded: false,
    realized_pnl_drops: "0",
    rlusd_headroom_drops: room.headroom.toString(),
    rlusd_open_drops: openExposure(state).toString(),
    aeth_exit_proposal: room.exit ? "w1-exit-sole-lp" : null,
    rlusd_trustline: observed.trustline,
  };
  if (room.exit) {
    return Object.assign(fields, {
      decision: "research",
      rationale: "RLUSD headroom is below one 1 XRP trade after the AETH high-water. The sole-LP exit is only a proposal.",
    });
  }
  const pending = findPending(state);
  if (pending) return Object.assign(fields, await reconcile(dir, pending, now, clients, observed));
  const resting = findResting(state);
  if (resting) return Object.assign(fields, await manageRest(dir, resting, now, clients, observed, room, day, gate));
  const inventory = findInventory(state);
  if (inventory) {
    const sold = await sellInventory(dir, inventory, now, clients, observed, room, gate);
    const tryBuy = inventory.status === "rlusd_vanished_unattributed" && sold.book === "no_bid" && sold.decision !== "place" && sold.signed !== true;
    if (!tryBuy) return Object.assign(fields, sold);
  }
  const shot = await shotOf(clients.ledger);
  if (!observed.trustline) return Object.assign(fields, await trust(dir, now, clients, shot, room, day, gate));
  return Object.assign(fields, await buy(dir, now, clients, shot, observed, room, day, gate));
}

async function submitSigned(dir, reserved, tx, expected, clients, now, gate) {
  if (reserved.mission.submit_attempted) return { mission: reserved.mission, replay: true };
  if (gate.signed >= MAX_TRADES_PER_TICK) throw coded("RLUSD already signed this tick", "CAP");
  gate.signed += 1;
  let signed;
  try {
    signed = await signTrade(clients, tx, expected);
  } catch (error) {
    save(dir, Object.assign({}, reserved.mission, {
      hold: "released",
      status: "rlusd_unsent",
      signed: false,
      submitted: false,
      outstanding_drops: "0",
      proof_reason: "not_submitted",
      updated_at: now,
    }));
    throw error;
  }
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
  return { mission, replay: false };
}

async function trust(dir, now, clients, shot, room, day, gate) {
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
  const reserved = reserve(dir, { key: TRUST_KEY, action: "trust", day, exposure: need, tx }, shot, now);
  const sent = await submitSigned(dir, reserved, tx, {
    type: "TrustSet",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    flags: TF_SET_NO_RIPPLE,
    limit: TRUST_LIMIT,
  }, clients, now, gate);
  if (sent.replay) return { decision: "trustline", replay: true, status: sent.mission.status, traded: false };
  return { decision: "trustline", signed: true, submitted: sent.mission.submitted === true, traded: false, status: sent.mission.status };
}

function withinCaps(state, day, exposure, room) {
  if (dayTrades(state, day) >= MAX_TRADES_PER_DAY) return false;
  if (openExposure(state) + exposure > MAX_TRADE_DROPS) return false;
  if (exposure > room.headroom) return false;
  return true;
}

function affordableSpend(state, room, shot) {
  const reserve = shot.reserveInc;
  const open = openExposure(state);
  const capRoom = MAX_TRADE_DROPS > open ? MAX_TRADE_DROPS - open : 0n;
  const bank = typeof room.headroom === "bigint" && room.headroom > 0n ? room.headroom : 0n;
  let budget = capRoom < bank ? capRoom : bank;
  if (budget <= reserve + shot.fee) return 0n;
  let spend = budget - reserve - shot.fee;
  if (spend > DEFAULT_TRADE_DROPS) spend = DEFAULT_TRADE_DROPS;
  if (spend < MIN_TRADE_DROPS) return 0n;
  return spend;
}

async function buy(dir, now, clients, shot, observed, room, day, gate) {
  const state = view(dir, now);
  if (findResting(state)) return { decision: "research", traded: false, rationale: "A RLUSD offer is still open." };
  const spend = affordableSpend(state, room, shot);
  if (spend < MIN_TRADE_DROPS) {
    return { decision: "research", rationale: "The next RLUSD trade would exceed the 2 XRP cap or the headroom." };
  }
  const bid = observed.asks.length ? passiveBid(observed, spend) : null;
  if (observed.asks.length && !bid) {
    return { decision: "research", traded: false, rationale: "No passive RLUSD bid sits under the outside ask." };
  }
  const priced = bid ? null : quoteBuy(observed.pool, spend);
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
    Flags: TF_PARTIAL,
    Amount: { currency: CURRENCY, issuer: ISSUER, value: priced.deliver },
    DeliverMin: { currency: CURRENCY, issuer: ISSUER, value: priced.deliver },
    SendMax: priced.sendMax.toString(),
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const action = bid ? "rest" : "swap";
  const key = bid ? (rowsOf(state).some((mission) => mission.idempotency_key === REST_KEY) ? `w1-rlusd-rest-${day}` : REST_KEY) : `w1-rlusd-swap-${day}`;
  const offerReserve = shot.reserveInc;
  const exposure = (bid ? BigInt(bid.taker_gets) : priced.sendMax) + shot.fee + (bid ? offerReserve : 0n);
  if (!withinCaps(state, day, exposure, room)) {
    return { decision: "research", aeth_exit_proposal: room.headroom < spend ? "w1-exit-sole-lp" : null, rationale: "Open RLUSD exposure is already at the 2 XRP cap." };
  }
  const baseline = !observed.balance || observed.balance.coeff === 0n ? "0" : formatCoeff(observed.balance.coeff, observed.balance.exp);
  const reserved = reserve(dir, { key, action: key.startsWith("w1-rlusd-rest-") ? "replace" : action, day, exposure, tx, baseline }, shot, now);
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
  const sent = await submitSigned(dir, reserved, tx, expected, clients, now, gate);
  if (sent.replay) return { decision: bid ? "place" : "swap", replay: true, traded: false };
  return {
    decision: bid ? "place" : "swap",
    signed: true,
    submitted: sent.mission.submitted === true,
    traded: false,
    send_max_drops: bid ? tx.TakerGets : tx.SendMax,
    deliver_min: bid ? tx.TakerPays.value : tx.DeliverMin.value,
    status: sent.mission.status,
  };
}

function findInventory(state) {
  const blocking = rowsOf(state).some((mission) => mission.action === "sell" && mission.hold !== "released" && (mission.status === "rlusd_resting" || mission.status === "rlusd_proved" || mission.status === "rlusd_partial" || mission.status === "rlusd_reserved" || mission.status === "rlusd_unknown"));
  if (blocking) return null;
  return rowsOf(state).find((mission) => mission.hold !== "released" && BigInt(mission.outstanding_drops || "0") > 0n && (mission.status === "rlusd_filled" || mission.status === "rlusd_vanished_unattributed" || mission.status === "rlusd_cancelled" || mission.status === "rlusd_expired")) || null;
}

function offerTouch(meta, sequence) {
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  for (const node of nodes) {
    const deleted = node && node.DeletedNode;
    const modified = node && node.ModifiedNode;
    const body = deleted || modified;
    if (!body || body.LedgerEntryType !== "Offer") continue;
    const final = body.FinalFields || {};
    const previous = body.PreviousFields || final;
    if (final.Account !== bounds.ACCOUNT && previous.Account !== bounds.ACCOUNT) continue;
    if (final.Sequence !== sequence && previous.Sequence !== sequence) continue;
    return { deleted: Boolean(deleted), final, previous };
  }
  return null;
}

function classifyTouch(tx, touch) {
  if (tx.TransactionType === "OfferCancel" && tx.Account === bounds.ACCOUNT && tx.OfferSequence === touch.final.Sequence) {
    return { klass: "cancelled", outside: false };
  }
  const expired = touch.deleted && Number.isInteger(touch.previous.Expiration) && tx.TransactionType !== "OfferCreate" && tx.TransactionType !== "Payment";
  if (expired) return { klass: "expired", outside: false };
  if (!touch.deleted) return { klass: "partial", outside: outside(tx.Account) };
  return { klass: outside(tx.Account) ? "filled" : "self", outside: outside(tx.Account) };
}

function fillPrice(drops, exact) {
  if (!exact || exact.coeff <= 0n || drops <= 0n) return null;
  return formatDiv(drops, exact.coeff, -exact.exp, "down");
}

async function ledgerRequest(clients, body) {
  return live.settledRequest((payload) => clients.ledger.request(payload), body);
}

async function historyOf(clients, mission) {
  let page;
  try {
    page = await ledgerRequest(clients, {
      command: "account_tx",
      account: bounds.ACCOUNT,
      ledger_index_min: mission.create_ledger || -1,
      binary: false,
      limit: 20,
    });
  } catch (error) {
    return { threw: true, transactions: [] };
  }
  const result = page && page.result;
  if (result && result.error) return { threw: true, transactions: [] };
  if (!result || result.validated !== true || !Array.isArray(result.transactions) || result.marker != null) {
    return { incomplete: true, transactions: [] };
  }
  return { missing: result.transactions.length === 0, transactions: result.transactions };
}

function subExact(left, right) {
  const span = Math.max(-left.exp, -right.exp, 0);
  const width = (exact) => exact.coeff * (10n ** BigInt(span + exact.exp));
  const diff = width(left) - width(right);
  if (diff < 0n) return null;
  if (diff === 0n) return { coeff: 0n, exp: 0 };
  let coeff = diff;
  let exp = -span;
  while (coeff % 10n === 0n) {
    coeff /= 10n;
    exp += 1;
  }
  return { coeff, exp };
}

function sameExact(left, right) {
  const delta = subExact(left, right);
  return Boolean(delta && delta.coeff === 0n);
}

function amountExact(value) {
  if (typeof value === "string") {
    if (value.startsWith("-")) return null;
    return market.exactIou(value);
  }
  return exactOf(value);
}

function rippleBaseline(meta) {
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  for (const node of nodes) {
    const body = node && (node.CreatedNode || node.ModifiedNode || node.DeletedNode);
    if (!body || body.LedgerEntryType !== "RippleState") continue;
    const fields = body.NewFields || body.FinalFields || {};
    const previous = body.PreviousFields || {};
    const high = fields.HighLimit || previous.HighLimit;
    const low = fields.LowLimit || previous.LowLimit;
    const currency = (high && high.currency) || (low && low.currency);
    const issuers = [high && high.issuer, low && low.issuer];
    if (currency !== CURRENCY || !issuers.includes(ISSUER)) continue;
    const raw = fields.Balance != null ? fields.Balance : previous.Balance;
    return amountExact(raw);
  }
  return null;
}

function ledgerRanges(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const ranges = [];
  for (const part of text.split(",")) {
    const match = part.trim().match(/^(\d+)-(\d+)$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
    ranges.push([start, end]);
  }
  return ranges.length ? ranges : null;
}

function historyDropped(ranges, ledger) {
  if (!ranges || !ranges.length || !Number.isInteger(ledger)) return false;
  const oldest = ranges.reduce((low, range) => Math.min(low, range[0]), ranges[0][0]);
  return ledger < oldest;
}

function provedLedger(mission) {
  if (mission && Number.isInteger(mission.validated_ledger)) return mission.validated_ledger;
  return null;
}

async function readRanges(clients) {
  try {
    const server = await clients.ledger.request({ command: "server_info" });
    const text = server && server.result && server.result.info && server.result.info.complete_ledgers;
    return ledgerRanges(text);
  } catch (error) {
    return null;
  }
}

async function inspectTx(clients, hash, mission, ranges) {
  let lookup;
  try {
    lookup = await ledgerRequest(clients, { command: "tx", transaction: hash, binary: false });
  } catch (error) {
    return { unknown: true };
  }
  const result = lookup && lookup.result;
  const meta = result && (result.meta || result.metaData);
  if (result && result.validated === true && meta && meta.TransactionResult === "tesSUCCESS") {
    return { live: true, result, meta, tx: result.tx_json || result };
  }
  if (result && result.error === "txnNotFound") {
    if (historyDropped(ranges, provedLedger(mission))) return { notFound: true, pruned: true };
    return { notFound: true, unproved: true };
  }
  return { unproved: true };
}

function storedCreate(mission, hash) {
  const tx = mission && mission.unsigned_tx;
  const signed = String(mission && mission.signed_hash || "").toUpperCase();
  const proof = String(mission && mission.proof_hash || "").toUpperCase();
  if (!tx || proof !== signed || signed !== String(hash || "").toUpperCase() || !/^[0-9A-F]{64}$/.test(signed)) return false;
  if (mission.proof_result !== "tesSUCCESS" || !Number.isInteger(mission.validated_ledger)) return false;
  if (mission.status !== "rlusd_resting" && mission.status !== "rlusd_proved") return false;
  if (tx.TransactionType !== "OfferCreate" || tx.Account !== bounds.ACCOUNT || tx.Sequence !== mission.sequence) return false;
  if (!tx.TakerPays || tx.TakerPays.currency !== CURRENCY || tx.TakerPays.issuer !== ISSUER) return false;
  return Boolean(exactOf(tx.TakerPays) && marketXrp(tx.TakerGets) != null);
}

function laterRlusd(state, resting) {
  return rowsOf(state).some((mission) => {
    if (!mission || mission.id === resting.id || mission.action === "trust" || mission.action === "cancel") return false;
    return mission.action === "swap" || mission.action === "sell" || mission.action === "replace" || mission.status === "rlusd_filled" || mission.status === "rlusd_partial";
  });
}

function reconciledTrust(trust) {
  if (!trust || trust.proof_result !== "tesSUCCESS" || !Number.isInteger(trust.validated_ledger)) return null;
  const signed = String(trust.signed_hash || "").toUpperCase();
  const proof = String(trust.proof_hash || "").toUpperCase();
  if (proof !== signed || !/^[0-9A-F]{64}$/.test(signed)) return null;
  const tx = trust.unsigned_tx;
  if (!tx || tx.TransactionType !== "TrustSet" || tx.Account !== bounds.ACCOUNT || tx.Sequence !== trust.sequence) return null;
  if (!tx.LimitAmount || tx.LimitAmount.currency !== CURRENCY || tx.LimitAmount.issuer !== ISSUER) return null;
  if (typeof trust.proof_balance !== "string") return null;
  return market.exactIou(trust.proof_balance);
}

async function provedBaseline(dir, resting, now, clients, ranges) {
  const trust = rowsOf(view(dir, now)).find((mission) => mission.action === "trust" && mission.signed_hash && Number.isInteger(mission.sequence) && mission.sequence + 1 === resting.sequence);
  if (!trust) return null;
  const seen = await inspectTx(clients, trust.signed_hash, trust, ranges);
  if (seen.unknown) return null;
  if (seen.live) {
    const tx = seen.tx;
    if (!tx || tx.TransactionType !== "TrustSet" || tx.Sequence !== trust.sequence || tx.Account !== bounds.ACCOUNT) return null;
    if (!tx.LimitAmount || tx.LimitAmount.currency !== CURRENCY || tx.LimitAmount.issuer !== ISSUER) return null;
    return rippleBaseline(seen.meta);
  }
  if (seen.pruned) return reconciledTrust(trust);
  return null;
}

function partialDelta(touch) {
  const beforeXrp = marketXrp(touch.previous && touch.previous.TakerGets);
  const afterXrp = marketXrp(touch.final && touch.final.TakerGets);
  const beforeIou = amountExact(touch.previous && touch.previous.TakerPays);
  const afterIou = amountExact(touch.final && touch.final.TakerPays);
  if (beforeXrp == null || afterXrp == null || afterXrp >= beforeXrp || !beforeIou || !afterIou) return null;
  const consumed = subExact(beforeIou, afterIou);
  if (!consumed || consumed.coeff <= 0n) return null;
  return { consumedXrp: beforeXrp - afterXrp, remainingXrp: afterXrp, consumed };
}

function reserveIncrement(info) {
  const text = info && info.validated_ledger && info.validated_ledger.reserve_inc_xrp;
  const raw = typeof text === "number" ? text.toString() : text;
  if (typeof raw !== "string" || !/^\d+(\.\d{1,6})?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const drops = BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
  return drops > 0n ? drops : null;
}

function absenceLedgers(prior, seq) {
  const list = Array.isArray(prior) ? prior.filter((item) => Number.isInteger(item)) : [];
  if (!list.length || seq < list[list.length - 1]) return [seq];
  if (seq === list[list.length - 1]) return list;
  return list.concat(seq);
}

async function noteAbsence(dir, resting, now, clients, observed) {
  let server;
  try {
    server = await clients.ledger.request({ command: "server_info" });
  } catch (error) {
    return { decision: "research", traded: false, signed: false, rationale: "The validated ledger is missing. The offer exposure stays open." };
  }
  const info = server && server.result && server.result.info;
  const seq = info && info.validated_ledger && info.validated_ledger.seq;
  const reserve = reserveIncrement(info);
  if (!Number.isInteger(seq) || seq <= 0 || reserve == null) {
    return { decision: "research", traded: false, signed: false, rationale: "The validated ledger is missing. The offer exposure stays open." };
  }
  const ledgers = absenceLedgers(resting.absence_ledgers, seq).slice(0, VANISH_TICKS);
  if (ledgers.length < VANISH_TICKS) {
    save(dir, Object.assign({}, resting, { absence_ledgers: ledgers, updated_at: now }));
    return { decision: "research", traded: false, signed: false, learning: false, absence_ledgers: ledgers.length, rationale: "The offer is absent from this validated ledger. History cannot attribute it yet, so the exposure stays open." };
  }
  const marked = markInventory(observed.pool, observed.bids, observed.balance);
  if (!marked.proved) {
    save(dir, Object.assign({}, resting, { absence_ledgers: ledgers, updated_at: now }));
    return { decision: "research", traded: false, signed: false, learning: false, rationale: "The offer is absent, and the current RLUSD balance cannot be marked. Exposure stays open." };
  }
  const text = observed.balance.coeff === 0n ? "0" : formatCoeff(observed.balance.coeff, observed.balance.exp);
  const open = marked.xrp;
  const next = Object.assign({}, resting, {
    status: "rlusd_vanished_unattributed",
    proof_type: "state_only",
    outside_fill: false,
    counterparty: null,
    realized_pnl_drops: "0",
    inventory_rlusd: text,
    inventory_drops: marked.xrp.toString(),
    outstanding_drops: open.toString(),
    absence_ledgers: ledgers,
    updated_at: now,
  });
  save(dir, next);
  return {
    decision: "reconcile",
    traded: false,
    signed: false,
    learning: false,
    status: "rlusd_vanished_unattributed",
    proof_type: "state_only",
    outside_fill: false,
    counterparty: null,
    realized_pnl_drops: "0",
    fill_rlusd: text,
    inventory_drops: marked.xrp.toString(),
    rationale: "The offer is absent from three validated ledgers and history cannot attribute it. Exposure is the current RLUSD balance mark. The existing trust line is not reserved again.",
  };
}

function sellPartial(touch) {
  const beforeIou = amountExact(touch.previous && touch.previous.TakerGets);
  const afterIou = amountExact(touch.final && touch.final.TakerGets);
  const beforeXrp = marketXrp(touch.previous && touch.previous.TakerPays);
  const afterXrp = marketXrp(touch.final && touch.final.TakerPays);
  if (beforeXrp == null || afterXrp == null || afterXrp >= beforeXrp || !beforeIou || !afterIou) return null;
  const consumed = subExact(beforeIou, afterIou);
  if (!consumed || consumed.coeff <= 0n) return null;
  const raw = touch.final && touch.final.TakerGets && typeof touch.final.TakerGets === "object" ? touch.final.TakerGets.value : null;
  const text = formatCoeff(afterIou.coeff, afterIou.exp) || raw;
  if (!text) return null;
  return { consumed, remaining: text, remainingExact: afterIou, receivedXrp: beforeXrp - afterXrp };
}

function parkInventory(dir, resting, now, observed, status, proof) {
  const marked = !observed.balance || observed.balance.coeff === 0n ? { proved: true, xrp: 0n } : markInventory(observed.pool, observed.bids, observed.balance);
  if (!marked.proved) {
    return { decision: "research", traded: false, signed: false, rationale: "The RLUSD sell ended, and the balance cannot be marked. Exposure stays open." };
  }
  const text = !observed.balance || observed.balance.coeff === 0n ? "0" : formatCoeff(observed.balance.coeff, observed.balance.exp);
  const source = rowsOf(view(dir, now)).find((mission) => mission.id !== resting.id && mission.hold !== "released" && (mission.status === "rlusd_vanished_unattributed" || mission.status === "rlusd_filled"));
  if (source) {
    save(dir, Object.assign({}, source, {
      inventory_rlusd: text,
      inventory_drops: marked.xrp.toString(),
      outstanding_drops: marked.xrp.toString(),
      updated_at: now,
    }));
    save(dir, Object.assign({}, resting, {
      hold: "released",
      status,
      outstanding_drops: "0",
      proof_type: proof.type,
      proof_hash: proof.hash,
      outside_fill: false,
      counterparty: null,
      realized_pnl_drops: "0",
      updated_at: now,
    }));
  } else {
    save(dir, Object.assign({}, resting, {
      status,
      proof_type: proof.type,
      proof_hash: proof.hash,
      outside_fill: false,
      counterparty: null,
      realized_pnl_drops: "0",
      inventory_rlusd: text,
      inventory_drops: marked.xrp.toString(),
      outstanding_drops: marked.xrp.toString(),
      updated_at: now,
    }));
  }
  return {
    decision: "reconcile",
    traded: false,
    signed: false,
    learning: false,
    status,
    fill_class: proof.klass,
    proof_type: proof.type,
    fill_hash: proof.hash,
    outside_fill: false,
    counterparty: null,
    realized_pnl_drops: "0",
    inventory_drops: marked.xrp.toString(),
    inventory_rlusd: text,
  };
}

async function offerReserveNow(clients) {
  try {
    const server = await clients.ledger.request({ command: "server_info" });
    return reserveIncrement(server && server.result && server.result.info);
  } catch (error) {
    return null;
  }
}

async function proveSell(dir, resting, now, clients, observed) {
  const reserved = resting.unsigned_tx || {};
  const received = marketXrp(reserved.TakerPays);
  const sold = exactOf(reserved.TakerGets);
  if (received == null || !sold) {
    return { decision: "research", traded: false, signed: false, rationale: "The RLUSD sell amounts are not proved." };
  }
  const history = await historyOf(clients, resting);
  if (history.threw || history.incomplete) {
    return { decision: "research", traded: false, signed: false, rationale: "RLUSD history is not a validated page. Exposure stays open." };
  }
  const hits = [];
  for (const entry of history.transactions) {
    const tx = entry.tx_json || entry.tx || entry;
    const meta = entry.meta || entry.metaData || (entry.result && entry.result.meta);
    const touch = offerTouch(meta, resting.sequence);
    if (!touch) continue;
    const hash = String(entry.hash || tx.hash || "").toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hash)) continue;
    hits.push({ tx, meta, hash, touch, klass: classifyTouch(tx, touch) });
  }
  const held = { decision: "research", traded: false, signed: false, rationale: "The RLUSD sell is not yet attributed. Exposure stays open." };
  if (hits.length > 1) {
    return { decision: "research", traded: false, signed: false, proof_reason: "uncertain", rationale: "More than one validated trade touches the RLUSD sell. Exposure stays open." };
  }
  if (hits.length === 1 && resting.proof_hash === hits[0].hash && resting.status === "rlusd_partial") {
    return { decision: "research", traded: false, signed: false, status: "rlusd_partial", outstanding_drops: resting.outstanding_drops, rationale: "The partial RLUSD sell is already booked." };
  }
  if (hits.length === 1 && hits[0].klass.klass === "partial") {
    const hit = hits[0];
    const delta = sellPartial(hit.touch);
    const reserve = await offerReserveNow(clients);
    const marked = delta ? markInventory(observed.pool, observed.bids, delta.remainingExact) : null;
    if (!delta || reserve == null || !marked || !marked.proved) return held;
    const open = reserve + marked.xrp;
    const next = Object.assign({}, resting, {
      status: "rlusd_partial",
      fill_class: "partial",
      proof_type: "consuming_tx",
      proof_hash: hit.hash,
      counterparty: hit.klass.outside ? hit.tx.Account : null,
      outside_fill: hit.klass.outside === true,
      remaining_rlusd: delta.remaining,
      inventory_drops: marked.xrp.toString(),
      outstanding_drops: open.toString(),
      realized_pnl_drops: "0",
      updated_at: now,
    });
    save(dir, next);
    return {
      decision: "reconcile",
      traded: false,
      signed: false,
      learning: false,
      status: "rlusd_partial",
      fill_class: "partial",
      proof_type: "consuming_tx",
      fill_hash: hit.hash,
      outside_fill: next.outside_fill,
      counterparty: next.counterparty,
      remaining_rlusd: delta.remaining,
      inventory_drops: marked.xrp.toString(),
      outstanding_drops: open.toString(),
      realized_pnl_drops: "0",
      rationale: "A validated trade consumed part of the RLUSD sell. The remainder stays open at its mark plus the owner reserve.",
    };
  }
  if (hits.length === 1 && (hits[0].klass.klass === "cancelled" || hits[0].klass.klass === "expired")) {
    const hit = hits[0];
    const status = hit.klass.klass === "cancelled" ? "rlusd_cancelled" : "rlusd_expired";
    return parkInventory(dir, resting, now, observed, status, { klass: hit.klass.klass, type: "consuming_tx", hash: hit.hash });
  }
  if (hits.length === 1 && (hits[0].klass.klass === "filled" || hits[0].klass.klass === "self")) {
    const hit = hits[0];
    const outsideFill = hit.klass.outside === true && hit.klass.klass === "filled";
    const basis = resting.cost_basis === "state_only_mark" ? BigInt(resting.cost_basis_drops || "0") : null;
    const pnl = outsideFill && basis != null ? received - basis : 0n;
    const next = Object.assign({}, resting, {
      status: "rlusd_filled",
      fill_class: hit.klass.klass,
      proof_type: "consuming_tx",
      proof_hash: hit.hash,
      outside_fill: outsideFill,
      counterparty: outsideFill ? hit.tx.Account : null,
      cost_basis: resting.cost_basis || null,
      realized_pnl_drops: pnl.toString(),
      outstanding_drops: "0",
      updated_at: now,
    });
    save(dir, next);
    return {
      decision: "reconcile",
      traded: outsideFill,
      signed: false,
      learning: false,
      status: "rlusd_filled",
      fill_class: hit.klass.klass,
      proof_type: "consuming_tx",
      outside_fill: outsideFill,
      counterparty: next.counterparty,
      cost_basis: next.cost_basis,
      realized_pnl_drops: pnl.toString(),
      fill_xrp_drops: received.toString(),
      fill_hash: hit.hash,
    };
  }
  if (hits.length === 0) {
    const ranges = await readRanges(clients);
    const dropped = historyDropped(ranges, provedLedger(resting));
    let seen = { unproved: true };
    if (!history.threw && !history.incomplete) seen = await inspectTx(clients, resting.signed_hash, resting, ranges);
    const emptyOrPrunedUntouched = history.missing || dropped;
    if (!seen.unknown && seen.notFound === true && emptyOrPrunedUntouched) {
      return noteAbsence(dir, resting, now, clients, observed);
    }
  }
  return held;
}

async function proveFill(dir, resting, now, clients, observed) {
  if (resting.action === "sell") return proveSell(dir, resting, now, clients, observed);
  const reserved = resting.unsigned_tx || {};
  const pays = exactOf(reserved.TakerPays);
  const spent = marketXrp(reserved.TakerGets);
  if (!pays || spent == null) {
    return { decision: "research", traded: false, rationale: "The resting RLUSD offer is not on the book and its amounts are not proved." };
  }
  const history = await historyOf(clients, resting);
  if (history.threw || history.incomplete) {
    return { decision: "research", traded: false, signed: false, rationale: "RLUSD history is not a validated page. Exposure stays open." };
  }
  const hits = [];
  for (const entry of history.transactions) {
    const tx = entry.tx_json || entry.tx || entry;
    const meta = entry.meta || entry.metaData || (entry.result && entry.result.meta);
    const touch = offerTouch(meta, resting.sequence);
    if (!touch) continue;
    const hash = String(entry.hash || tx.hash || "").toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hash)) continue;
    hits.push({ tx, meta, hash, touch, klass: classifyTouch(tx, touch) });
  }
  if (hits.length > 1) {
    return { decision: "research", traded: false, proof_reason: "uncertain", rationale: "More than one validated trade touches the resting RLUSD offer. Exposure stays open." };
  }
  if (hits.length === 1 && resting.proof_hash === hits[0].hash && resting.status === "rlusd_partial") {
    return { decision: "research", traded: false, signed: false, status: "rlusd_partial", remaining_drops: resting.remaining_drops, inventory_drops: resting.inventory_drops, rationale: "The partial RLUSD fill is already booked." };
  }
  const held = { decision: "research", traded: false, signed: false, rationale: "The resting RLUSD offer is not on the book and has no proved cancel. Its exposure stays open." };
  if (hits.length === 1 && hits[0].klass.klass === "partial") {
    const hit = hits[0];
    const delta = partialDelta(hit.touch);
    if (!delta || !atLeast(observed.balance, delta.consumed)) return held;
    const marked = markInventory(observed.pool, observed.bids, delta.consumed);
    const inventory = marked.proved ? marked.xrp : delta.consumedXrp;
    let reserve = null;
    try {
      const server = await clients.ledger.request({ command: "server_info" });
      reserve = reserveIncrement(server && server.result && server.result.info);
    } catch (error) {
      reserve = null;
    }
    if (reserve == null) return held;
    const open = delta.remainingXrp + inventory + reserve;
    if (open > MAX_TRADE_DROPS) return held;
    const text = formatCoeff(delta.consumed.coeff, delta.consumed.exp);
    const next = Object.assign({}, resting, {
      status: "rlusd_partial",
      fill_class: "partial",
      proof_type: "consuming_tx",
      proof_hash: hit.hash,
      counterparty: hit.klass.outside ? hit.tx.Account : null,
      outside_fill: hit.klass.outside === true,
      inventory_rlusd: text,
      inventory_drops: inventory.toString(),
      remaining_drops: delta.remainingXrp.toString(),
      outstanding_drops: open.toString(),
      realized_pnl_drops: "0",
      updated_at: now,
    });
    save(dir, next);
    return {
      decision: "reconcile",
      traded: hit.klass.outside === true,
      signed: false,
      learning: false,
      status: "rlusd_partial",
      fill_class: "partial",
      proof_type: "consuming_tx",
      fill_hash: hit.hash,
      counterparty: next.counterparty,
      outside_fill: next.outside_fill,
      fill_xrp_drops: delta.consumedXrp.toString(),
      remaining_drops: delta.remainingXrp.toString(),
      fill_rlusd: text,
      fill_price: fillPrice(delta.consumedXrp, delta.consumed),
      inventory_drops: inventory.toString(),
      rationale: "A validated trade consumed part of the resting RLUSD offer. The remainder stays open.",
    };
  }
  let proof = null;
  if (hits.length === 1) {
    const hit = hits[0];
    if (hit.klass.klass !== "cancelled" && hit.klass.klass !== "expired" && !atLeast(observed.balance, pays)) return held;
    proof = {
      klass: hit.klass.klass,
      outside: hit.klass.outside,
      hash: hit.hash,
      counterparty: hit.tx.Account === bounds.ACCOUNT ? null : hit.tx.Account,
      type: "consuming_tx",
    };
  } else if (hits.length === 0) {
    const ranges = await readRanges(clients);
    const dropped = historyDropped(ranges, provedLedger(resting));
    let seen = { unproved: true };
    if (!history.threw && !history.incomplete) seen = await inspectTx(clients, resting.signed_hash, resting, ranges);
    if (history.missing && dropped && !laterRlusd(view(dir, now), resting) && !seen.unknown) {
      const baseline = await provedBaseline(dir, resting, now, clients, ranges);
      const delta = baseline ? subExact(observed.balance, baseline) : null;
      if (baseline && delta && sameExact(delta, pays)) {
        if (seen.live && binds(resting, seen.tx, seen.meta)) {
          proof = { klass: "filled", outside: false, hash: null, counterparty: null, type: "balance_delta" };
        } else if (seen.pruned && storedCreate(resting, resting.signed_hash)) {
          proof = { klass: "filled", outside: false, hash: null, counterparty: null, type: "stored_journal" };
        }
      }
    }
    const emptyOrPrunedUntouched = history.missing || (hits.length === 0 && dropped);
    if (!proof && !seen.unknown && seen.notFound === true && emptyOrPrunedUntouched) {
      return noteAbsence(dir, resting, now, clients, observed);
    }
  }
  if (!proof) return held;
  if (proof.klass === "cancelled" || proof.klass === "expired") {
    const status = proof.klass === "cancelled" ? "rlusd_cancelled" : "rlusd_expired";
    save(dir, Object.assign({}, resting, { hold: "released", status, outstanding_drops: "0", updated_at: now, proof_type: proof.type, proof_hash: proof.hash, outside_fill: false }));
    return { decision: "reconcile", traded: false, signed: false, learning: false, status, fill_class: proof.klass, proof_type: proof.type, fill_hash: proof.hash, outside_fill: false };
  }
  const marked = markInventory(observed.pool, observed.bids, pays);
  const inventory = marked.proved ? marked.xrp : spent;
  const pnl = proof.outside && marked.proved ? inventory - spent : 0n;
  const next = Object.assign({}, resting, {
    status: "rlusd_filled",
    fill_class: proof.klass,
    proof_type: proof.type,
    proof_hash: proof.hash,
    counterparty: proof.outside ? proof.counterparty : null,
    outside_fill: proof.outside === true,
    inventory_rlusd: reserved.TakerPays.value,
    outstanding_drops: inventory.toString(),
    realized_pnl_drops: pnl.toString(),
    updated_at: now,
  });
  save(dir, next);
  return {
    decision: "reconcile",
    traded: proof.outside === true,
    signed: false,
    learning: false,
    status: "rlusd_filled",
    fill_class: proof.klass,
    proof_type: proof.type,
    fill_hash: proof.hash,
    counterparty: proof.outside ? proof.counterparty : null,
    outside_fill: proof.outside === true,
    fill_xrp_drops: spent.toString(),
    fill_rlusd: reserved.TakerPays.value,
    fill_price: fillPrice(spent, pays),
    realized_pnl_drops: pnl.toString(),
    inventory_drops: inventory.toString(),
    rationale: proof.type === "stored_journal"
      ? "The server no longer keeps the create ledger. The stored placement proof and the exact balance change book the fill."
      : proof.type === "balance_delta"
        ? "The RLUSD balance rose from the proved baseline by the offer amount. History returned a validated empty page."
        : "A validated trade consumed the resting RLUSD offer.",
  };
}

function xrpFor(balance, exact, xrp, numerator, denominator) {
  const shift = balance.exp - exact.exp;
  const num = balance.coeff * xrp * numerator;
  const den = exact.coeff * denominator;
  if (den <= 0n) return 0n;
  return shift >= 0 ? (num * (10n ** BigInt(shift))) / den : num / (den * (10n ** BigInt(-shift)));
}

function dropsAbove(balance, exact, xrp) {
  let drops = xrpFor(balance, exact, xrp, 1n, 1n);
  for (let step = 0; step < 8 && !rateLess(xrp, exact, drops, balance); step += 1) drops += 1n;
  if (!rateLess(xrp, exact, drops, balance)) return null;
  return drops;
}

function dropsAtOrBelow(balance, exact, xrp) {
  let drops = xrpFor(balance, exact, xrp, 1n, 1n);
  if (rateLess(xrp, exact, drops, balance) && drops > 0n) drops -= 1n;
  if (drops <= 0n || rateLess(xrp, exact, drops, balance)) return null;
  return drops;
}

function passiveSell(observed, balance) {
  const bids = (observed.bids || []).filter((bid) => bid && outside(bid.account));
  const asks = (observed.asks || []).filter((ask) => ask && outside(ask.account));
  if (!bids.length || !asks.length || !balance || balance.coeff <= 0n) return null;
  let bestBid = bids[0];
  for (const bid of bids) {
    if (rateLess(bestBid.xrp, bestBid.exact, bid.xrp, bid.exact)) bestBid = bid;
  }
  let bestAsk = asks[0];
  for (const ask of asks) {
    if (rateLess(ask.xrp, ask.exact, bestAsk.xrp, bestAsk.exact)) bestAsk = ask;
  }
  const floor = dropsAbove(balance, bestBid.exact, bestBid.xrp);
  const ceiling = dropsAtOrBelow(balance, bestAsk.exact, bestAsk.xrp);
  if (floor == null || ceiling == null || floor > ceiling) return null;
  let drops = xrpFor(balance, bestBid.exact, bestBid.xrp, 101n, 100n);
  if (drops < floor) drops = floor;
  if (drops > ceiling) drops = ceiling;
  if (drops <= 0n || drops > MAX_TRADE_DROPS) return null;
  if (!rateLess(bestBid.xrp, bestBid.exact, drops, balance)) return null;
  if (rateLess(bestAsk.xrp, bestAsk.exact, drops, balance)) return null;
  const text = formatCoeff(balance.coeff, balance.exp);
  if (!text) return null;
  return { taker_gets: { currency: CURRENCY, issuer: ISSUER, value: text }, taker_pays: drops.toString() };
}

async function sellInventory(dir, mission, now, clients, observed, room, gate) {
  const today = policy.chicagoDay(now);
  const state = view(dir, now);
  if (dayTrades(state, today) >= MAX_TRADES_PER_DAY) {
    return { decision: "research", traded: false, rationale: "The Chicago day already has its RLUSD orders. The inventory is not sold." };
  }
  const outsideBids = (observed.bids || []).filter((bid) => bid && outside(bid.account));
  const outsideAsks = (observed.asks || []).filter((ask) => ask && outside(ask.account));
  if (!outsideBids.length || !outsideAsks.length) {
    return {
      decision: "research",
      traded: false,
      signed: false,
      book: outsideAsks.length ? "no_bid" : "no_ask",
      rationale: "No passive RLUSD exit sits between the outside bid and the outside ask.",
    };
  }
  const offer = passiveSell(observed, observed.balance);
  if (!offer) return { decision: "research", traded: false, signed: false, rationale: "No passive RLUSD exit sits between the outside bid and the outside ask." };
  const shot = await shotOf(clients.ledger);
  const offerReserve = shot.reserveInc;
  const exposure = shot.fee + offerReserve;
  if (exposure > room.headroom) {
    return { decision: "research", traded: false, rationale: "The RLUSD exit reserve does not fit the bankroll headroom." };
  }
  const marked = markInventory(observed.pool, observed.bids, observed.balance);
  if (!marked.proved || marked.xrp < offerReserve) {
    return { decision: "research", traded: false, signed: false, book: "dust", rationale: "The RLUSD inventory mark is below the offer reserve. It is not sold." };
  }
  const previous = openExposure(state);
  const nextOpen = previous - BigInt(mission.outstanding_drops || "0") + exposure;
  if (nextOpen > previous && nextOpen > MAX_TRADE_DROPS) {
    return { decision: "research", traded: false, signed: false, rationale: "The RLUSD exit does not fit the 2 XRP open cap." };
  }
  const tx = {
    TransactionType: "OfferCreate",
    Account: bounds.ACCOUNT,
    Flags: bounds.TF_PASSIVE,
    TakerGets: offer.taker_gets,
    TakerPays: offer.taker_pays,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const finished = (row) => row && (row.status === "rlusd_cancelled" || row.status === "rlusd_expired" || row.status === "rlusd_filled" || row.submit_attempted === true);
  const baseKey = `w1-rlusd-sell-${today}`;
  const baseRow = rowsOf(state).find((row) => row.idempotency_key === baseKey);
  const key = !finished(baseRow) ? baseKey : `${baseKey}-${shot.sequence}`;
  const prior = rowsOf(state).find((row) => row.idempotency_key === key);
  if (finished(prior)) {
    return { decision: "research", traded: false, signed: false, replay: false, rationale: "A finished RLUSD sell already uses this Chicago day key. Exposure is unchanged." };
  }
  const basis = mission.proof_type === "state_only" || mission.status === "rlusd_vanished_unattributed" || mission.status === "rlusd_cancelled" || mission.status === "rlusd_expired" ? "state_only_mark" : null;
  const reserved = reserve(dir, {
    key,
    action: "sell",
    day: today,
    exposure,
    tx,
    cost_basis: basis,
    cost_basis_drops: mission.inventory_drops || mission.outstanding_drops || null,
  }, shot, now);
  if (reserved.terminal || reserved.mission.submit_attempted === true) {
    return { decision: "research", traded: false, signed: false, replay: true, rationale: "The RLUSD sell key already finished. Exposure is unchanged." };
  }
  save(dir, Object.assign({}, mission, { outstanding_drops: "0", updated_at: now }));
  let sent;
  try {
    sent = await submitSigned(dir, reserved, tx, {
      type: "OfferCreate",
      account: bounds.ACCOUNT,
      sequence: shot.sequence,
      last: tx.LastLedgerSequence,
      fee: shot.fee.toString(),
      taker_gets: tx.TakerGets,
      taker_pays: tx.TakerPays,
    }, clients, now, gate);
  } catch (error) {
    save(dir, Object.assign({}, mission, { outstanding_drops: mission.outstanding_drops, updated_at: now }));
    throw error;
  }
  if (sent.replay) {
    save(dir, Object.assign({}, mission, { outstanding_drops: mission.outstanding_drops, updated_at: now }));
    return { decision: "research", traded: false, signed: false, replay: true, rationale: "The RLUSD sell key already finished. Exposure is unchanged." };
  }
  return { decision: "place", signed: true, submitted: sent.mission.submitted === true, traded: false, replay: false, send_max_drops: tx.TakerPays, deliver_min: tx.TakerGets.value };
}

async function manageRest(dir, resting, now, clients, observed, room, day, gate) {
  const sequence = resting.sequence;
  if (!stillResting(observed, sequence)) {
    if (resting.action !== "sell") {
      const cancelled = rowsOf(view(dir, now)).find((mission) => mission.action === "cancel" && mission.status === "rlusd_proved" && mission.unsigned_tx && mission.unsigned_tx.OfferSequence === sequence);
      if (cancelled) {
        save(dir, Object.assign({}, resting, { hold: "released", status: "rlusd_cancelled", outstanding_drops: "0", updated_at: now }));
        return { decision: "reconcile", traded: false, status: "rlusd_cancelled" };
      }
    }
    return proveFill(dir, resting, now, clients, observed);
  }
  if (Array.isArray(resting.absence_ledgers) && resting.absence_ledgers.length) {
    resting = Object.assign({}, resting, { absence_ledgers: [], updated_at: now });
    save(dir, resting);
  }
  const exact = exactOf(resting.unsigned_tx.TakerPays);
  const spend = BigInt(resting.unsigned_tx.TakerGets);
  if (!exact || !crosses(spend, exact, observed.asks)) {
    return { decision: "research", traded: false, rationale: "The resting RLUSD bid is still under the outside ask." };
  }
  const shot = await shotOf(clients.ledger);
  const tx = {
    TransactionType: "OfferCancel",
    Account: bounds.ACCOUNT,
    OfferSequence: sequence,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const exposure = shot.fee;
  const state = view(dir, now);
  if (exposure > room.headroom || openExposure(state) + exposure > MAX_TRADE_DROPS) {
    return { decision: "research", traded: false, rationale: "Open RLUSD exposure is already at the 2 XRP cap." };
  }
  const reserved = reserve(dir, { key: `w1-rlusd-cancel-${sequence}`, action: "cancel", day, exposure, tx }, shot, now);
  const sent = await submitSigned(dir, reserved, tx, {
    type: "OfferCancel",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    offer_sequence: sequence,
  }, clients, now, gate);
  if (sent.replay) return { decision: "cancel", replay: true, traded: false };
  return { decision: "cancel", signed: true, submitted: sent.mission.submitted === true, traded: false, status: sent.mission.status };
}

function passiveBid(observed, spend) {
  if (!observed.asks.length) return null;
  let best = observed.asks[0];
  for (const ask of observed.asks) {
    if (rateLess(ask.xrp, ask.exact, best.xrp, best.exact)) best = ask;
  }
  const text = formatDiv(spend * 100n * best.exact.coeff, 99n * best.xrp, best.exact.exp, "up");
  if (!text) return null;
  const exact = market.exactIou(text);
  if (!exact || exact.coeff <= 0n) return null;
  if (crosses(spend, exact, observed.asks)) return null;
  if (!rateLess(spend, exact, observed.pool.xrp, observed.pool.exact)) return null;
  return { taker_gets: spend.toString(), taker_pays: { currency: CURRENCY, issuer: ISSUER, value: text } };
}

function sameAmount(left, right) {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return Boolean(left && right && left.currency === right.currency && left.issuer === right.issuer && left.value === right.value);
}

function iouNear(left, right) {
  const a = market.exactIou(left);
  const b = market.exactIou(right);
  if (!a || !b) return false;
  if (a.coeff === b.coeff && a.exp === b.exp) return true;
  if (a.coeff === 0n || b.coeff === 0n) return false;
  const span = Math.max(-a.exp, -b.exp, 0);
  const width = (exact) => exact.coeff * (10n ** BigInt(span + exact.exp));
  const av = width(a);
  const bv = width(b);
  const diff = av > bv ? av - bv : bv - av;
  const base = av > bv ? av : bv;
  return diff * 1000000n <= base;
}

function sameOfferAmount(left, right) {
  if (sameAmount(left, right)) return true;
  if (!left || !right || typeof left === "string" || typeof right === "string") return false;
  if (left.currency !== right.currency || left.issuer !== right.issuer) return false;
  return iouNear(left.value, right.value);
}

function nodeFields(node) {
  const body = node && (node.CreatedNode || node.ModifiedNode || node.DeletedNode);
  return body && (body.NewFields || body.FinalFields || {});
}

function binds(mission, tx, meta) {
  const reserved = mission.unsigned_tx;
  if (!reserved || tx.TransactionType !== reserved.TransactionType || tx.Account !== reserved.Account || tx.Account !== bounds.ACCOUNT) return false;
  if (tx.Sequence !== reserved.Sequence || tx.LastLedgerSequence !== reserved.LastLedgerSequence || String(tx.Fee) !== String(reserved.Fee)) return false;
  const nodes = Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  if (tx.TransactionType === "Payment") {
    if (tx.Destination !== bounds.ACCOUNT || tx.Flags !== reserved.Flags) return false;
    if (!sameAmount(tx.Amount, reserved.Amount) || String(tx.SendMax) !== String(reserved.SendMax) || !sameAmount(tx.DeliverMin, reserved.DeliverMin)) return false;
    const delivered = meta.delivered_amount || meta.DeliveredAmount;
    if (!sameAmount(delivered, reserved.Amount)) return false;
    return nodes.length > 0;
  }
  if (tx.TransactionType === "OfferCreate") {
    if (tx.Flags !== reserved.Flags || !sameAmount(tx.TakerGets, reserved.TakerGets) || !sameAmount(tx.TakerPays, reserved.TakerPays)) return false;
    return nodes.some((node) => {
      const fields = nodeFields(node);
      return fields && fields.Sequence === tx.Sequence && sameOfferAmount(fields.TakerGets, reserved.TakerGets) && sameOfferAmount(fields.TakerPays, reserved.TakerPays);
    });
  }
  if (tx.TransactionType === "TrustSet") {
    if (tx.Flags !== reserved.Flags || !sameAmount(tx.LimitAmount, reserved.LimitAmount)) return false;
    return nodes.some((node) => {
      const fields = nodeFields(node);
      const limits = [fields && fields.HighLimit, fields && fields.LowLimit].filter(Boolean);
      return limits.some((limit) => limit.currency === reserved.LimitAmount.currency && limit.issuer === ISSUER);
    });
  }
  if (tx.TransactionType === "OfferCancel") {
    if (tx.OfferSequence !== reserved.OfferSequence) return false;
    return nodes.some((node) => node && node.DeletedNode && node.DeletedNode.LedgerEntryType === "Offer");
  }
  return false;
}

function keep(dir, mission, now, reason) {
  const kept = Object.assign({}, mission, { status: "rlusd_unknown", proof_reason: reason, updated_at: now });
  save(dir, kept);
  return { decision: "reconcile", status: "rlusd_unknown", traded: false, proof_reason: reason };
}

async function reconcile(dir, mission, now, clients) {
  if (!mission.signed_hash) return keep(dir, mission, now, "unproved");
  const lookup = await ledgerRequest(clients, { command: "tx", transaction: mission.signed_hash, binary: false });
  const result = lookup && lookup.result;
  const meta = result && (result.meta || result.metaData);
  if (!result || result.validated !== true || !meta || meta.TransactionResult !== "tesSUCCESS") return keep(dir, mission, now, "unproved");
  const tx = result.tx_json || result;
  const hash = String(result.hash || "").toUpperCase();
  if (hash !== String(mission.signed_hash).toUpperCase() || !binds(mission, tx, meta)) return keep(dir, mission, now, "bind");
  const offer = tx.TransactionType === "OfferCreate";
  const balance = tx.TransactionType === "TrustSet" ? rippleBaseline(meta) : null;
  const proved = Object.assign({}, mission, {
    status: offer ? "rlusd_resting" : "rlusd_proved",
    submitted: true,
    proof_hash: hash,
    proof_result: "tesSUCCESS",
    validated_ledger: Number.isInteger(result.ledger_index) ? result.ledger_index : mission.validated_ledger,
    proof_balance: balance ? (balance.coeff === 0n ? "0" : formatCoeff(balance.coeff, balance.exp)) : mission.proof_balance,
    updated_at: now,
  });
  save(dir, proved);
  return { decision: "reconcile", status: proved.status, traded: tx.TransactionType === "Payment", realized_pnl_drops: "0", proof_hash: hash };
}

module.exports = {
  ISSUER,
  CURRENCY,
  AMM,
  REGULAR_KEY,
  TRUST_LIMIT,
  MAX_TRADE_DROPS,
  DEFAULT_TRADE_DROPS,
  MAX_TRADES_PER_TICK,
  MAX_TRADES_PER_DAY,
  KIND,
  isRlusd,
  planTrustLine,
  quoteBuy,
  markInventory,
  load,
  tick,
  historyDropped,
};
