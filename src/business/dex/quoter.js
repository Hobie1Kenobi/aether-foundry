"use strict";

/**
 * W4 resting quoter. One passive bid and/or ask inside the official RLUSD
 * spread. Cancel or replace no sooner than 2 hours, and by 3 hours.
 * Role exposure stays at or below 1 XRP. One signature per tick.
 */

const crypto = require("crypto");
const { coded, exclusive } = require("../../missions/ledger");
const { view } = require("../../missions/engine");
const policy = require("../../missions/policy");
const anchors = require("../../director/anchors");
const market = require("./market");
const bounds = require("./bounds");
const exposure = require("./exposure");
const book = require("./book");
const rlusd = require("./rlusd");
const signer = require("./signer");

const KIND = "w4-rlusd";
const ROLE = "W4";
const SIZE = 200000n;
const MIN_REPLACE_MS = 2 * 60 * 60 * 1000;
const REFRESH_MS = 3 * 60 * 60 * 1000;
const MAX_PER_TICK = 1;
const MAX_PER_DAY = 12;
const LEGACY = exposure.LEGACY_HOLD;

function formatExact(coeff, exp) {
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

function scaleDiv(coeff, exp, num, den) {
  if (coeff <= 0n || num <= 0n || den <= 0n) return null;
  let value = coeff * num * (10n ** 12n) / den;
  let point = exp - 12;
  if (value <= 0n) return null;
  while (value % 10n === 0n) {
    value /= 10n;
    point += 1;
  }
  while (value.toString().length > 16) {
    value /= 10n;
    point += 1;
  }
  const text = formatExact(value, point);
  const exact = text && market.exactIou(text);
  return exact ? { text, exact } : null;
}

function compare(xrpA, exactA, xrpB, exactB) {
  const scaleA = -exactA.exp;
  const scaleB = -exactB.exp;
  let left = xrpA * exactB.coeff;
  let right = xrpB * exactA.coeff;
  if (scaleA > scaleB) left *= 10n ** BigInt(scaleA - scaleB);
  else if (scaleB > scaleA) right *= 10n ** BigInt(scaleB - scaleA);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function bestOf(rows, wantHigher) {
  if (!rows || !rows.length) return null;
  let best = rows[0];
  for (const row of rows) {
    const order = compare(best.xrp, best.exact, row.xrp, row.exact);
    if (wantHigher ? order < 0 : order > 0) best = row;
  }
  return best;
}

function insideBid(bestBid, bestAsk, spend) {
  if (!bestBid || !bestAsk || spend <= 0n) return null;
  if (compare(bestBid.xrp, bestBid.exact, bestAsk.xrp, bestAsk.exact) >= 0) return null;
  const priced = scaleDiv(bestBid.exact.coeff, bestBid.exact.exp, spend * 100n, bestBid.xrp * 101n);
  if (!priced) return null;
  if (compare(spend, priced.exact, bestBid.xrp, bestBid.exact) <= 0) return null;
  if (compare(spend, priced.exact, bestAsk.xrp, bestAsk.exact) >= 0) return null;
  return {
    taker_gets: spend.toString(),
    taker_pays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: priced.text },
  };
}

function rowsOf(state) {
  return exposure.rows(state).filter((mission) => (mission.role || (mission.kind === KIND ? ROLE : null)) === ROLE);
}

function ageMs(mission, now) {
  const stamp = Date.parse(mission.quoted_at || mission.updated_at || "");
  const clock = Date.parse(now);
  if (!Number.isFinite(stamp) || !Number.isFinite(clock)) return 0;
  return clock - stamp;
}

function dayQuotes(state, day) {
  return rowsOf(state).filter((mission) => mission.submit_attempted === true && mission.chicago_day === day && (mission.action === "bid" || mission.action === "ask")).length;
}

function openQuotes(state) {
  return rowsOf(state).filter((mission) => mission.hold !== "released" && (mission.action === "bid" || mission.action === "ask"));
}

function admit(state, order) {
  const add = typeof order.exposure === "bigint" ? order.exposure : 0n;
  if (exposure.blocksNewRisk(state, ROLE)) throw coded("An uncertain RLUSD hold from another role is still open. Nothing is signed.", "HOLD");
  if ((order.action === "bid" || order.action === "ask") && dayQuotes(state, order.day) >= MAX_PER_DAY) {
    throw coded("W4 has used its daily quote count.", "DAY");
  }
  if ((order.action === "bid" || order.action === "ask") && openQuotes(state).length > 0) {
    throw coded("W4 already has a resting quote.", "CAP");
  }
  if (order.action !== "cancel" && !exposure.allows(state, ROLE, add, order.cap)) {
    throw coded("The resting quote does not fit the team cap.", "CAP");
  }
  if (order.action !== "cancel" && add > exposure.ledgerHeadroom(state).headroom) {
    throw coded("The resting quote does not fit the shared bankroll.", "BANKROLL");
  }
}

function reserve(dir, order, shot, now) {
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    if (state.killed) throw coded("hard stop is on", "killed");
    const existing = Object.values(state.missions || {}).find((mission) => mission && mission.idempotency_key === order.key);
    if (existing) {
      const terminal = existing.submit_attempted === true || existing.signing === true;
      return { mission: existing, created: false, terminal };
    }
    admit(state, order);
    const mission = {
      id: `msn${crypto.createHash("sha256").update(`w4|${order.key}`).digest("hex").slice(0, 16)}`,
      idempotency_key: order.key,
      kind: KIND,
      status: "rlusd_reserved",
      role: ROLE,
      account: anchors.WALLETS.W4.address,
      hold: "uncertain",
      signed: false,
      submitted: false,
      signing: true,
      action: order.action,
      chicago_day: order.day,
      quoted_at: now,
      sequence: shot.sequence,
      fee_drops: shot.fee.toString(),
      outstanding_drops: order.exposure.toString(),
      realized_loss_drops: "0",
      submit_attempted: false,
      updated_at: now,
      unsigned_tx: order.tx,
    };
    if (mission.id === LEGACY) throw coded("refusing the legacy mission hold", "HOLD");
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission, created: true };
  });
}

