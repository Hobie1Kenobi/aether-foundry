"use strict";

/**
 * W3 pool taker. One IOC round-trip leg per tick against official RLUSD.
 * Size stays inside 0.1-0.25 XRP. Role exposure stays at or below 0.5 XRP.
 * The team cap and uncertain holds are shared through the mission ledger.
 * A proved lot is sold only when the pool or book quote, after the AMM
 * trading fee and the transaction fee, covers that tesSUCCESS cost basis
 * plus the configured margin. Realized P&L, including fees, is fsynced per
 * Chicago day and a loss of 50000 drops stops new buys until the next day.
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
const guard = require("./w3-guard");

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
      if (!terminal) assertGuard(dir, order);
      return { mission: existing, created: false, terminal };
    }
    if (order.action === "buy" || order.action === "sell") assertGuard(dir, order);
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
    if (typeof order.costBasis === "string" && /^[0-9]+$/.test(order.costBasis)) {
      mission.cost_basis_drops = order.costBasis;
    }
    if (typeof order.release === "string" && order.release !== LEGACY) mission.release_id = order.release;
    if (typeof order.releaseOutstanding === "string" && /^[0-9]+$/.test(order.releaseOutstanding)) {
      mission.release_outstanding = order.releaseOutstanding;
    }
    if (typeof order.lotRlusd === "string" && order.lotRlusd) mission.lot_rlusd = order.lotRlusd;
    if (typeof order.lotCost === "string" && /^[0-9]+$/.test(order.lotCost)) mission.lot_cost_basis = order.lotCost;
    if (mission.id === LEGACY) throw coded("refusing the legacy mission hold", "HOLD");
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission, created: true };
  });
}

function assertGuard(dir, order) {
  const guardState = guard.read(dir);
  if (guardState.closed) throw coded("The W3 daily loss record is unreadable. Nothing is signed.", "GUARD");
  if (order.action === "buy") {
    if (typeof order.lossCap !== "bigint") throw coded("The W3 daily loss cap is not a safe drop string.", "LOSS");
    if (guard.lossOf(guardState, order.day) >= order.lossCap) {
      throw coded("W3 has reached its Chicago-day loss cap. No new buy is opened.", "LOSS");
    }
  }
}

function caught(error) {
  if (error && (error.code === "CAP" || error.code === "HOLD" || error.code === "DAY" || error.code === "BANKROLL" || error.code === "LOSS" || error.code === "GUARD")) {
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
    const filled = commitProof(dir, mission, proof, now);
    writePublic(journal, proof.journal);
    return { mission: filled, replay: false, fill_proof: proof.journal };
  }
  return { mission, replay: false };
}

function guardDay(mission, now) {
  if (mission && guard.isDay(mission.chicago_day)) return mission.chicago_day;
  return policy.chicagoDay(now);
}

function commitPnl(dir, mission, proof, now) {
  if (!proof || typeof proof.realized_pnl !== "bigint" || proof.realized_pnl === 0n) return null;
  const hash = proof.mission && proof.mission.proof_hash;
  const day = guardDay(mission, now);
  guard.record(dir, day, proof.realized_pnl, hash);
  return day;
}

function commitProof(dir, mission, proof, now) {
  const day = commitPnl(dir, mission, proof, now);
  const filled = Object.assign({}, mission, proof.mission, { updated_at: now });
  if (day) {
    filled.guard_day = day;
    filled.guard_delta_drops = proof.realized_pnl.toString();
  }
  const missions = [filled];
  const restored = restoreSource(dir, now, proof.restore);
  if (restored) missions.push(restored);
  exclusive(dir, (api) => {
    api.appendAll(missions.map((row) => ({ type: "mission.upsert", at: now, mission: row })));
  });
  return filled;
}

function restoreSource(dir, now, restore) {
  if (!restore || !restore.id || restore.id === LEGACY) return null;
  const source = view(dir, now).missions && view(dir, now).missions[restore.id];
  if (!source || source.id === LEGACY || source.action !== "buy") return null;
  return Object.assign({}, source, restore.fields, { updated_at: now });
}

function replayGuard(dir, now) {
  const state = view(dir, now);
  for (const mission of rows(state)) {
    if (mission.guard_delta_drops == null || mission.guard_delta_drops === "0") continue;
    if (typeof mission.guard_delta_drops !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(mission.guard_delta_drops) || mission.guard_delta_drops === "-0") {
      throw coded("The W3 daily loss record is unreadable. Nothing is signed.", "GUARD");
    }
    const delta = BigInt(mission.guard_delta_drops);
    if (delta === 0n) continue;
    const day = guard.isDay(mission.guard_day) ? mission.guard_day : guardDay(mission, now);
    guard.record(dir, day, delta, mission.proof_hash);
  }
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
  if (String(result.hash || "").toUpperCase() !== String(hash || "").toUpperCase()) return null;
  const proof = book.counterparties(meta, self);
  const tx = txBody(result);
  const pays = tx && tx.TakerPays;
  let acquired = book.rlusdAcquired(meta, self) || "0";
  if (acquired !== "0" && pays && typeof pays === "object" && pays.currency === rlusd.CURRENCY && pays.issuer === rlusd.ISSUER) {
    acquired = book.atMost(acquired, pays.value) || "0";
  }
  const settled = {
    status: "rlusd_filled",
    hold: "uncertain",
    bought_rlusd: acquired,
    proof_hash: String(result.hash || hash).toUpperCase(),
    proof_result: "tesSUCCESS",
    proof_type: "consuming_tx",
    outside_fill: proof.outside === true,
    counterparties: proof.accounts,
    outside_accounts: proof.outside_accounts,
  };
  let realized = null;
  let restore = null;
  if (mission && mission.action === "sell") {
    const settled = settleSellProof(meta, tx, self, mission);
    realized = settled.realized;
    restore = settled.restore;
  } else if (!mission || mission.action === "buy") {
    const spent = guard.provedSpend(meta, tx, self);
    if (spent != null && acquired !== "0") settled.cost_basis_drops = spent;
    else if (spent != null && acquired === "0" && mission && mission.action === "buy") realized = -BigInt(spent);
  }
  return {
    mission: settled,
    realized_pnl: realized,
    restore,
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
  try {
    replayGuard(dir, now);
  } catch (error) {
    const quiet = caught(error);
    if (quiet) {
      return Object.assign({
        learning: false,
        traded: false,
        role: ROLE,
        rlusd_team_open_drops: exposure.teamOpen(state).toString(),
        rlusd_role_open_drops: exposure.roleOpen(state, ROLE).toString(),
        rlusd_team_cap_drops: cap == null ? null : cap.toString(),
      }, quiet);
    }
    throw error;
  }
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
      try {
        commitProof(dir, pending, proved, now);
      } catch (error) {
        const quiet = caught(error);
        if (quiet) return Object.assign(base, quiet);
        throw error;
      }
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
  if (inventory && inventory.id === LEGACY) inventory = null;
  let held = inventory ? market.exactIou(inventory.bought_rlusd || "") : null;
  if (inventory && (!held || held.coeff <= 0n || !hasProvedBasis(inventory))) {
    const refreshed = await reacquire(clients, inventory, anchors.WALLETS.W3.address);
    if (refreshed) {
      inventory = Object.assign({}, inventory, refreshed, { updated_at: now });
      save(dir, inventory);
      held = market.exactIou(inventory.bought_rlusd || "");
    }
  }
  if (inventory && observed.balance.coeff > 0n) return Object.assign(base, await sell(dir, inventory, now, clients, observed, room, day, gate, cap, journal, env));
  if (!observed.trustline) return Object.assign(base, await trust(dir, now, clients, observed, room, day, gate, cap));
  return Object.assign(base, await buy(dir, now, clients, observed, room, day, gate, cap, journal, env));
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

async function buy(dir, now, clients, observed, room, day, gate, cap, journal, env) {
  const state = view(dir, now);
  if (dayCount(state, day) >= MAX_PER_DAY) return { decision: "research", signed: false, rationale: "W3 has used its daily taker count." };
  const lossLimit = guard.lossCap(env);
  if (lossLimit == null) return { decision: "research", signed: false, rationale: "The W3 daily loss cap is not a safe drop string." };
  const guardState = guard.inspect(dir, day);
  if (guardState.closed) return { decision: "research", signed: false, rationale: "The W3 daily loss record is unreadable. Nothing is signed." };
  if (guardState.loss >= lossLimit) return { decision: "research", signed: false, rationale: "W3 has reached its Chicago-day loss cap. No new buy is opened." };
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
    reserved = reserve(dir, { key, action: "buy", day, exposure: exposureDrops, tx, cap, lossCap: lossLimit }, shot, now);
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

function settleSellProof(meta, tx, self, mission) {
  const empty = { realized: null, restore: null };
  if (typeof mission.cost_basis_drops !== "string" || !/^[0-9]+$/.test(mission.cost_basis_drops)) return empty;
  const delta = guard.accountDelta(meta, self);
  if (delta == null) return empty;
  const stored = BigInt(mission.cost_basis_drops);
  const disposedText = book.rlusdDisposed(meta, self);
  const disposed = disposedText == null ? null : market.exactIou(disposedText);
  const lot = market.exactIou(mission.lot_rlusd || "");
  const lotCostOk = typeof mission.lot_cost_basis === "string" && /^[0-9]+$/.test(mission.lot_cost_basis);
  if (disposed && lot && lot.coeff > 0n && lotCostOk) {
    const settlement = guard.settledSell(BigInt(mission.lot_cost_basis), lot, disposed, delta);
    if (settlement && !settlement.legacy) {
      return { realized: settlement.realized, restore: restoreFields(mission, settlement) };
    }
  }
  if (disposedText === "0" && delta <= 0n) {
    return { realized: delta, restore: restoreFields(mission, { full: false, remainder: null, unsold: true }) };
  }
  return { realized: delta - stored, restore: null };
}

function restoreFields(mission, settlement) {
  if (!mission.release_id || mission.release_id === LEGACY) return null;
  if (settlement.unsold) {
    if (typeof mission.release_outstanding !== "string") return null;
    return { id: mission.release_id, fields: { outstanding_drops: mission.release_outstanding } };
  }
  if (!settlement.remainder || settlement.full) return null;
  const bought = formatBalance(settlement.remainder);
  if (!bought || typeof settlement.remainderBasis !== "bigint" || settlement.remainderBasis <= 0n) return null;
  return {
    id: mission.release_id,
    fields: {
      bought_rlusd: bought,
      cost_basis_drops: settlement.remainderBasis.toString(),
      outstanding_drops: settlement.remainderBasis.toString(),
      status: "rlusd_filled",
      hold: "uncertain",
      action: "buy",
    },
  };
}

function txBody(result) {
  const nested = result && result.tx_json;
  if (nested && nested.TransactionType) return nested;
  return result || null;
}

function sequenceText(value) {
  if (typeof value === "bigint") return value > 0n ? value.toString() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function officialBuy(tx, account) {
  if (!tx || tx.TransactionType !== "OfferCreate" || tx.Account !== account) return null;
  if (!account || account === anchors.WALLETS.W0.address) return null;
  if (JSON.stringify(tx).includes("rKmPxq")) return null;
  if (tx.NetworkID != null && Number(tx.NetworkID) !== 1) return null;
  if (Number(tx.Flags) !== 0x00020000) return null;
  if (typeof tx.TakerGets !== "string" || !/^[0-9]+$/.test(tx.TakerGets)) return null;
  const pays = tx.TakerPays;
  if (!pays || typeof pays !== "object") return null;
  if (pays.currency !== rlusd.CURRENCY || pays.issuer !== rlusd.ISSUER) return null;
  if (String(pays.issuer).includes("rKmPxq")) return null;
  const ceiling = market.exactIou(pays.value);
  if (!ceiling || ceiling.coeff <= 0n) return null;
  return pays.value;
}

async function reacquire(clients, mission, account) {
  if (!mission || mission.id === LEGACY || mission.account !== account || account === anchors.WALLETS.W0.address) return null;
  const proofHash = String(mission.proof_hash || "").toUpperCase();
  const signedHash = String(mission.signed_hash || "").toUpperCase();
  if (proofHash && signedHash && proofHash !== signedHash) return null;
  const hash = proofHash || signedHash;
  const wanted = sequenceText(mission.sequence);
  if (!wanted || !/^[0-9A-F]{64}$/.test(hash) || !clients || !clients.ledger) return null;
  let lookup;
  try {
    lookup = await clients.ledger.request({ command: "tx", transaction: hash, binary: false });
  } catch (error) {
    return null;
  }
  const result = lookup && lookup.result;
  const meta = result && (result.meta || result.metaData);
  const tx = txBody(result);
  if (!result || result.validated !== true || !meta || meta.TransactionResult !== "tesSUCCESS") return null;
  if (String(result.hash || "").toUpperCase() !== hash) return null;
  const ceiling = officialBuy(tx, account);
  if (!ceiling || sequenceText(tx && tx.Sequence) !== wanted) return null;
  const capped = book.atMost(book.rlusdAcquired(meta, account), ceiling);
  if (!capped || capped === "0" || !market.exactIou(capped) || market.exactIou(capped).coeff <= 0n) return null;
  const refreshed = {
    bought_rlusd: capped,
    proof_hash: hash,
    proof_result: "tesSUCCESS",
    proof_type: "consuming_tx",
  };
  const spent = guard.provedSpend(meta, tx, account);
  if (spent != null) refreshed.cost_basis_drops = spent;
  return refreshed;
}

function smaller(left, right) {
  const span = Math.max(-left.exp, -right.exp, 0);
  const width = (exact) => exact.coeff * (10n ** BigInt(span + exact.exp));
  return width(left) <= width(right) ? left : right;
}

function hasProvedBasis(source) {
  return Boolean(source
    && source.proof_result === "tesSUCCESS"
    && source.proof_type === "consuming_tx"
    && typeof source.proof_hash === "string"
    && /^[0-9A-F]{64}$/.test(source.proof_hash.toUpperCase())
    && typeof source.cost_basis_drops === "string"
    && /^(?:0|[1-9][0-9]*)$/.test(source.cost_basis_drops)
    && BigInt(source.cost_basis_drops) > 0n);
}

function provedBasis(source, bought, sold) {
  if (!hasProvedBasis(source)) return null;
  const basis = guard.portion(BigInt(source.cost_basis_drops), bought, sold);
  return basis == null ? false : basis;
}

function amountWidth(exact, span) {
  return exact.coeff * (10n ** BigInt(span + exact.exp));
}

async function sell(dir, source, now, clients, observed, room, day, gate, cap, journal, env) {
  let state = view(dir, now);
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
  const guardState = guard.inspect(dir, day);
  if (guardState.closed) return { decision: "research", signed: false, rationale: "The W3 daily loss record is unreadable. Nothing is signed." };
  let basis = provedBasis(source, bought, capped);
  if (basis == null) {
    return { decision: "research", signed: false, rationale: "The RLUSD lot has no tesSUCCESS cost basis. Nothing is sold." };
  }
  if (basis === false) {
    return { decision: "research", signed: false, rationale: "The IOC sell price does not cover the proved cost basis. The RLUSD stays put." };
  }
  const heldSpan = Math.max(-bought.exp, -capped.exp, 0);
  if (amountWidth(capped, heldSpan) < amountWidth(bought, heldSpan)) {
    const fullCost = BigInt(source.cost_basis_drops);
    const missing = fullCost > basis ? fullCost - basis : 0n;
    if (missing > 0n) {
      const proof = String(source.proof_hash).toUpperCase();
      const missingHash = crypto.createHash("sha256").update(`w3-unheld|${proof}`).digest("hex").toUpperCase();
      try {
        guard.record(dir, day, -missing, missingHash);
      } catch (error) {
        const quiet = caught(error);
        if (quiet) return quiet;
        throw error;
      }
    }
    source = Object.assign({}, source, {
      bought_rlusd: text,
      cost_basis_drops: basis.toString(),
      outstanding_drops: basis.toString(),
      updated_at: now,
    });
    save(dir, source);
  }
  let pays = sellDrops(observed.pool, capped);
  const margin = guard.sellMargin(env);
  if (margin == null) return { decision: "research", signed: false, rationale: "The W3 sell margin is not a safe drop string." };
  const quoted = guard.netProceeds(observed.pool, observed.bids, capped, shot.fee);
  if (quoted == null || quoted < basis + margin) {
    return { decision: "research", signed: false, rationale: "The IOC sell price does not cover the proved cost basis. The RLUSD stays put." };
  }
  const floor = basis + margin + shot.fee;
  if (pays == null || pays < floor) pays = floor;
  if (pays == null || pays < 100000n || pays > 250000n) {
    return { decision: "research", signed: false, rationale: "The IOC sell is outside 0.1-0.25 XRP." };
  }
  state = view(dir, now);
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
      releaseOutstanding: source.outstanding_drops,
      lotRlusd: text,
      lotCost: basis.toString(),
      costBasis: basis.toString(),
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
