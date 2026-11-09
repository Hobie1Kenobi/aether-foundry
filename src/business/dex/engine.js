"use strict";

/**
 * W1 book offers on the shared mission ledger.
 * Reservations use the mission budget events. This module does not open a
 * socket, read a seed, or submit unless the caller injects those clients.
 */

const crypto = require("crypto");
const { exclusive, coded } = require("../../missions/ledger");
const { view } = require("../../missions/engine");
const policy = require("../../missions/policy");
const missionConfig = require("../../missions/config");
const bounds = require("./bounds");
const snapshot = require("./snapshot");
const proof = require("./proof");
const signer = require("./signer");

const BANNED = [
  "account",
  "wallet",
  "wallet_id",
  "destination",
  "fee",
  "fee_drops",
  "sequence",
  "owner_reserve",
  "owner_reserve_drops",
  "network",
  "network_id",
  "flags",
  "last_ledger_sequence",
  "lastLedgerSequence",
  "memos",
  "Memos",
  "seed",
  "secret",
  "filled",
  "cancelled",
  "expired",
  "validated_hash",
  "open_offers",
];

function scaled(value) {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
}

function drops(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function iou(value) {
  if (!value || typeof value !== "object") return null;
  if (value.currency !== bounds.AETH || value.issuer !== bounds.ISSUER) return null;
  if (typeof value.value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value.value)) return null;
  const amount = scaled(value.value);
  if (amount <= 0n || amount > scaled(bounds.MAX_AETH)) return null;
  return { currency: value.currency, issuer: value.issuer, value: value.value };
}

function assertClients(clients) {
  if (!clients || clients.seed || clients.secret || clients.privateKey) throw coded("refusing caller key material", "SECRET");
  const live = clients.mode === "live" && clients.bound === "w1-dex";
  const injected = clients.mode === "injected" && !clients.url && !clients.ws && !clients.socket;
  if (!live && !injected) throw coded("refusing an unbound socket", "LIVE");
  if (!clients.ledger || typeof clients.ledger.request !== "function") throw coded("ledger client is not configured", "NO_CLIENT");
  if (typeof clients.sign !== "function" || typeof clients.submit !== "function") throw coded("sign or submit client is not configured", "NO_CLIENT");
}

function assertRequest(request) {
  const body = request || {};
  for (const key of BANNED) {
    if (body[key] != null) throw coded("the caller cannot choose the wallet, destination, fee, sequence, reserve, or proof", "CALLER");
  }
  const key = String(body.idempotency_key || "");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("idempotency_key is missing", "IDEMPOTENCY");
  const paysXrp = drops(body.taker_pays);
  const getsXrp = drops(body.taker_gets);
  const paysIou = iou(body.taker_pays);
  const getsIou = iou(body.taker_gets);
  if ((paysXrp == null) === (getsXrp == null) || (paysIou == null) === (getsIou == null)) {
    throw coded("offer must exchange XRP and AETH issued by W0", "ASSET");
  }
  const locked = getsXrp == null ? 0n : getsXrp;
  if (locked > bounds.MAX_LOCKED_DROPS) throw coded("locked XRP exceeds the operator bound", "CAP");
  return {
    key,
    takerPays: paysXrp == null ? paysIou : paysXrp.toString(),
    takerGets: getsXrp == null ? getsIou : getsXrp.toString(),
    locked,
  };
}

function missionId(key) {
  return `msn${crypto.createHash("sha256").update(`dex|${key}`).digest("hex").slice(0, 16)}`;
}

function findMission(state, key) {
  return Object.values(state.missions).find((mission) => mission && mission.kind === bounds.KIND && mission.idempotency_key === key) || null;
}

function outstanding(mission) {
  return BigInt((mission && mission.outstanding_drops) || "0");
}

function sequenceHeld(state, sequence) {
  return Object.values(state.missions).some((mission) => (
    mission
    && mission.kind === bounds.KIND
    && mission.sequence === sequence
    && mission.hold !== "released"
    && outstanding(mission) > 0n
  ));
}

