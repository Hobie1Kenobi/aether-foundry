"use strict";

/**
 * Allowlisted two-asset AMM deposit and LP-token withdraw.
 * Trading-fee capture is not a yield and not a stake. A pool that W1
 * already owns entirely is not external demand. An exit keeps the live
 * pool XRP in the inventory until a later validated read shows it is gone.
 */

const crypto = require("crypto");
const { coded, exclusive } = require("../../missions/ledger");
const { view } = require("../../missions/engine");
const policy = require("../../missions/policy");
const missionConfig = require("../../missions/config");
const anchors = require("../../director/anchors");
const bankroll = require("../bankroll");
const bounds = require("./bounds");
const market = require("./market");
const signer = require("./signer");
const live = require("./live");
const snapshot = require("./snapshot");
const proof = require("./amm-proof");

const TF_TWO_ASSET = 0x00100000;
const TF_LP_TOKEN = 0x00010000;

function missionId(key) {
  return `msn${crypto.createHash("sha256").update(`dex|${key}`).digest("hex").slice(0, 16)}`;
}

function findMission(state, key) {
  return Object.values(state.missions || {}).find((mission) => mission && mission.kind === bankroll.LP_KIND && mission.idempotency_key === key) || null;
}

function assertClients(clients) {
  if (!clients || clients.seed || clients.secret || clients.privateKey) throw coded("refusing caller key material", "SECRET");
  const live = clients.mode === "live" && clients.bound === "w1-dex";
  const injected = clients.mode === "injected" && !clients.url && !clients.ws && !clients.socket;
  if (!live && !injected) throw coded("refusing an unbound socket", "LIVE");
}

async function shotOf(ledger) {
  const server = await ledger.request({ command: "server_info" });
  const account = await ledger.request({ command: "account_info", account: bounds.ACCOUNT, ledger_index: "validated" });
  const fee = await ledger.request({ command: "fee" });
  return snapshot.parseSnapshot({ server, account, fee });
}