function caught(error) {
  if (error && (error.code === "CAP" || error.code === "HOLD" || error.code === "DAY" || error.code === "BANKROLL")) {
    return { decision: "research", signed: false, traded: false, rationale: error.message };
  }
  return null;
}

function save(dir, mission) {
  if (mission.id === LEGACY) throw coded("refusing the legacy mission hold", "HOLD");
  exclusive(dir, (api) => api.append({ type: "mission.upsert", at: mission.updated_at, mission }));
}

async function submit(dir, reserved, tx, expected, clients, now, gate) {
  if (reserved.mission.submit_attempted) return { mission: reserved.mission, replay: true };
  if (gate.signed >= MAX_PER_TICK) throw coded("W4 already signed this tick", "CAP");
  gate.signed += 1;
  let signed;
  try {
    signed = await signer.sign(tx, expected, clients.sign);
  } catch (error) {
    save(dir, Object.assign({}, reserved.mission, { signing: false, updated_at: now }));
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

function expectedFor(tx, shot) {
  return {
    role: ROLE,
    type: tx.TransactionType,
    account: anchors.WALLETS.W4.address,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    taker_gets: tx.TakerGets,
    taker_pays: tx.TakerPays,
    offer_sequence: tx.OfferSequence,
  };
}

async function proveTrust(clients, mission, account) {
  if (!mission || !mission.signed_hash || !clients || !clients.ledger) return null;
  let lookup;
  try {
    lookup = await clients.ledger.request({ command: "tx", transaction: mission.signed_hash, binary: false });
  } catch (error) {
    return null;
  }
  return book.trustSettled(lookup && lookup.result, mission, account);
}

async function tick(env, dir, now, clients, position, journal) {
  const config = bounds.verifiedEnv(env);
  if (!config || config.role !== ROLE) return null;
  if (!env || env.FOUNDRY_DEX_RLUSD !== "yes") return null;
  const cap = bounds.teamCapDrops(env);
  const observed = await book.load(clients.ledger, anchors.WALLETS.W4.address, book.REGULAR.W4);
  const state = view(dir, now);
  const gate = { signed: 0 };
  const base = {
    learning: false,
    traded: false,
    role: ROLE,
    rlusd_team_open_drops: exposure.teamOpen(state).toString(),
    rlusd_role_open_drops: exposure.roleOpen(state, ROLE).toString(),
    rlusd_team_cap_drops: cap == null ? null : cap.toString(),
  };
  const trustMission = rowsOf(state).find((mission) => mission.action === "trust" && mission.hold !== "released" && mission.signed_hash && mission.status !== "rlusd_proved");
  if (trustMission) {
    const settled = await proveTrust(clients, trustMission, anchors.WALLETS.W4.address);
    if (!settled) {
      return Object.assign(base, { decision: "research", signed: false, status: trustMission.status, rationale: "The W4 trust line has no validated proof. The hold stays open." });
    }
    save(dir, Object.assign({}, trustMission, settled, { updated_at: now }));
    return Object.assign(base, { decision: "reconcile", signed: false, status: "rlusd_proved", proof_hash: settled.proof_hash });
  }
  let resting = rowsOf(state).find((mission) => mission.hold !== "released" && (mission.action === "bid" || mission.action === "ask") && (mission.status === "rlusd_resting" || mission.status === "rlusd_unknown" || mission.status === "rlusd_reserved"));
  if (resting && (resting.status === "rlusd_unknown" || resting.status === "rlusd_reserved")) {
    const listed = (observed.own || []).some((row) => Number(row.seq != null ? row.seq : row.Sequence) === resting.sequence);
    if (listed) {
      save(dir, Object.assign({}, resting, { status: "rlusd_resting", updated_at: now }));
      return Object.assign(base, { decision: "reconcile", status: "rlusd_resting", signed: false });
    }
    return Object.assign(base, { decision: "research", signed: false, rationale: "The W4 quote is still unproved. Exposure stays open." });
  }
  if (resting && resting.status === "rlusd_resting") {
    const listed = (observed.own || []).some((row) => Number(row.seq != null ? row.seq : row.Sequence) === resting.sequence);
    if (!listed) {
      const cancel = rowsOf(state).find((mission) => mission.action === "cancel" && mission.submit_attempted === true && mission.unsigned_tx && mission.unsigned_tx.OfferSequence === resting.sequence);
      if (!cancel) {
        return Object.assign(base, { decision: "research", signed: false, rationale: "The resting quote left the book without a cancel. Exposure stays open." });
      }
      save(dir, Object.assign({}, resting, { hold: "released", status: "rlusd_cancelled", outstanding_drops: "0", updated_at: now }));
      const fee = BigInt(cancel.outstanding_drops || "0");
      save(dir, Object.assign({}, cancel, {
        hold: "released",
        status: "rlusd_proved",
        outstanding_drops: "0",
        realized_loss_drops: fee.toString(),
        updated_at: now,
      }));
      resting = null;
    }
  }
  if (cap == null) return Object.assign(base, { decision: "research", rationale: "The team RLUSD cap is not a valid drop string." });
  if (exposure.blocksNewRisk(state, ROLE)) {
    return Object.assign(base, { decision: "research", signed: false, rationale: "An uncertain RLUSD hold from another role is still open. Nothing is signed." });
  }
  if (resting) return Object.assign(base, await manage(dir, resting, now, clients, observed, gate, cap));
  if (!observed.trustline) return Object.assign(base, await trust(dir, now, clients, observed, gate, cap, position, state));
  return Object.assign(base, await place(dir, now, clients, observed, gate, cap, position, state));
}

function head(position, state) {
  const ledger = exposure.ledgerHeadroom(state);
  if (position && typeof position.headroom === "bigint") return position.headroom < ledger.headroom ? position.headroom : ledger.headroom;
  return ledger.headroom;
}

async function trust(dir, now, clients, observed, gate, cap, position, state) {
  const shot = observed.shot;
  const need = shot.reserveInc + shot.fee;
  if (!exposure.allows(state, ROLE, need, cap) || need > head(position, state)) {
    return { decision: "research", signed: false, rationale: "The W4 trust line does not fit the caps." };
  }
  const tx = {
    TransactionType: "TrustSet",
    Account: anchors.WALLETS.W4.address,
    Flags: 0x00020000,
    LimitAmount: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: rlusd.TRUST_LIMIT },
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  if (clients && typeof clients.beforeReserve === "function") await clients.beforeReserve();
  let reserved;
  try {
    reserved = reserve(dir, { key: "w4-rlusd-trust", action: "trust", day: policy.chicagoDay(now), exposure: need, tx, cap }, shot, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) return quiet;
    throw error;
  }
  if (reserved.terminal) return { decision: "trustline", replay: true, signed: false };
  const sent = await submit(dir, reserved, tx, expectedFor(tx, shot), clients, now, gate);
  return { decision: "trustline", signed: !sent.replay, traded: false };
}

async function place(dir, now, clients, observed, gate, cap, position, state) {
  const bid = bestOf(observed.bids, true);
  const ask = bestOf(observed.asks, false);
  const shot = observed.shot;
  let spend = SIZE;
  const roomLeft = exposure.tighterRoom(state, ROLE, cap);
  if (spend + shot.fee + shot.reserveInc > roomLeft) spend = roomLeft - shot.fee - shot.reserveInc;
  if (spend > 1000000n) spend = 1000000n;
  if (spend < 100000n) return { decision: "research", signed: false, rationale: "The resting quote does not fit the 1 XRP role cap." };
  const offer = insideBid(bid, ask, spend);
  if (!offer) return { decision: "research", signed: false, rationale: "No passive quote sits inside the official RLUSD spread." };
  const exposureDrops = spend + shot.fee + shot.reserveInc;
  if (!exposure.allows(state, ROLE, exposureDrops, cap) || exposureDrops > head(position, state)) {
    return { decision: "research", signed: false, rationale: "The resting quote does not fit the team cap." };
  }
  const tx = {
    TransactionType: "OfferCreate",
    Account: anchors.WALLETS.W4.address,
    Flags: bounds.TF_PASSIVE,
    TakerGets: offer.taker_gets,
    TakerPays: offer.taker_pays,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  if (clients && typeof clients.beforeReserve === "function") await clients.beforeReserve();
  let reserved;
  try {
    reserved = reserve(dir, {
      key: `w4-rlusd-bid-${policy.chicagoDay(now)}-${shot.sequence}`,
      action: "bid",
      day: policy.chicagoDay(now),
      exposure: exposureDrops,
      tx,
      cap,
    }, shot, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) return quiet;
    throw error;
  }
  if (reserved.terminal) return { decision: "research", replay: true, signed: false };
  const sent = await submit(dir, reserved, tx, expectedFor(tx, shot), clients, now, gate);
  return { decision: "place", signed: !sent.replay, traded: false, flags: tx.Flags, send_max_drops: tx.TakerGets };
}

async function manage(dir, resting, now, clients, observed, gate, cap) {
  const waited = ageMs(resting, now);
  if (waited < MIN_REPLACE_MS) {
    return { decision: "research", signed: false, rationale: "The resting quote is inside its 2 hour replace floor." };
  }
  const bid = bestOf(observed.bids, true);
  const ask = bestOf(observed.asks, false);
  const signed = resting.unsigned_tx || {};
  const spend = typeof signed.TakerGets === "string" ? BigInt(signed.TakerGets) : 0n;
  const still = spend > 0n && insideBid(bid, ask, spend);
  if (still && waited < REFRESH_MS) {
    return { decision: "research", signed: false, rationale: "The resting quote is still inside the spread." };
  }
  const shot = observed.shot;
  const state = view(dir, now);
  if (exposure.blocksNewRisk(state, ROLE) || exposure.teamOpen(state) > cap) {
    return { decision: "research", signed: false, rationale: "The quote replace does not fit the team cap." };
  }
  const tx = {
    TransactionType: "OfferCancel",
    Account: anchors.WALLETS.W4.address,
    OfferSequence: resting.sequence,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  let reserved;
  try {
    reserved = reserve(dir, {
      key: `w4-rlusd-cancel-${resting.sequence}`,
      action: "cancel",
      day: policy.chicagoDay(now),
      exposure: shot.fee,
      tx,
      cap,
    }, shot, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) return quiet;
    throw error;
  }
  if (reserved.terminal) return { decision: "cancel", replay: true, signed: false };
  const sent = await submit(dir, reserved, tx, expectedFor(tx, shot), clients, now, gate);
  return { decision: "cancel", signed: !sent.replay, traded: false };
}

module.exports = {
  KIND,
  ROLE,
  SIZE,
  MIN_REPLACE_MS,
  REFRESH_MS,
  insideBid,
  tick,
};