function reserve(dir, order, shot, now) {
  const exposure = order.locked + shot.fee + shot.reserveInc;
  if (exposure <= 0n || exposure > missionConfig.PER_MISSION_DROPS) throw coded("offer exposure exceeds 1000000 drops", "CAP");
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    if (state.killed) throw coded("hard stop is on", "killed");
    const existing = findMission(state, order.key);
    if (existing) return { mission: existing, created: false };
    if (sequenceHeld(state, shot.sequence)) throw coded("validated sequence is already reserved", "SEQUENCE");
    const day = policy.chicagoDay(now);
    if (policy.dayUsed(state, day) + exposure > missionConfig.DAILY_DROPS) throw coded("Chicago-day cap would be exceeded", "CAP");
    const mission = {
      id: missionId(order.key),
      idempotency_key: order.key,
      kind: bounds.KIND,
      status: "dex_reserved",
      stage: "dex",
      role: bounds.ROLE,
      account: bounds.ACCOUNT,
      issuer: bounds.ISSUER,
      network: missionConfig.NETWORK,
      network_id: missionConfig.NETWORK_ID,
      activity: "book_resting_offer_not_customer_revenue",
      price_source: "operator_limit",
      book_checked: false,
      live: false,
      signed: false,
      submitted: false,
      complete: false,
      hold: "uncertain",
      settlement: "dex_reserved",
      day,
      sequence: shot.sequence,
      signed_ledger: shot.validatedLedger,
      last_ledger_sequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
      fee_drops: shot.fee.toString(),
      reserve_drops: shot.reserveInc.toString(),
      locked_drops: order.locked.toString(),
      outstanding_drops: exposure.toString(),
      taker_pays: order.takerPays,
      taker_gets: order.takerGets,
      fee_settled: false,
      cancel_fee_settled: false,
      sign_claimed: false,
      submit_attempted: false,
      foreign_revenue_drops: "0",
      budget: {
        payment_drops: order.locked.toString(),
        network_fee_drops: shot.fee.toString(),
        account_reserve_drops: shot.reserveInc.toString(),
        budget_drops: exposure.toString(),
      },
      unsigned_tx: {
        TransactionType: "OfferCreate",
        Account: bounds.ACCOUNT,
        TakerPays: order.takerPays,
        TakerGets: order.takerGets,
        Fee: shot.fee.toString(),
        Sequence: shot.sequence,
        LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
        Flags: bounds.TF_PASSIVE,
      },
      updated_at: now,
    };
    api.appendAll([
      {
        type: "budget.reserved",
        at: now,
        mission_id: mission.id,
        day,
        budget_drops: exposure.toString(),
        components: mission.budget,
        live: false,
      },
      {
        type: "budget.uncertain",
        at: now,
        mission_id: mission.id,
        day,
        drops: exposure.toString(),
        settlement: "dex_reserved",
        live: false,
      },
      { type: "mission.upsert", at: now, mission },
    ]);
    return { mission, created: true };
  });
}

function stored(mission) {
  const copy = Object.assign({}, mission);
  delete copy.ledger_dir;
  return copy;
}

function save(dir, mission) {
  exclusive(dir, (api) => {
    api.append({ type: "mission.upsert", at: mission.updated_at, mission: stored(mission) });
  });
}

function move(dir, mission, settled, released) {
  exclusive(dir, (api) => {
    const events = [];
    if (settled > 0n) {
      events.push({
        type: "budget.settled",
        at: mission.updated_at,
        mission_id: mission.id,
        day: mission.day,
        drops: settled.toString(),
        from: "uncertain",
        live: false,
      });
    }
    if (released > 0n) {
      events.push({
        type: "budget.unsigned_released",
        at: mission.updated_at,
        mission_id: mission.id,
        day: mission.day,
        drops: released.toString(),
        reason: "dex_proof",
        live: false,
      });
    }
    events.push({ type: "mission.upsert", at: mission.updated_at, mission: stored(mission) });
    api.appendAll(events);
  });
}

function expectedCreate(mission) {
  return {
    type: "OfferCreate",
    account: bounds.ACCOUNT,
    sequence: mission.sequence,
    last: mission.last_ledger_sequence,
    fee: mission.fee_drops,
    taker_pays: mission.taker_pays,
    taker_gets: mission.taker_gets,
  };
}

async function fetchSnapshot(ledger) {
  const server = await ledger.request({ command: "server_info" });
  const account = await ledger.request({ command: "account_info", account: bounds.ACCOUNT, ledger_index: "validated" });
  const fee = await ledger.request({ command: "fee" });
  const shot = snapshot.parseSnapshot({ server, account, fee });
  return { shot, server };
}

