"use strict";

/**
 * One shared Testnet bankroll for every DEX and LP action.
 * 100 XRP is the capital-at-risk ceiling, not a fresh balance and not a
 * daily refill. Payment missions keep their own 1 XRP and 5 XRP caps.
 *
 * Proved XRP is open-offer locks, the LP's share of pool XRP, the account
 * base reserve, OwnerCount times the incremental reserve, in-flight holds,
 * and realized losses. The AETH leg is not priced off this pool. It counts
 * only when an outside bid pays XRP for that AETH, and only for the AETH
 * that bid actually takes. Uncovered or frozen AETH is unproved: new risk
 * is closed, and the XRP already in the pool stays consumed.
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
    valuation: "unproved",
    aeth_valuation: "unproved",
    risk_increasing: false,
    code: code || "UNCERTAIN",
    cap_blocked: true,
    limit: BANKROLL_DROPS,
    used: BANKROLL_DROPS,
    remaining: 0n,
    loss: 0n,
    offer_lock: 0n,
    lp_xrp: 0n,
    aeth_xrp: 0n,
    base_reserve: 0n,
    reserve: 0n,
    pending: 0n,
    sole: false,
  };
}

function aethBid(observed) {
  const pool = observed.pool;
  if (pool.balance > 0n && pool.aethScaled <= 0n) return { proved: false, xrp: 0n };
  const inPool = pool.balance === 0n ? 0n : (pool.aethScaled * pool.balance) / pool.supply;
  const wallet = typeof observed.walletAeth === "bigint" ? observed.walletAeth : 0n;
  if (inPool < 0n || wallet < 0n || observed.aethFrozen === true || observed.aethDebt === true) {
    return { proved: false, xrp: 0n };
  }
  const inventory = inPool + wallet;
  if (inventory === 0n) return { proved: true, xrp: 0n };
  let covered = 0n;
  let xrp = 0n;
  for (const bid of observed.bids || []) {
    if (!bid || typeof bid.xrp !== "bigint" || typeof bid.aeth !== "bigint") continue;
    if (bid.xrp <= 0n || bid.aeth <= 0n || bid.xrp > BANKROLL_DROPS) continue;
    if (covered >= inventory) break;
    const take = inventory - covered < bid.aeth ? inventory - covered : bid.aeth;
    xrp += (bid.xrp * take) / bid.aeth;
    covered += take;
  }
  if (covered !== inventory) return { proved: false, xrp: 0n };
  return { proved: true, xrp };
}

function room(state, observed) {
  if (!observed || observed.proved !== true || !observed.pool) return blank(observed && observed.code);
  const reserveInc = observed.reserveInc;
  const reserveBase = observed.reserveBase;
  const ownerCount = observed.ownerCount;
  if (typeof reserveInc !== "bigint" || typeof reserveBase !== "bigint" || typeof ownerCount !== "bigint") {
    return blank("RESERVE");
  }
  if (reserveInc < 0n || reserveBase < 0n || ownerCount < 0n) return blank("RESERVE");
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
  if (typeof pool.xrp !== "bigint" || typeof pool.balance !== "bigint" || typeof pool.supply !== "bigint" || typeof pool.aethScaled !== "bigint") {
    return blank("VALUATION");
  }
  if (pool.supply <= 0n || pool.balance < 0n || pool.balance > pool.supply || pool.xrp < 0n || pool.aethScaled < 0n) {
    return blank("VALUATION");
  }
  const lpXrp = pool.balance === 0n ? 0n : (pool.xrp * pool.balance) / pool.supply;
  const reserve = ownerCount * reserveInc;
  const provedXrp = offerLock + lpXrp + reserveBase + reserve + pending + loss;
  const priced = aethBid(observed);
  const aethXrp = priced.proved ? priced.xrp : 0n;
  const used = provedXrp + aethXrp;
  const over = used > BANKROLL_DROPS;
  const risk = priced.proved && !over;
  return {
    uncertain: false,
    valuation: priced.proved ? (over ? "over_cap" : "proved") : "unproved",
    aeth_valuation: priced.proved ? "proved" : "unproved",
    risk_increasing: risk,
    code: priced.proved ? (over ? "BANKROLL" : null) : "VALUATION",
    cap_blocked: !risk,
    limit: BANKROLL_DROPS,
    used: priced.proved ? used : provedXrp,
    proved_xrp: provedXrp,
    remaining: risk ? BANKROLL_DROPS - used : 0n,
    loss,
    offer_lock: offerLock,
    lp_xrp: lpXrp,
    aeth_xrp: aethXrp,
    base_reserve: reserveBase,
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
  if (!position || position.uncertain || position.risk_increasing !== true) return 0n;
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
