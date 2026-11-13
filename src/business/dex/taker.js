"use strict";

/**
 * W3 pool taker. One IOC round-trip leg per tick against official RLUSD.
 * Size stays inside 0.1-0.25 XRP. Role exposure stays at or below 0.5 XRP.
 * The team cap and uncertain holds are shared through the mission ledger.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { coded, exclusive } = require("../../missions/ledger");
const { view } = require("../../missions/engine");
const policy = require("../../missions/policy");
const anchors = require("../../director/anchors");
const bounds = require("./bounds");
const exposure = require("./exposure");
const book = require("./book");
const rlusd = require("./rlusd");
const market = require("./market");
const signer = require("./signer");

const KIND = "w3-rlusd";
const ROLE = "W3";
const SIZE = 200000n;
const MAX_PER_DAY = 4;
const MAX_PER_TICK = 1;
const LEGACY = exposure.LEGACY_HOLD;

function writePublic(dir, record) {
  if (!dir) return record;
  const text = JSON.stringify(record);
  if (/seed|secret|tx_blob|private/i.test(text)) {
    throw Object.assign(new Error("decision record is not public"), { code: "SECRET" });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "decisions.jsonl"), `${text}\n`);
  return record;
}

function rows(state) {
  return exposure.rows(state).filter((mission) => exposureRole(mission) === ROLE);
}

function exposureRole(mission) {
  return mission.role || (mission.kind === KIND ? ROLE : null);
}

function dayCount(state, day) {
  return rows(state).filter((mission) => mission.submit_attempted === true && mission.chicago_day === day && (mission.action === "buy" || mission.action === "sell")).length;
}

function projected(state, releaseId) {
  if (!releaseId || !state || !state.missions || !state.missions[releaseId]) return state;
  const source = state.missions[releaseId];
  if (!source || source.id === LEGACY) return state;
  return {
    missions: Object.assign({}, state.missions, {
      [releaseId]: Object.assign({}, source, { outstanding_drops: "0" }),
    }),
  };
}

function admit(state, order) {
  const add = typeof order.exposure === "bigint" ? order.exposure : 0n;
  const next = projected(state, order.release);
  if (exposure.blocksNewRisk(next, ROLE)) throw coded("An uncertain RLUSD hold from another role is still open. Nothing is signed.", "HOLD");
  if (order.action === "buy" || order.action === "sell") {
    if (dayCount(next, order.day) >= MAX_PER_DAY) throw coded("W3 has used its daily taker count.", "DAY");
  }
  if (order.action !== "sell" && !exposure.allows(next, ROLE, add, order.cap)) {
    throw coded("The team RLUSD cap or the W3 0.5 XRP cap is already full.", "CAP");
  }
  if (order.action === "sell" && !exposure.allows(next, ROLE, add, order.cap)) {
    throw coded("The IOC sell does not fit the caps.", "CAP");
  }
  if (add > exposure.ledgerHeadroom(next).headroom) throw coded("The shared bankroll headroom does not fit this taker order.", "BANKROLL");
}

function reserve(dir, order, shot, now) {
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    if (state.killed) throw coded("hard stop is on", "killed");
    const existing = Object.values(state.missions || {}).find((mission) => mission && mission.idempotency_key === order.key);
    if (existing) {
      const terminal = existing.submit_attempted === true || existing.hold === "released" || existing.signing === true;
      return { mission: existing, created: false, terminal };
    }
    admit(state, order);
    if (order.release && state.missions && state.missions[order.release] && state.missions[order.release].id !== LEGACY) {
      api.append({
        type: "mission.upsert",
        at: now,
        mission: Object.assign({}, state.missions[order.release], { outstanding_drops: "0", updated_at: now }),
      });
    }
    const mission = {
      id: `msn${crypto.createHash("sha256").update(`w3|${order.key}`).digest("hex").slice(0, 16)}`,
      idempotency_key: order.key,
      kind: KIND,
      status: "rlusd_reserved",
      role: ROLE,
      account: anchors.WALLETS.W3.address,
      hold: "uncertain",
      signed: false,
      submitted: false,
      signing: true,
      action: order.action,
      chicago_day: order.day,
      sequence: shot.sequence,
      last_ledger_sequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
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

function blocked(state, add, cap, room) {
  if (exposure.blocksNewRisk(state, ROLE)) return "An uncertain RLUSD hold from another role is still open. Nothing is signed.";
  if (!exposure.allows(state, ROLE, add, cap)) return "The team RLUSD cap or the W3 0.5 XRP cap is already full.";
  if (add > room) return "The shared bankroll headroom does not fit this taker order.";
  return null;
}

async function submit(dir, reserved, tx, expected, clients, now, gate, journal) {
  if (reserved.mission.submit_attempted) return { mission: reserved.mission, replay: true };
  if (gate.signed >= MAX_PER_TICK) throw coded("W3 already signed this tick", "CAP");
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
  const proof = await proveNow(clients, signed.hash, anchors.WALLETS.W3.address, mission);
  if (proof) {
    const filled = Object.assign({}, mission, proof.mission, { updated_at: now });
    save(dir, filled);
    writePublic(journal, proof.journal);
    return { mission: filled, replay: false, fill_proof: proof.journal };
  }
  return { mission, replay: false };
}

async function proveNow(clients, hash, self, mission) {
  if (!clients || !clients.ledger || typeof hash !== "string") return null;
  let lookup;
  try {
    lookup = await clients.ledger.request({ command: "tx", transaction: hash, binary: false });
  } catch (error) {
    return null;
  }
  const result = lookup && lookup.result;
  const meta = result && (result.meta || result.metaData);
  if (mission && mission.action === "trust") {
    const settled = book.trustSettled(result, mission, self);
    if (!settled) return null;
    return {
      mission: settled,
      journal: {
        schema: "aether.business.rlusd-trust",
        at: new Date().toISOString(),
        learning: false,
        role: ROLE,
        decision: "reconcile",
        status: "rlusd_proved",
        proof_type: "trust_set",
        proof_hash: settled.proof_hash,
        outside_fill: false,
      },
    };
  }
  if (!result || result.validated !== true || !meta || meta.TransactionResult !== "tesSUCCESS") return null;
  const proof = book.counterparties(meta, self);
  return {
    mission: {
      status: "rlusd_filled",
      hold: "uncertain",
      bought_rlusd: book.rlusdAcquired(meta, self) || "0",
      proof_hash: String(result.hash || hash).toUpperCase(),
      proof_result: "tesSUCCESS",
      proof_type: "consuming_tx",
      outside_fill: proof.outside === true,
      counterparties: proof.accounts,
      outside_accounts: proof.outside_accounts,
    },
    journal: {
      schema: "aether.business.rlusd-fill",
      at: new Date().toISOString(),
      learning: false,
      role: ROLE,
      decision: "reconcile",
      proof_type: "consuming_tx",
      fill_hash: String(result.hash || hash).toUpperCase(),
      counterparties: proof.accounts,
      outside_accounts: proof.outside_accounts,
      house_accounts: proof.house_accounts,
      outside_fill: proof.outside === true,
    },
  };
}

function expectedFor(tx, shot) {
  return {
    role: ROLE,
    type: tx.TransactionType,
    account: anchors.WALLETS.W3.address,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    taker_gets: tx.TakerGets,
    taker_pays: tx.TakerPays,
    flags: tx.Flags,
    limit: tx.LimitAmount && tx.LimitAmount.value,
    offer_sequence: tx.OfferSequence,
  };
}

async function tick(env, dir, now, clients, position, journal) {
  const config = bounds.verifiedEnv(env);
  if (!config || config.role !== ROLE) return null;
  if (!env || env.FOUNDRY_DEX_RLUSD !== "yes") return null;
  const cap = bounds.teamCapDrops(env);
  const observed = await book.load(clients.ledger, anchors.WALLETS.W3.address, book.REGULAR.W3);
  const state = view(dir, now);
  const room = roomOf(position, state);
  const day = policy.chicagoDay(now);
  const gate = { signed: 0 };
  const base = {
    learning: false,
    traded: false,
    role: ROLE,
    rlusd_team_open_drops: exposure.teamOpen(state).toString(),
    rlusd_role_open_drops: exposure.roleOpen(state, ROLE).toString(),
    rlusd_team_cap_drops: cap == null ? null : cap.toString(),
  };
  const trustMission = rows(state).find((mission) => mission.action === "trust" && mission.hold !== "released" && mission.status !== "rlusd_proved" && mission.signed_hash);
  if (trustMission) {
    const proved = await proveNow(clients, trustMission.signed_hash, anchors.WALLETS.W3.address, trustMission);
    if (proved && proved.mission && proved.mission.status === "rlusd_proved") {
      save(dir, Object.assign({}, trustMission, proved.mission, { updated_at: now }));
      writePublic(journal, Object.assign({}, proved.journal, { at: now }));
      return Object.assign(base, { decision: "reconcile", fill_proof: proved.journal, status: "rlusd_proved" });
    }
    return Object.assign(base, { decision: "research", signed: false, status: trustMission.status, rationale: "The W3 trust line has no validated proof. The hold stays open." });
  }
  const pending = rows(state).find((mission) => mission.action !== "trust" && mission.hold === "uncertain" && (mission.status === "rlusd_reserved" || mission.status === "rlusd_unknown") && mission.signed_hash);
  if (pending) {
    const proved = await proveNow(clients, pending.signed_hash, anchors.WALLETS.W3.address, pending);
    if (proved) {
      save(dir, Object.assign({}, pending, proved.mission, { updated_at: now }));
      writePublic(journal, Object.assign({}, proved.journal, { at: now }));
      return Object.assign(base, { decision: "reconcile", fill_proof: proved.journal, status: proved.mission.status });
    }
    return Object.assign(base, { decision: "research", signed: false, rationale: "The W3 taker order is still unproved. Exposure stays open." });
  }
  if (cap == null) return Object.assign(base, { decision: "research", rationale: "The team RLUSD cap is not a valid drop string." });
  if (exposure.blocksNewRisk(state, ROLE)) {
    return Object.assign(base, { decision: "research", signed: false, rationale: "An uncertain RLUSD hold from another role is still open. Nothing is signed." });
  }
  let inventory = rows(state).find((mission) => mission.hold !== "released" && mission.action === "buy" && mission.status === "rlusd_filled" && BigInt(mission.outstanding_drops || "0") > 0n);
  const held = inventory ? market.exactIou(inventory.bought_rlusd || "") : null;
  if (inventory && (!held || held.coeff <= 0n)) {
    const refreshed = await reacquire(clients, inventory, anchors.WALLETS.W3.address);
    if (refreshed) {
      inventory = Object.assign({}, inventory, refreshed, { updated_at: now });
      save(dir, inventory);
    }
  }
  if (inventory && observed.balance.coeff > 0n) return Object.assign(base, await sell(dir, inventory, now, clients, observed, room, day, gate, cap, journal));
  if (!observed.trustline) return Object.assign(base, await trust(dir, now, clients, observed, room, day, gate, cap));
  return Object.assign(base, await buy(dir, now, clients, observed, room, day, gate, cap, journal));
}

function roomOf(position, state) {
  const ledger = exposure.ledgerHeadroom(state);
  if (position && typeof position.headroom === "bigint") {
    return position.headroom < ledger.headroom ? position.headroom : ledger.headroom;
  }
  return ledger.headroom;
}

async function trust(dir, now, clients, observed, room, day, gate, cap) {
  const shot = observed.shot;
  const need = shot.reserveInc + shot.fee;
  const why = blocked(view(dir, now), need, cap, room);
  if (why) return { decision: "research", signed: false, rationale: why };
  const tx = {
    TransactionType: "TrustSet",
    Account: anchors.WALLETS.W3.address,
    Flags: 0x00020000,
    LimitAmount: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: rlusd.TRUST_LIMIT },
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  if (clients && typeof clients.beforeReserve === "function") await clients.beforeReserve();
  let reserved;
  try {
    reserved = reserve(dir, { key: "w3-rlusd-trust", action: "trust", day, exposure: need, tx, cap }, shot, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) return quiet;
    throw error;
  }
  if (reserved.terminal) return { decision: "trustline", replay: true, traded: false };
  const sent = await submit(dir, reserved, tx, expectedFor(tx, shot), clients, now, gate);
  return { decision: "trustline", signed: !sent.replay, submitted: sent.mission.submitted === true, traded: false, replay: sent.replay === true };
}

async function buy(dir, now, clients, observed, room, day, gate, cap, journal) {
  const state = view(dir, now);
  if (dayCount(state, day) >= MAX_PER_DAY) return { decision: "research", signed: false, rationale: "W3 has used its daily taker count." };
  const shot = observed.shot;
  let spend = SIZE;
  const roomLeft = exposure.tighterRoom(state, ROLE, cap);
  if (spend + shot.fee > roomLeft) spend = roomLeft > shot.fee ? roomLeft - shot.fee : 0n;
  if (spend > 250000n) spend = 250000n;
  if (spend < 100000n) return { decision: "research", signed: false, rationale: "The next taker order does not fit 0.1-0.25 XRP inside the caps." };
  const priced = rlusd.quoteBuy(observed.pool, spend);
  const exposureDrops = spend + shot.fee;
  const why = blocked(state, exposureDrops, cap, room);
  if (why) return { decision: "research", signed: false, rationale: why };
  const tx = {
    TransactionType: "OfferCreate",
    Account: anchors.WALLETS.W3.address,
    Flags: 0x00020000,
    TakerGets: spend.toString(),
    TakerPays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: priced.deliver },
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const key = `w3-rlusd-buy-${day}-${shot.sequence}`;
  if (clients && typeof clients.beforeReserve === "function") await clients.beforeReserve();
  let reserved;
  try {
    reserved = reserve(dir, { key, action: "buy", day, exposure: exposureDrops, tx, cap }, shot, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) return quiet;
    throw error;
  }
  if (reserved.terminal) return { decision: "research", replay: true, traded: false, signed: false };
  const sent = await submit(dir, reserved, tx, expectedFor(tx, shot), clients, now, gate, journal);
  return {
    decision: "swap",
    signed: !sent.replay,
    submitted: sent.mission.submitted === true,
    traded: false,
    replay: sent.replay === true,
    send_max_drops: tx.TakerGets,
    flags: tx.Flags,
    fill_proof: sent.fill_proof || null,
  };
}

async function reacquire(clients, mission, account) {
  const hash = String(mission.proof_hash || mission.signed_hash || "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash) || !clients || !clients.ledger) return null;
  let lookup;
  try {
    lookup = await clients.ledger.request({ command: "tx", transaction: hash, binary: false });
  } catch (error) {
    return null;
  }
  const result = lookup && lookup.result;
  const meta = result && (result.meta || result.metaData);
  const tx = result && (result.tx_json || result);
  if (!result || result.validated !== true || !meta || meta.TransactionResult !== "tesSUCCESS") return null;
  if (String(result.hash || "").toUpperCase() !== hash) return null;
  if (!tx || tx.TransactionType !== "OfferCreate" || tx.Account !== account) return null;
  const pays = tx.TakerPays;
  const gets = tx.TakerGets;
  const amounts = [pays, gets].filter((amount) => amount && typeof amount === "object");
  if (amounts.some((amount) => String(amount.issuer || "").includes("rKmPxq"))) return null;
  if (!amounts.some((amount) => amount.currency === rlusd.CURRENCY && amount.issuer === rlusd.ISSUER)) return null;
  const acquired = book.rlusdAcquired(meta, account);
  if (!acquired || acquired === "0" || !market.exactIou(acquired) || market.exactIou(acquired).coeff <= 0n) return null;
  return {
    bought_rlusd: acquired,
    proof_hash: hash,
    proof_result: "tesSUCCESS",
    proof_type: "consuming_tx",
  };
}

function smaller(left, right) {
  const span = Math.max(-left.exp, -right.exp, 0);
  const width = (exact) => exact.coeff * (10n ** BigInt(span + exact.exp));
  return width(left) <= width(right) ? left : right;
}

async function sell(dir, source, now, clients, observed, room, day, gate, cap, journal) {
  const state = view(dir, now);
  if (dayCount(state, day) >= MAX_PER_DAY) return { decision: "research", signed: false, rationale: "W3 has used its daily taker count." };
  const shot = observed.shot;
  const bought = market.exactIou(source.bought_rlusd || "");
  if (!bought || bought.coeff <= 0n) {
    return { decision: "research", signed: false, rationale: "The round trip has no proved RLUSD buy. Nothing is sold." };
  }
  if (!observed.balance || observed.balance.coeff <= 0n) {
    return { decision: "research", signed: false, rationale: "The RLUSD inventory cannot be priced." };
  }
  const capped = smaller(bought, observed.balance);
  const text = formatBalance(capped);
  if (!text) return { decision: "research", signed: false, rationale: "The RLUSD inventory cannot be priced." };
  const pays = sellDrops(observed.pool, capped);
  if (pays == null || pays < 100000n || pays > 250000n) {
    return { decision: "research", signed: false, rationale: "The IOC sell is outside 0.1-0.25 XRP." };
  }
  const exposureDrops = shot.fee;
  const released = BigInt(source.outstanding_drops || "0");
  const teamNext = exposure.teamOpen(state) - released + exposureDrops;
  if (teamNext > cap || exposure.roleOpen(state, ROLE) - released + exposureDrops > exposure.ROLE_CAP.W3) {
    return { decision: "research", signed: false, rationale: "The IOC sell does not fit the caps." };
  }
  if (exposure.blocksNewRisk(state, ROLE)) {
    return { decision: "research", signed: false, rationale: "An uncertain RLUSD hold from another role is still open. Nothing is signed." };
  }
  const tx = {
    TransactionType: "OfferCreate",
    Account: anchors.WALLETS.W3.address,
    Flags: 0x00020000,
    TakerGets: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER, value: text },
    TakerPays: pays.toString(),
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  if (clients && typeof clients.beforeReserve === "function") await clients.beforeReserve();
  let reserved;
  try {
    reserved = reserve(dir, {
      key: `w3-rlusd-sell-${day}-${shot.sequence}`,
      action: "sell",
      day,
      exposure: exposureDrops,
      tx,
      cap,
      release: source.id,
    }, shot, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) return quiet;
    throw error;
  }
  if (reserved.terminal) return { decision: "research", replay: true, signed: false };
  let sent;
  try {
    sent = await submit(dir, reserved, tx, expectedFor(tx, shot), clients, now, gate, journal);
  } catch (error) {
    save(dir, Object.assign({}, source, { outstanding_drops: source.outstanding_drops, updated_at: now }));
    throw error;
  }
  return { decision: "swap", signed: !sent.replay, submitted: sent.mission.submitted === true, traded: false, send_max_drops: tx.TakerPays };
}

function formatBalance(exact) {
  if (!exact || exact.coeff <= 0n) return null;
  let digits = exact.coeff.toString();
  let point = exact.exp;
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

function sellDrops(pool, exact) {
  const span = Math.max(-pool.exact.exp, -exact.exp, 0);
  const width = (value) => value.coeff * (10n ** BigInt(span + value.exp));
  const input = width(exact);
  const poolIou = width(pool.exact);
  if (input <= 0n || poolIou <= 0n) return null;
  const fee = BigInt(pool.tradingFee);
  let out = pool.xrp * input / (poolIou + input);
  out = out * (100000n - fee) / 100000n;
  out = out * 99n / 100n;
  return out > 0n ? out : null;
}

module.exports = {
  KIND,
  ROLE,
  SIZE,
  tick,
  fillProof: book.counterparties,
};