function offerLockedDrops(row) {
  const gets = row && (row.taker_gets != null ? row.taker_gets : row.TakerGets);
  return typeof gets === "string" && /^[0-9]+$/.test(gets) ? BigInt(gets) : 0n;
}

async function ownBook(ledger) {
  const page = await ledger.request({
    command: "account_offers",
    account: bounds.ACCOUNT,
    ledger_index: "validated",
  });
  const result = page && page.result;
  if (!result || result.validated !== true || result.account !== bounds.ACCOUNT || !Array.isArray(result.offers) || result.marker != null) {
    throw coded("validated account offers are missing", "UNCERTAIN");
  }
  let locked = 0n;
  for (const row of result.offers) locked += offerLockedDrops(row);
  return { count: result.offers.length, locked };
}

async function place(dir, request, clients) {
  assertClients(clients);
  const order = assertRequest(request);
  const now = request.now || new Date().toISOString();
  const prior = Object.values(view(dir, now).missions || {}).find((mission) => mission && mission.kind === bounds.KIND && mission.idempotency_key === order.key);
  if (!prior) {
    const book = await ownBook(clients.ledger);
    if (book.count > 0) {
      const used = policy.dayUsed(view(dir, now), policy.chicagoDay(now));
      const error = coded("W1 book has only its own quotes. No new order.", "OBSERVE");
      error.preexisting_locked_drops = book.locked.toString();
      error.day_used_drops = used.toString();
      error.offer_count = book.count;
      error.cap_blocked = used + book.locked > missionConfig.DAILY_DROPS;
      throw error;
    }
  }
  const { shot } = await fetchSnapshot(clients.ledger);
  snapshot.assertSpendable(shot, order.locked);
  const reserved = reserve(dir, order, shot, now);
  let mission = reserved.mission;
  if (mission.submit_attempted) return publish(mission, { replay: true, created: false });
  if (!mission.signed_blob) {
    const signed = await signer.sign(mission.unsigned_tx, expectedCreate(mission), clients.sign);
    mission = Object.assign({}, mission, {
      signed: true,
      signed_blob: signed.tx_blob,
      signed_hash: signed.hash,
      status: "dex_signed",
      sign_claimed: false,
      updated_at: now,
    });
    save(dir, mission);
  }
  const claim = exclusive(dir, (api) => {
    const current = view(dir, now).missions[mission.id];
    if (!current || current.submit_attempted) return { submit: false, mission: current || mission };
    const next = Object.assign({}, current, { submit_attempted: true, updated_at: now });
    api.append({ type: "mission.upsert", at: now, mission: next });
    return { submit: true, mission: next };
  });
  if (!claim.submit) return publish(claim.mission, { replay: true, created: false });
  mission = claim.mission;
  let preliminary;
  try {
    preliminary = await clients.submit(mission.signed_blob);
  } catch (error) {
    mission = Object.assign({}, mission, { status: "dex_unknown", submit_error: error.code || "SUBMIT", updated_at: now });
    save(dir, mission);
    return publish(mission, { replay: false, created: reserved.created });
  }
  const engineResult = preliminary && preliminary.result && preliminary.result.engine_result;
  mission = Object.assign({}, mission, {
    submitted: engineResult === "tesSUCCESS",
    status: engineResult === "tesSUCCESS" ? "dex_submitted" : "dex_unknown",
    engine_result: engineResult || null,
    updated_at: now,
  });
  save(dir, mission);
  return publish(mission, { replay: false, created: reserved.created });
}

function applyCreate(mission, outcome, now) {
  const fee = mission.fee_settled ? 0n : BigInt(mission.fee_drops);
  const filled = outcome.filled;
  const settle = fee + filled;
  let release = 0n;
  let outstandingDrops = outcome.remaining + BigInt(mission.reserve_drops);
  if (!outcome.open) {
    release = BigInt(mission.reserve_drops);
    outstandingDrops = 0n;
  }
  const next = Object.assign({}, mission, {
    status: outcome.open ? (filled > 0n ? "dex_partial" : "dex_open") : "dex_filled",
    fee_settled: true,
    filled_drops: (BigInt(mission.filled_drops || "0") + filled).toString(),
    remaining_drops: outcome.remaining.toString(),
    outstanding_drops: outstandingDrops.toString(),
    proof_hash: outcome.hash,
    create_seen: true,
    create_ledger: outcome.ledgerIndex,
    hold: outstandingDrops === 0n ? "released" : "uncertain",
    complete: false,
    updated_at: now,
  });
  move(dirOf(mission), next, settle, release);
  return next;
}

