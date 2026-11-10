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

const MAX_TRADES_PER_TICK = 1;
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
  return rowsOf(state).find((mission) => mission.hold !== "released" && mission.status !== "rlusd_resting" && mission.status !== "rlusd_proved" && mission.status !== "rlusd_filled") || null;
}

function findResting(state) {
  return rowsOf(state).find((mission) => mission.hold !== "released" && (mission.action === "rest" || mission.action === "replace") && (mission.status === "rlusd_resting" || mission.status === "rlusd_proved")) || null;
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
      action: order.action,
      chicago_day: order.day,
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
  if (inventory) return Object.assign(fields, await sellInventory(dir, inventory, now, clients, observed, room, day, gate));
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

async function buy(dir, now, clients, shot, observed, room, day, gate) {
  const state = view(dir, now);
  if (findResting(state)) return { decision: "research", traded: false, rationale: "A RLUSD offer is still open." };
  const spend = DEFAULT_TRADE_DROPS;
  if (spend > MAX_TRADE_DROPS || room.headroom < spend) {
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
  const exposure = (bid ? BigInt(bid.taker_gets) : priced.sendMax) + shot.fee + (bid ? shot.reserveInc : 0n);
  if (!withinCaps(state, day, exposure, room)) {
    return { decision: "research", aeth_exit_proposal: room.headroom < spend ? "w1-exit-sole-lp" : null, rationale: "Open RLUSD exposure is already at the 2 XRP cap." };
  }
  const reserved = reserve(dir, { key, action: key.startsWith("w1-rlusd-rest-") ? "replace" : action, day, exposure, tx }, shot, now);
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
  if (rowsOf(state).some((mission) => mission.action === "sell" && mission.hold !== "released")) return null;
  return rowsOf(state).find((mission) => mission.status === "rlusd_filled" && mission.hold !== "released") || null;
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

async function historyOf(clients, mission) {
  let page;
  try {
    page = await clients.ledger.request({
      command: "account_tx",
      account: bounds.ACCOUNT,
      ledger_index_min: mission.create_ledger || -1,
      binary: false,
      limit: 20,
    });
  } catch (error) {
    return { missing: true, transactions: [] };
  }
  const result = page && page.result;
  if (!result || result.validated !== true || !Array.isArray(result.transactions) || result.marker != null) {
    return { incomplete: true, transactions: [] };
  }
  return { missing: result.transactions.length === 0, transactions: result.transactions };
}

async function proveFill(dir, resting, now, clients, observed) {
  const reserved = resting.unsigned_tx || {};
  const pays = exactOf(reserved.TakerPays);
  const spent = marketXrp(reserved.TakerGets);
  if (!pays || spent == null) {
    return { decision: "research", traded: false, rationale: "The resting RLUSD offer is not on the book and its amounts are not proved." };
  }
  const history = await historyOf(clients, resting);
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
  let proof = null;
  if (hits.length === 1) {
    const hit = hits[0];
    const covered = hit.klass.klass === "partial" ? observed.balance.coeff > 0n : atLeast(observed.balance, pays);
    if (!covered && hit.klass.klass !== "cancelled" && hit.klass.klass !== "expired") {
      return { decision: "research", traded: false, rationale: "The RLUSD balance does not cover the missing offer. Exposure stays open." };
    }
    proof = {
      klass: hit.klass.klass,
      outside: hit.klass.outside,
      hash: hit.hash,
      counterparty: hit.tx.Account === bounds.ACCOUNT ? null : hit.tx.Account,
      type: "consuming_tx",
    };
  } else if (history.missing && atLeast(observed.balance, pays)) {
    const create = await clients.ledger.request({ command: "tx", transaction: resting.signed_hash, binary: false });
    const result = create && create.result;
    const tx = result && (result.tx_json || result);
    const meta = result && (result.meta || result.metaData);
    if (result && result.validated === true && meta && meta.TransactionResult === "tesSUCCESS" && binds(resting, tx, meta)) {
      proof = { klass: "filled", outside: false, hash: null, counterparty: null, type: "balance_delta" };
    }
  }
  if (!proof) {
    return { decision: "research", traded: false, rationale: "The resting RLUSD offer is not on the book and has no proved cancel. Its exposure stays open." };
  }
  if (proof.klass === "cancelled" || proof.klass === "expired") {
    const status = proof.klass === "cancelled" ? "rlusd_cancelled" : "rlusd_expired";
    save(dir, Object.assign({}, resting, { hold: "released", status, outstanding_drops: "0", updated_at: now, proof_type: proof.type, proof_hash: proof.hash, outside_fill: false }));
    return { decision: "reconcile", traded: false, signed: false, learning: false, status, fill_class: proof.klass, proof_type: proof.type, fill_hash: proof.hash, outside_fill: false };
  }
  const marked = proof.klass === "expired" ? { proved: true, xrp: 0n } : markInventory(observed.pool, observed.bids, pays);
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
    rationale: proof.type === "balance_delta"
      ? "The offer is gone, the RLUSD balance covers it, and the creating transaction is validated. History did not return the consuming trade."
      : "A validated trade consumed the resting RLUSD offer.",
  };
}

function passiveSell(observed, balance) {
  const bids = (observed.bids || []).filter((bid) => bid && outside(bid.account));
  if (!bids.length || !balance || balance.coeff <= 0n) return null;
  let best = bids[0];
  for (const bid of bids) {
    if (rateLess(best.xrp, best.exact, bid.xrp, bid.exact)) best = bid;
  }
  const shift = balance.exp - best.exact.exp;
  const num = balance.coeff * best.xrp * 101n;
  const den = best.exact.coeff * 100n;
  const drops = shift >= 0 ? (num * (10n ** BigInt(shift))) / den : num / (den * (10n ** BigInt(-shift)));
  if (drops <= 0n || drops > MAX_TRADE_DROPS) return null;
  if (!rateLess(best.xrp, best.exact, drops, balance)) return null;
  if (rateLess(drops, balance, observed.pool.xrp, observed.pool.exact)) return null;
  const text = formatCoeff(balance.coeff, balance.exp);
  if (!text) return null;
  return { taker_gets: { currency: CURRENCY, issuer: ISSUER, value: text }, taker_pays: drops.toString() };
}

async function sellInventory(dir, mission, now, clients, observed, room, day, gate) {
  const state = view(dir, now);
  if (dayTrades(state, day) >= MAX_TRADES_PER_DAY) {
    return { decision: "research", traded: false, rationale: "The Chicago day already has its RLUSD orders. The inventory is not sold." };
  }
  const offer = passiveSell(observed, observed.balance);
  if (!offer) return { decision: "research", traded: false, rationale: "No passive RLUSD exit sits above the outside bid." };
  const shot = await shotOf(clients.ledger);
  const exposure = BigInt(offer.taker_pays) + shot.fee + shot.reserveInc;
  const open = openExposure(state) - BigInt(mission.outstanding_drops || "0");
  if (open + exposure > MAX_TRADE_DROPS || exposure > room.headroom + BigInt(mission.outstanding_drops || "0")) {
    return { decision: "research", traded: false, rationale: "The RLUSD exit does not fit the 2 XRP open cap." };
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
  save(dir, Object.assign({}, mission, { outstanding_drops: "0", updated_at: now }));
  const reserved = reserve(dir, { key: `w1-rlusd-sell-${day}`, action: "sell", day, exposure, tx }, shot, now);
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
  if (sent.replay) return { decision: "place", replay: true, traded: false };
  return { decision: "place", signed: true, submitted: sent.mission.submitted === true, traded: false, send_max_drops: tx.TakerPays, deliver_min: tx.TakerGets.value };
}

async function manageRest(dir, resting, now, clients, observed, room, day, gate) {
  const sequence = resting.sequence;
  if (!stillResting(observed, sequence)) {
    const cancelled = rowsOf(view(dir, now)).find((mission) => mission.action === "cancel" && mission.status === "rlusd_proved" && mission.unsigned_tx && mission.unsigned_tx.OfferSequence === sequence);
    if (!cancelled) return proveFill(dir, resting, now, clients, observed);
    save(dir, Object.assign({}, resting, { hold: "released", status: "rlusd_cancelled", outstanding_drops: "0", updated_at: now }));
    return { decision: "reconcile", traded: false, status: "rlusd_cancelled" };
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
      return fields && fields.Sequence === tx.Sequence && sameAmount(fields.TakerGets, reserved.TakerGets) && sameAmount(fields.TakerPays, reserved.TakerPays);
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
  const lookup = await clients.ledger.request({ command: "tx", transaction: mission.signed_hash, binary: false });
  const result = lookup && lookup.result;
  const meta = result && (result.meta || result.metaData);
  if (!result || result.validated !== true || !meta || meta.TransactionResult !== "tesSUCCESS") return keep(dir, mission, now, "unproved");
  const tx = result.tx_json || result;
  const hash = String(result.hash || "").toUpperCase();
  if (hash !== String(mission.signed_hash).toUpperCase() || !binds(mission, tx, meta)) return keep(dir, mission, now, "bind");
  const offer = tx.TransactionType === "OfferCreate";
  const proved = Object.assign({}, mission, {
    status: offer ? "rlusd_resting" : "rlusd_proved",
    submitted: true,
    proof_hash: hash,
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
};