function reserve(dir, order, shot, now, observed) {
  return exclusive(dir, (api) => {
    const state = view(dir, now);
    if (state.killed) throw coded("hard stop is on", "killed");
    const position = bankroll.room(state, observed);
    if (position.uncertain) throw coded("bankroll inventory is not proved", position.code || "UNCERTAIN");
    const existing = findMission(state, order.key);
    if (existing) return { mission: existing, created: false };
    if (order.reduce_only) {
      if (bankroll.spendable(observed) < order.exposure) throw coded("W1 cannot pay the reduce-only fee", "SPENDABLE");
    } else if (position.risk_increasing !== true || order.exposure > position.remaining) {
      throw coded(position.aeth_valuation === "unproved" ? "AETH inventory has no independent XRP bid" : "shared 100 XRP bankroll would be exceeded", position.risk_increasing ? "BANKROLL" : "VALUATION");
    }
    const mission = {
      id: missionId(order.key),
      idempotency_key: order.key,
      kind: bankroll.LP_KIND,
      status: "amm_reserved",
      stage: "amm",
      role: bounds.ROLE,
      account: bounds.ACCOUNT,
      issuer: bounds.ISSUER,
      network: missionConfig.NETWORK,
      network_id: missionConfig.NETWORK_ID,
      activity: "lp_fee_capture_not_yield",
      pool: anchors.AMM,
      live: false,
      signed: false,
      submitted: false,
      complete: false,
      hold: "uncertain",
      settlement: "amm_reserved",
      day: policy.chicagoDay(now),
      sequence: shot.sequence,
      signed_ledger: shot.validatedLedger,
      last_ledger_sequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
      fee_drops: shot.fee.toString(),
      reserve_drops: shot.reserveInc.toString(),
      locked_drops: order.locked.toString(),
      outstanding_drops: order.exposure.toString(),
      realized_loss_drops: "0",
      lp_currency: order.lp_currency,
      lp_xrp_basis: order.lp_xrp_basis,
      min_xrp_out: order.min_xrp_out || "0",
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

async function quote(ledger, dir, now) {
  const observed = await market.load(ledger);
  let slip = null;
  try {
    slip = market.slippage(observed.pool, 1000000n);
  } catch (error) {
    slip = { error_code: error.code || "VALUATION" };
  }
  const state = dir ? view(dir, now || new Date().toISOString()) : null;
  return { observed, slip, position: bankroll.room(state, observed) };
}

async function deposit() {
  throw coded("autonomous AMM deposit is not supported", "UNSUPPORTED");
}

async function withdraw(dir, request, clients) {
  assertClients(clients);
  const now = (request && request.now) || new Date().toISOString();
  const observed = await market.load(clients.ledger);
  if (!observed.pool.sole) throw coded("exit is only the proved sole LP position", "POOL");
  const shot = await shotOf(clients.ledger);
  const key = "w1-exit-sole-lp";
  const tx = {
    TransactionType: "AMMWithdraw",
    Account: bounds.ACCOUNT,
    Asset: market.XRP,
    Asset2: { currency: bounds.AETH, issuer: bounds.ISSUER },
    LPTokenIn: { currency: observed.pool.currency, issuer: observed.pool.account, value: observed.pool.balanceText },
    Flags: TF_LP_TOKEN,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const basis = bankroll.room(view(dir, now), observed);
  const reserved = reserve(dir, {
    key,
    locked: 0n,
    exposure: shot.fee,
    reduce_only: true,
    lp_currency: observed.pool.currency,
    lp_xrp_basis: basis.lp_xrp.toString(),
    min_xrp_out: basis.lp_xrp.toString(),
    tx,
  }, shot, now, observed);
  if (reserved.mission.submit_attempted) return publish(reserved.mission, { replay: true });
  const signed = await signer.sign(tx, {
    type: "AMMWithdraw",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    flags: TF_LP_TOKEN,
    lp: tx.LPTokenIn,
  }, clients.sign);
  const mission = Object.assign({}, reserved.mission, {
    signed: true,
    signed_hash: signed.hash,
    status: "amm_unknown",
    submit_attempted: true,
    hold: "uncertain",
    updated_at: now,
  });
  try {
    await clients.submit(signed.tx_blob);
    mission.submitted = true;
  } catch (error) {
    mission.submitted = false;
  }
  save(dir, mission);
  return publish(mission, { replay: false });
}

async function reconcile(dir, request, clients) {
  assertClients(clients);
  const now = (request && request.now) || new Date().toISOString();
  const mission = view(dir, now).missions[request.mission_id];
  if (!mission || mission.kind !== bankroll.LP_KIND || !mission.signed_hash) throw coded("LP mission is not ready to reconcile", "OFFER");
  const lookup = await live.settledRequest((payload) => clients.ledger.request(payload), { command: "tx", transaction: mission.signed_hash, binary: false });
  const fresh = await market.load(clients.ledger);
  const kind = mission.unsigned_tx && mission.unsigned_tx.TransactionType;
  let outcome;
  try {
    outcome = kind === "AMMWithdraw" ? proof.withdrawOutcome(lookup, mission) : proof.depositOutcome(lookup, mission);
  } catch (error) {
    const kept = Object.assign({}, mission, { status: "amm_unknown", proof_reason: error.code || "UNCERTAIN", updated_at: now });
    save(dir, kept);
    return publish(kept, { replay: false });
  }
  if (kind === "AMMDeposit") {
    const kept = Object.assign({}, mission, { status: "amm_unknown", proof_reason: "deposit_unsupported", updated_at: now });
    save(dir, kept);
    return publish(kept, { replay: false });
  }
  const share = fresh.pool.balance === 0n ? 0n : (fresh.pool.xrp * fresh.pool.balance) / fresh.pool.supply;
  const fall = BigInt(mission.lp_xrp_basis || "0") - share;
  if (fall < outcome.xrpOut) {
    const kept = Object.assign({}, mission, { status: "amm_unknown", proof_reason: "pool_not_reduced", updated_at: now });
    save(dir, kept);
    return publish(kept, { replay: false, recovered_drops: "0" });
  }
  bankroll.recover(dir, outcome.xrpOut, share, now);
  const proved = Object.assign({}, mission, {
    status: "amm_proved",
    outstanding_drops: "0",
    hold: "released",
    realized_loss_drops: (BigInt(mission.realized_loss_drops || "0") + outcome.fee + (fall - outcome.xrpOut)).toString(),
    recovered_drops: outcome.xrpOut.toString(),
    proof_hash: outcome.hash,
    updated_at: now,
  });
  save(dir, proved);
  return publish(proved, { replay: false, recovered_drops: outcome.xrpOut.toString() });
}

function publish(mission, extra) {
  return Object.assign({
    schema: "aether.business.amm",
    id: mission.id,
    status: mission.status,
    signed: mission.signed === true,
    submitted: mission.submitted === true,
    outstanding_drops: mission.outstanding_drops,
    hold: mission.hold,
    live_proof: false,
    activity: mission.activity,
    tx: mission.unsigned_tx,
  }, extra || {});
}

module.exports = {
  TF_TWO_ASSET,
  TF_LP_TOKEN,
  quote,
  deposit,
  withdraw,
  reconcile,
};