function dirOf(mission) {
  if (!mission.ledger_dir) throw coded("mission ledger is missing", "LEDGER");
  return mission.ledger_dir;
}

async function reconcile(dir, request, clients) {
  assertClients(clients);
  const body = request || {};
  for (const key of ["filled", "cancelled", "expired", "validated_hash", "open_offers"]) {
    if (body[key] != null) throw coded("reconciliation does not accept a caller observation", "CALLER");
  }
  const now = body.now || new Date().toISOString();
  const state = view(dir, now);
  const mission = state.missions[body.mission_id];
  if (!mission || mission.kind !== bounds.KIND) throw coded("offer mission not found", "OFFER");
  const working = Object.assign({}, mission, { ledger_dir: dir });
  if (!working.signed_hash) return publish(working, { replay: true });
  const lookup = await clients.ledger.request({ command: "tx", transaction: working.signed_hash, binary: false });
  let absent = { proven: false, reason: "not_proven" };
  try {
    absent = await proof.proveAbsence(clients, working);
  } catch (error) {
    absent = { proven: false, reason: error.code || "PROOF" };
  }
  const absenceAllowed = !working.create_seen && working.status !== "dex_open" && working.status !== "dex_partial" && working.status !== "dex_filled" && working.status !== "dex_cancelled";
  if (absenceAllowed && absent.proven === true && absent.creation_proven === true && absent.history_covers === true && working.hold !== "released") {
    const release = outstanding(working);
    const next = Object.assign({}, working, {
      status: "dex_absent",
      outstanding_drops: "0",
      hold: "released",
      complete: false,
      proof_reason: absent.reason,
      updated_at: now,
    });
    move(dir, next, 0n, release);
    return publish(next, { replay: false });
  }
  let outcome;
  try {
    outcome = proof.createOutcome(lookup, working);
  } catch (error) {
    const next = Object.assign({}, working, { status: "dex_unresolved", proof_reason: error.code || "PROOF", updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  let listed;
  try {
    const page = await clients.ledger.request({
      command: "account_offers",
      account: bounds.ACCOUNT,
      ledger_index: outcome.ledgerIndex,
    });
    listed = proof.containsOffer(proof.listedOffers(page, outcome.ledgerIndex), working.sequence, outcome.remainder);
  } catch (error) {
    const next = Object.assign({}, working, { status: "dex_unresolved", proof_reason: error.code || "UNCERTAIN", create_seen: true, updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  if (outcome.open !== listed) {
    const next = Object.assign({}, working, { status: "dex_unresolved", proof_reason: "offer_list", create_seen: true, updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  if (working.status === "dex_open" || working.status === "dex_partial" || working.status === "dex_filled") {
    return publish(working, { replay: true });
  }
  return publish(applyCreate(working, outcome, now), { replay: false });
}

async function cancel(dir, request, clients) {
  assertClients(clients);
  const body = request || {};
  for (const key of BANNED) {
    if (body[key] != null) throw coded("the caller cannot choose the cancel fee, sequence, or proof", "CALLER");
  }
  const now = body.now || new Date().toISOString();
  const state = view(dir, now);
  const mission = state.missions[body.mission_id];
  if (!mission || mission.kind !== bounds.KIND) throw coded("offer mission not found", "OFFER");
  if (mission.cancel_blob) return publish(mission, { replay: true });
  if (mission.status !== "dex_open" && mission.status !== "dex_partial") throw coded("offer is not reconciled open", "OFFER");
  const { shot } = await fetchSnapshot(clients.ledger);
  if (shot.sequence <= mission.sequence) throw coded("validated sequence has not moved past the offer", "LEDGER");
  const fee = shot.fee;
  const claimed = exclusive(dir, (api) => {
    const current = view(dir, now).missions[mission.id];
    if (!current || current.cancel_blob || current.cancel_tx) return current;
    const day = current.day;
    const nextCommitted = BigInt(current.budget.budget_drops) + fee;
    if (nextCommitted > missionConfig.PER_MISSION_DROPS) throw coded("offer exposure exceeds 1000000 drops", "CAP");
    if (policy.dayUsed(view(dir, now), policy.chicagoDay(now)) + fee > missionConfig.DAILY_DROPS) {
      throw coded("Chicago-day cap would be exceeded", "CAP");
    }
    const cancelTx = {
      TransactionType: "OfferCancel",
      Account: bounds.ACCOUNT,
      OfferSequence: current.sequence,
      Fee: fee.toString(),
      Sequence: shot.sequence,
      LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
    };
    const next = Object.assign({}, current, {
      cancel_tx: cancelTx,
      cancel_sequence: shot.sequence,
      cancel_fee_drops: fee.toString(),
      outstanding_drops: (outstanding(current) + fee).toString(),
      updated_at: now,
    });
    api.appendAll([
      {
        type: "budget.reserved",
        at: now,
        mission_id: next.id,
        day,
        budget_drops: fee.toString(),
        components: { network_fee_drops: fee.toString(), budget_drops: fee.toString() },
        live: false,
      },
      {
        type: "budget.uncertain",
        at: now,
        mission_id: next.id,
        day,
        drops: fee.toString(),
        settlement: "dex_cancel",
        live: false,
      },
      { type: "mission.upsert", at: now, mission: next },
    ]);
    return next;
  });
  if (!claimed || claimed.cancel_blob) return publish(claimed || mission, { replay: true });
  const signed = await signer.sign(claimed.cancel_tx, {
    type: "OfferCancel",
    account: bounds.ACCOUNT,
    sequence: claimed.cancel_sequence,
    last: claimed.cancel_tx.LastLedgerSequence,
    fee: claimed.cancel_fee_drops,
    offer_sequence: claimed.sequence,
  }, clients.sign);
  let next = Object.assign({}, claimed, {
    cancel_blob: signed.tx_blob,
    cancel_hash: signed.hash,
    cancel_submit_attempted: true,
    updated_at: now,
  });
  save(dir, next);
  try {
    await clients.submit(next.cancel_blob);
  } catch (error) {
    next = Object.assign({}, next, { status: "dex_unknown", submit_error: error.code || "SUBMIT", updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  const lookup = await clients.ledger.request({ command: "tx", transaction: next.cancel_hash, binary: false });
  let outcome;
  try {
    outcome = proof.cancelOutcome(lookup, next);
  } catch (error) {
    next = Object.assign({}, next, { status: "dex_unresolved", proof_reason: error.code || "PROOF", updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  let listed;
  try {
    const page = await clients.ledger.request({
      command: "account_offers",
      account: bounds.ACCOUNT,
      ledger_index: outcome.ledgerIndex,
    });
    listed = proof.containsOffer(proof.listedOffers(page, outcome.ledgerIndex), next.sequence, null);
  } catch (error) {
    next = Object.assign({}, next, { status: "dex_unresolved", proof_reason: error.code || "UNCERTAIN", updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  if (outcome.deleted === listed) {
    next = Object.assign({}, next, { status: "dex_unresolved", proof_reason: "offer_list", updated_at: now });
    save(dir, next);
    return publish(next, { replay: false });
  }
  if (!outcome.deleted) {
    const feeOnly = next.cancel_fee_settled ? 0n : BigInt(next.cancel_fee_drops);
    next = Object.assign({}, next, {
      status: "dex_unresolved",
      proof_reason: "offer_not_deleted",
      cancel_fee_settled: true,
      outstanding_drops: (outstanding(next) - feeOnly).toString(),
      updated_at: now,
    });
    move(dir, next, feeOnly, 0n);
    return publish(next, { replay: false });
  }
  const feeOnly = next.cancel_fee_settled ? 0n : BigInt(next.cancel_fee_drops);
  const release = outstanding(next) - feeOnly;
  next = Object.assign({}, next, {
    status: "dex_cancelled",
    cancel_fee_settled: true,
    outstanding_drops: "0",
    hold: "released",
    complete: false,
    proof_hash: outcome.hash,
    updated_at: now,
  });
  move(dir, next, feeOnly, release);
  return publish(next, { replay: false });
}

function publish(mission, extra) {
  return Object.assign({
    schema: "aether.business.dex",
    id: mission.id,
    status: mission.status,
    activated: false,
    live: false,
    signed: mission.signed === true,
    submitted: mission.submitted === true,
    account: mission.account,
    issuer: mission.issuer,
    network: mission.network,
    activity: mission.activity,
    outstanding_drops: mission.outstanding_drops,
    locked_drops: mission.locked_drops,
    fee_drops: mission.fee_drops,
    reserve_drops: mission.reserve_drops,
    sequence: mission.sequence,
    last_ledger_sequence: mission.last_ledger_sequence,
    signed_hash: mission.signed_hash || null,
    proof_hash: mission.proof_hash || null,
    proof_reason: mission.proof_reason || null,
    tx: mission.unsigned_tx,
    hold: mission.hold,
  }, extra || {});
}

async function consume(dir, request, clients) {
  assertClients(clients);
  const body = request || {};
  for (const key of ["filled", "cancelled", "expired", "validated_hash", "open_offers"]) {
    if (body[key] != null) throw coded("reconciliation does not accept a caller observation", "CALLER");
  }
  const now = body.now || new Date().toISOString();
  const mission = view(dir, now).missions[body.mission_id];
  if (!mission || mission.kind !== bounds.KIND) throw coded("offer mission not found", "OFFER");
  if (mission.status !== "dex_open" && mission.status !== "dex_partial") throw coded("offer is not reconciled open", "OFFER");
  if (!Number.isInteger(mission.create_ledger) || mission.create_ledger <= 0) throw coded("create ledger is missing", "PROOF");
  const server = await clients.ledger.request({ command: "server_info" });
  const info = server && server.result && server.result.info;
  const validated = info && info.validated_ledger && info.validated_ledger.seq;
  if (!info || Number(info.network_id) !== 1 || !Number.isInteger(validated) || validated < mission.create_ledger) {
    throw coded("validated testnet ledger is missing", "LEDGER");
  }
  const page = await clients.ledger.request({
    command: "account_tx",
    account: bounds.ACCOUNT,
    ledger_index_min: mission.create_ledger,
    ledger_index_max: validated,
    binary: false,
    forward: true,
  });
  const result = page && page.result;
  if (!result || result.validated !== true || result.marker != null || !Array.isArray(result.transactions)) {
    throw coded("account history page is incomplete", "UNCERTAIN");
  }
  const hits = [];
  for (const entry of result.transactions) {
    const row = entry && entry.validated == null ? Object.assign({ validated: true }, entry) : entry;
    if (row && row.validated === false) continue;
    let outcome;
    try {
      outcome = proof.consumeOutcome(row, mission);
    } catch (error) {
      const next = Object.assign({}, mission, { status: "dex_unresolved", proof_reason: error.code || "UNCERTAIN", updated_at: now });
      save(dir, next);
      return publish(next, { replay: false });
    }
    if (outcome) hits.push(outcome);
  }
  if (hits.length === 0) return publish(mission, { replay: true });
  if (hits.length !== 1) throw coded("more than one consuming trade is unresolved", "UNCERTAIN");
  const outcome = hits[0];
  const filled = outcome.filled;
  const reserve = BigInt(mission.reserve_drops);
  const nextOutstanding = outcome.open ? outcome.remaining + reserve : 0n;
  const previous = outstanding(mission);
  const release = previous - filled - nextOutstanding;
  if (release < 0n) throw coded("consuming trade does not fit the reserved remainder", "UNCERTAIN");
  const next = Object.assign({}, mission, {
    status: outcome.open ? "dex_partial" : "dex_filled",
    filled_drops: (BigInt(mission.filled_drops || "0") + filled).toString(),
    remaining_drops: outcome.remaining.toString(),
    outstanding_drops: nextOutstanding.toString(),
    proof_hash: outcome.hash,
    hold: nextOutstanding === 0n ? "released" : "uncertain",
    foreign_revenue_drops: "0",
    updated_at: now,
  });
  move(dir, next, filled, release);
  return publish(next, { replay: false });
}

module.exports = {
  inspectBook: ownBook,
  place,
  reconcile,
  cancel,
  consume,
  publish,
};
