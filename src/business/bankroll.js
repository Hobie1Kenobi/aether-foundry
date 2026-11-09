"use strict";

/**
 * One shared Testnet bankroll for every DEX and LP action.
 * The ceiling is 100 XRP. It is not 100 XRP per agent and it does not refill
 * each Chicago day. Restarts read the same ledger and the same live inventory.
 * Payment missions keep their own 1 XRP and 5 XRP caps.
 */

const BOUNDS_KIND = "w1-dex-offer";
const LP_KIND = "w1-amm-lp";
const BANKROLL_DROPS = 100000000n;

function drops(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : 0n;
}

function kinds(mission) {
  return mission && (mission.kind === BOUNDS_KIND || mission.kind === LP_KIND);
}

function blank(code) {
  return {
    uncertain: true,
    code: code || "UNCERTAIN",
    cap_blocked: true,
    limit: BANKROLL_DROPS,
    used: BANKROLL_DROPS,
    remaining: 0n,
    loss: 0n,
    offer_lock: 0n,
    lp_xrp: 0n,
    reserve: 0n,
    pending: 0n,
    sole: false,
  };
}

function room(state, observed) {
  if (!observed || observed.proved !== true || !observed.pool) return blank(observed && observed.code);
  const reserveInc = observed.reserveInc;
  const ownerCount = observed.ownerCount;
  if (typeof reserveInc !== "bigint" || typeof ownerCount !== "bigint" || reserveInc < 0n || ownerCount < 0n) {
    return blank("RESERVE");
  }
  const offers = Array.isArray(observed.offers) ? observed.offers : [];
  let offerLock = 0n;
  const live = new Map();
  for (const offer of offers) {
    const locked = typeof offer.locked === "bigint" ? offer.locked : 0n;
    if (locked < 0n) return blank("OFFER");
    offerLock += locked;
    if (offer.seq != null) live.set(offer.seq, locked);
  }
  let pending = 0n;
  let loss = 0n;
  for (const mission of Object.values((state && state.missions) || {})) {
    if (!kinds(mission)) continue;
    loss += drops(mission.realized_loss_drops);
    const outstanding = drops(mission.outstanding_drops);
    if (outstanding <= 0n || mission.hold === "released") continue;
    if (mission.kind === BOUNDS_KIND && live.has(mission.sequence)) {
      const extra = outstanding - live.get(mission.sequence) - reserveInc;
      if (extra > 0n) pending += extra;
      continue;
    }
    if (mission.kind === LP_KIND && (mission.status === "amm_open" || mission.status === "amm_proved")) continue;
    pending += outstanding;
  }
  const pool = observed.pool;
  if (typeof pool.xrp !== "bigint" || typeof pool.balance !== "bigint" || typeof pool.supply !== "bigint") {
    return blank("VALUATION");
  }
  if (pool.supply <= 0n || pool.balance < 0n || pool.balance > pool.supply || pool.xrp < 0n) return blank("VALUATION");
  const lpXrp = pool.balance === 0n ? 0n : (pool.xrp * pool.balance) / pool.supply;
  const reserve = ownerCount * reserveInc;
  const used = offerLock + lpXrp + reserve + pending + loss;
  const remaining = used >= BANKROLL_DROPS ? 0n : BANKROLL_DROPS - used;
  return {
    uncertain: false,
    code: null,
    cap_blocked: remaining === 0n,
    limit: BANKROLL_DROPS,
    used,
    remaining,
    loss,
    offer_lock: offerLock,
    lp_xrp: lpXrp,
    reserve,
    pending,
    sole: pool.sole === true && pool.balance > 0n,
  };
}

function spendable(observed) {
  if (!observed || observed.proved !== true) return 0n;
  const locks = (observed.offers || []).reduce((sum, offer) => sum + (offer.locked || 0n), 0n);
  const free = observed.balance - observed.reserveBase - (observed.ownerCount * observed.reserveInc) - locks;
  return free > 0n ? free : 0n;
}

function maxLock(observed, position, fee) {
  if (!position || position.uncertain) return 0n;
  const cost = fee + observed.reserveInc;
  const narrower = spendable(observed) < position.remaining ? spendable(observed) : position.remaining;
  return narrower > cost ? narrower - cost : 0n;
}

module.exports = {
  BANKROLL_DROPS,
  BOUNDS_KIND,
  LP_KIND,
  room,
  spendable,
  maxLock,
};
