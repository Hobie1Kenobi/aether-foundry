"use strict";

/**
 * One shared Testnet bankroll for every DEX and LP action.
 * 100 XRP is the capital-at-risk ceiling, not a fresh balance and not a
 * daily refill. Payment missions keep their own 1 XRP and 5 XRP caps.
 *
 * Proved XRP is open-offer locks, the LP's share of pool XRP, the account
 * base reserve, OwnerCount times the incremental reserve, in-flight holds,
 * and realized losses. Each of those is counted once. Remaining is the
 * ceiling minus that proved XRP, and it cannot exceed the XRP W1 can
 * actually spend. The AETH leg is not priced off this pool. It counts
 * only when an outside bid pays XRP for that AETH, and only for the AETH
 * that bid actually takes. Uncovered or frozen AETH is unproved: new AETH
 * risk is closed, and the XRP already in the pool stays consumed. The
 * unused cap stays open.
 */

const { exclusive } = require("../missions/ledger");
const { view } = require("../missions/engine");

const BOUNDS_KIND = "w1-dex-offer";
const LP_KIND = "w1-amm-lp";
const BANKROLL_DROPS = 100000000n;
const MARK_ID = "bankroll-lp-high-water";
const MARK_KIND = "w1-bankroll-mark";
const MIN_BID_DROPS = 1000000n;
const LEGACY_HOLD = "msn5b5c3223e5e88526";
const RLUSD_KINDS = new Set(["w1-rlusd", "w3-rlusd", "w4-rlusd"]);

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
    reserve_inc: 0n,
    pending: 0n,
    sole: false,
    rlusd_headroom: 0n,
  };
}

function storedHigh(state) {
  const mission = state && state.missions && state.missions[MARK_ID];
  return drops(mission && mission.lp_high_water_drops);
}

function rlusdOpen(mission) {
  if (!mission || mission.hold === "released") return false;
  if (mission.action === "trust" && mission.status === "rlusd_proved") return false;
  if (mission.action === "swap" && mission.status === "rlusd_proved") return false;
  if (mission.action === "cancel" && mission.status === "rlusd_proved") return false;
  return true;
}

function rlusdBooked(state) {
  const seen = new Set();
  let amount = 0n;
  for (const mission of Object.values((state && state.missions) || {})) {
    if (!mission || mission.id === LEGACY_HOLD || !RLUSD_KINDS.has(mission.kind)) continue;
    if (mission.role === "W1" || mission.kind === "w1-rlusd") continue;
    if (mission.id) {
      if (seen.has(mission.id)) continue;
      seen.add(mission.id);
    }
    const loss = drops(mission.realized_loss_drops);
    const open = rlusdOpen(mission) ? drops(mission.outstanding_drops) : 0n;
    amount += loss + open;
  }
  return { amount, overlap: 0n };
}

function carried(prev) {
  const extra = {};
  if (prev && typeof prev.proved_xrp_drops === "string") extra.proved_xrp_drops = prev.proved_xrp_drops;
  if (prev && typeof prev.rlusd_overlap_drops === "string") extra.rlusd_overlap_drops = prev.rlusd_overlap_drops;
  return extra;
}

