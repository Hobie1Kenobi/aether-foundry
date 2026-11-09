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
const snapshot = require("./snapshot");

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
    if (order.exposure > position.remaining) throw coded("shared 100 XRP bankroll would be exceeded", "BANKROLL");
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

async function quote(ledger) {
  const observed = await market.load(ledger);
  let slip = null;
  try {
    slip = market.slippage(observed.pool, 1000000n);
  } catch (error) {
    slip = { error_code: error.code || "VALUATION" };
  }
  return { observed, slip, position: bankroll.room(null, observed) };
}

async function deposit(dir, request, clients) {
  assertClients(clients);
  const now = (request && request.now) || new Date().toISOString();
  const observed = await market.load(clients.ledger);
  if (observed.pool.sole || observed.foreign.length === 0) {
    throw coded("W1 already owns the pool or the book has no foreign quote. Another deposit is not external demand.", "SOLE_LP");
  }
  const shot = await shotOf(clients.ledger);
  const locked = BigInt(request.xrp_drops);
  const position = bankroll.room(view(dir, now), observed);
  const ceiling = bankroll.maxLock(observed, position, shot.fee);
  if (locked <= 0n || locked > ceiling) throw coded("deposit does not fit the shared bankroll and the free balance", "BANKROLL");
  const key = String(request.idempotency_key || "");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("idempotency_key is missing", "IDEMPOTENCY");
  const tx = {
    TransactionType: "AMMDeposit",
    Account: bounds.ACCOUNT,
    Asset: market.XRP,
    Asset2: { currency: bounds.AETH, issuer: bounds.ISSUER },
    Amount: locked.toString(),
    Amount2: request.aeth,
    Flags: TF_TWO_ASSET,
    Fee: shot.fee.toString(),
    Sequence: shot.sequence,
    LastLedgerSequence: shot.validatedLedger + bounds.LEDGER_WINDOW,
  };
  const reserved = reserve(dir, {
    key,
    locked,
    exposure: locked + shot.fee + shot.reserveInc,
    tx,
  }, shot, now, observed);
  if (reserved.mission.submit_attempted) return publish(reserved.mission, { replay: true });
  const signed = await signer.sign(tx, {
    type: "AMMDeposit",
    account: bounds.ACCOUNT,
    sequence: shot.sequence,
    last: tx.LastLedgerSequence,
    fee: shot.fee.toString(),
    flags: TF_TWO_ASSET,
    amount: locked.toString(),
    amount2: request.aeth,
  }, clients.sign);
  let mission = Object.assign({}, reserved.mission, {
    signed: true,
    signed_hash: signed.hash,
    status: "amm_unknown",
    submit_attempted: true,
    updated_at: now,
  });
  try {
    const preliminary = await clients.submit(signed.tx_blob);
    const engineResult = preliminary && preliminary.result && preliminary.result.engine_result;
    mission.submitted = engineResult === "tesSUCCESS";
    mission.status = engineResult === "tesSUCCESS" ? "amm_unknown" : "amm_unknown";
  } catch (error) {
    mission.status = "amm_unknown";
  }
  save(dir, mission);
  return publish(mission, { replay: false });
}

async function withdraw(dir, request, clients) {
  assertClients(clients);
  const now = (request && request.now) || new Date().toISOString();
  const observed = await market.load(clients.ledger);
  if (!observed.pool.sole) throw coded("exit is only the proved sole LP position", "POOL");
  const shot = await shotOf(clients.ledger);
  const hash = crypto.createHash("sha256").update(`${observed.pool.ledgerIndex}:${observed.pool.balance.toString()}`).digest("hex").slice(0, 16);
  const key = `w1-exit-${hash}`;
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
  const reserved = reserve(dir, {
    key,
    locked: 0n,
    exposure: shot.fee,
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
};