function aethBid(observed) {
  const pool = observed.pool;
  if (pool.balance > 0n && pool.aethScaled <= 0n) return { proved: false, xrp: 0n };
  const inPool = pool.balance === 0n ? 0n : (pool.aethScaled * pool.balance) / pool.supply;
  const wallet = typeof observed.walletAeth === "bigint" ? observed.walletAeth : 0n;
  const offered = (observed.offers || []).reduce((sum, offer) => sum + (typeof offer.aeth === "bigint" ? offer.aeth : 0n), 0n);
  if (inPool < 0n || wallet < 0n || offered < 0n || observed.aethFrozen === true || observed.aethDebt === true) {
    return { proved: false, xrp: 0n };
  }
  const inventory = inPool + wallet + offered;
  if (inventory === 0n) return { proved: true, xrp: 0n };
  if (pool.aethScaled <= 0n) return { proved: false, xrp: 0n };
  const floor = (pool.xrp * inventory) / pool.aethScaled;
  if (floor <= 0n) return { proved: false, xrp: 0n };
  let covered = 0n;
  let xrp = 0n;
  for (const bid of observed.bids || []) {
    if (!bid || bid.house === true) continue;
    if (typeof bid.xrp !== "bigint" || typeof bid.aeth !== "bigint") continue;
    if (bid.xrp < MIN_BID_DROPS || bid.aeth <= 0n || bid.xrp > BANKROLL_DROPS) continue;
    if (covered >= inventory) break;
    const take = inventory - covered < bid.aeth ? inventory - covered : bid.aeth;
    const part = (bid.xrp * take) / bid.aeth;
    if (part <= 0n) continue;
    xrp += part;
    covered += take;
  }
  if (covered !== inventory || xrp < floor) return { proved: false, xrp: 0n };
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
  const currentLp = pool.balance === 0n ? 0n : (pool.xrp * pool.balance) / pool.supply;
  const lpXrp = currentLp > storedHigh(state) ? currentLp : storedHigh(state);
  const reserve = ownerCount * reserveInc;
  const provedXrp = offerLock + lpXrp + reserveBase + reserve + pending + loss;
  const priced = aethBid(observed);
  const aethXrp = priced.proved ? priced.xrp : 0n;
  const booked = rlusdBooked(state);
  const capital = provedXrp + aethXrp + booked.amount;
  const over = capital > BANKROLL_DROPS;
  const capRoom = capital >= BANKROLL_DROPS ? 0n : BANKROLL_DROPS - capital;
  const free = spendable(observed);
  const remaining = free < capRoom ? free : capRoom;
  const risk = priced.proved && !over;
  return {
    uncertain: false,
    valuation: priced.proved ? (over ? "over_cap" : "proved") : "unproved",
    aeth_valuation: priced.proved ? "proved" : "unproved",
    risk_increasing: risk,
    code: priced.proved ? (over ? "BANKROLL" : null) : "VALUATION",
    cap_blocked: remaining === 0n,
    limit: BANKROLL_DROPS,
    used: capital,
    proved_xrp: provedXrp,
    remaining,
    rlusd_headroom: provedXrp >= BANKROLL_DROPS ? 0n : BANKROLL_DROPS - provedXrp,
    loss,
    offer_lock: offerLock,
    lp_xrp: lpXrp,
    aeth_xrp: aethXrp,
    base_reserve: reserveBase,
    reserve,
    reserve_inc: reserveInc,
    pending,
    sole: pool.sole === true && pool.balance > 0n,
    rlusd_overlap: booked.overlap,
    rlusd_booked: booked.amount,
  };
}

function sumLocks(offers) {
  return (offers || []).reduce((sum, offer) => sum + (offer && offer.locked || 0n), 0n);
}

function spendable(observed) {
  if (!observed || observed.proved !== true) return 0n;
  if (typeof observed.balance !== "bigint" || typeof observed.reserveBase !== "bigint" || typeof observed.reserveInc !== "bigint" || typeof observed.ownerCount !== "bigint") return 0n;
  const locks = sumLocks(observed.offers) + sumLocks(observed.rlusdOffers);
  const free = observed.balance - observed.reserveBase - (observed.ownerCount * observed.reserveInc) - locks;
  return free > 0n ? free : 0n;
}

function commitMark(dir, current, now) {
  const amount = typeof current === "bigint" ? current : 0n;
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    const prev = storedHigh(state);
    const next = amount > prev ? amount : prev;
    const prior = state.missions && state.missions[MARK_ID];
    if (next === prev && prior) return next;
    api.append({
      type: "mission.upsert",
      at: now,
      mission: Object.assign({
        id: MARK_ID,
        kind: MARK_KIND,
        lp_high_water_drops: next.toString(),
        hold: "released",
        outstanding_drops: "0",
        updated_at: now,
      }, carried(prior)),
    });
    return next;
  });
}

function recover(dir, xrpOut, current, now) {
  const back = typeof xrpOut === "bigint" ? xrpOut : 0n;
  const live = typeof current === "bigint" ? current : 0n;
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    const prev = storedHigh(state);
    const reduced = prev > back ? prev - back : 0n;
    const next = live > reduced ? live : reduced;
    const prior = state.missions && state.missions[MARK_ID];
    api.append({
      type: "mission.upsert",
      at: now,
      mission: Object.assign({
        id: MARK_ID,
        kind: MARK_KIND,
        lp_high_water_drops: next.toString(),
        recovered_drops: back.toString(),
        hold: "released",
        outstanding_drops: "0",
        updated_at: now,
      }, carried(prior)),
    });
    return next;
  });
}

function noteShared(dir, proved, overlap, now) {
  const amount = typeof proved === "bigint" && proved >= 0n ? proved : 0n;
  const shave = typeof overlap === "bigint" && overlap >= 0n ? overlap : 0n;
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    const prior = state.missions && state.missions[MARK_ID];
    api.append({
      type: "mission.upsert",
      at: now,
      mission: {
        id: MARK_ID,
        kind: MARK_KIND,
        lp_high_water_drops: storedHigh(state).toString(),
        proved_xrp_drops: amount.toString(),
        rlusd_overlap_drops: shave.toString(),
        hold: "released",
        outstanding_drops: "0",
        updated_at: now,
      },
    });
    return amount;
  });
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
  commitMark,
  noteShared,
  recover,
  MIN_BID_DROPS,
};
