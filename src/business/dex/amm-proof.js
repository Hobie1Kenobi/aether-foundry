"use strict";

/**
 * AMM deposit and withdraw proof from validated metadata.
 * A missing balance node does not release a hold. Returned AETH is not
 * credited as XRP. Pool spot price is not a value.
 */

const { coded } = require("../../missions/ledger");
const bounds = require("./bounds");
const anchors = require("../../director/anchors");

function uncertain(message) {
  throw coded(message, "UNCERTAIN");
}

function scaled(value, places) {
  const width = places === 15 ? 15 : 6;
  const pattern = width === 15
    ? /^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/
    : /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
  if (typeof value !== "string" || !pattern.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  const unit = 10n ** BigInt(width);
  return BigInt(whole) * unit + BigInt((frac + "0".repeat(width)).slice(0, width));
}

function signedScaled(value, places) {
  if (typeof value !== "string") return null;
  const negative = value.startsWith("-");
  const absolute = scaled(negative ? value.slice(1) : value, places);
  if (absolute == null) return null;
  return negative ? -absolute : absolute;
}

function sameIou(left, right) {
  return left && right && left.currency === right.currency && left.issuer === right.issuer && left.value === right.value;
}

function bind(proof, mission) {
  if (proof.hash !== String(mission.signed_hash || "").toUpperCase()) throw coded("proof hash is not the signed transaction", "PROOF");
  const tx = proof.tx;
  const reserved = mission.unsigned_tx || {};
  if (tx.Sequence !== mission.sequence || tx.LastLedgerSequence !== mission.last_ledger_sequence || tx.Fee !== mission.fee_drops) {
    throw coded("proof sequence, window, or fee does not match the reservation", "PROOF");
  }
  if (reserved.Flags != null && tx.Flags !== reserved.Flags) throw coded("proof flags do not match the reservation", "PROOF");
  if (reserved.Amount != null && tx.Amount !== reserved.Amount) throw coded("proof amount does not match the reservation", "PROOF");
  if (reserved.Amount2 != null && !sameIou(tx.Amount2, reserved.Amount2)) throw coded("proof second amount does not match the reservation", "PROOF");
  if (reserved.LPTokenIn != null && !sameIou(tx.LPTokenIn, reserved.LPTokenIn)) throw coded("proof LP token does not match the reservation", "PROOF");
}

function dropsOf(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

function validatedTx(response) {
  const result = response && (response.result || response);
  if (!result || result.validated !== true) throw coded("transaction is not validated", "PROOF");
  const meta = result.meta || result.metaData;
  if (!meta || meta.TransactionResult !== "tesSUCCESS" || !Array.isArray(meta.AffectedNodes) || meta.AffectedNodes.length === 0) {
    throw coded("validated metadata does not show success", "PROOF");
  }
  const tx = result.tx_json || result;
  const hash = String(result.hash || tx.hash || "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) throw coded("validated hash is missing", "PROOF");
  const ledgerIndex = Number(result.ledger_index);
  if (!Number.isSafeInteger(ledgerIndex) || ledgerIndex <= 0) uncertain("validated transaction ledger is missing");
  return { hash, ledgerIndex, tx, meta };
}

function xrpDelta(meta) {
  let seen = false;
  let delta = 0n;
  for (const entry of meta.AffectedNodes) {
    const body = entry.ModifiedNode || entry.CreatedNode || entry.DeletedNode;
    if (!body || body.LedgerEntryType !== "AccountRoot") continue;
    const finalFields = entry.CreatedNode ? body.NewFields : body.FinalFields;
    const previousFields = entry.CreatedNode ? null : body.PreviousFields;
    if (!finalFields || finalFields.Account !== bounds.ACCOUNT) continue;
    const after = dropsOf(finalFields.Balance);
    const before = previousFields ? dropsOf(previousFields.Balance) : 0n;
    if (after == null || before == null) uncertain("W1 XRP balance delta is malformed");
    delta += after - before;
    seen = true;
  }
  if (!seen) uncertain("W1 XRP balance delta is missing");
  return delta;
}

function lineDelta(meta, currency, holder, issuer) {
  let seen = false;
  let delta = 0n;
  for (const entry of meta.AffectedNodes) {
    const created = entry.CreatedNode;
    const modified = entry.ModifiedNode;
    const deleted = entry.DeletedNode;
    const body = created || modified || deleted;
    if (!body || body.LedgerEntryType !== "RippleState") continue;
    const finalFields = created ? body.NewFields : body.FinalFields;
    const previousFields = created ? null : (deleted ? body.FinalFields : body.PreviousFields);
    const fields = finalFields || previousFields;
    if (!fields || !fields.HighLimit || !fields.LowLimit) continue;
    const high = fields.HighLimit.issuer;
    const low = fields.LowLimit.issuer;
    const code = fields.HighLimit.currency || fields.LowLimit.currency;
    if (code !== currency || !((high === issuer && low === holder) || (high === holder && low === issuer))) continue;
    const sign = holder === low && issuer === high ? 1n : -1n;
    const places = currency === bounds.AETH ? 6 : 15;
    const after = deleted ? 0n : signedScaled(finalFields.Balance, places);
    const before = created ? 0n : signedScaled(previousFields.Balance, places);
    if (after == null || before == null) uncertain("token balance delta is malformed");
    delta += sign * (after - before);
    seen = true;
  }
  if (!seen) uncertain("token balance delta is missing");
  return delta;
}

function ammXrp(fields) {
  if (!fields) return null;
  const first = dropsOf(fields.Amount);
  const second = dropsOf(fields.Amount2);
  if (first != null) return first;
  return second;
}

function ammXrpDelta(meta) {
  let seen = false;
  let delta = 0n;
  for (const entry of meta.AffectedNodes) {
    const body = entry.ModifiedNode;
    if (!body || body.LedgerEntryType !== "AMM") continue;
    const after = ammXrp(body.FinalFields);
    const before = ammXrp(body.PreviousFields);
    if (after == null || before == null) uncertain("AMM XRP delta is malformed");
    delta += after - before;
    seen = true;
  }
  if (!seen) uncertain("AMM XRP delta is missing");
  return delta;
}

function depositOutcome(response, mission) {
  const proof = validatedTx(response);
  bind(proof, mission);
  const tx = proof.tx;
  if (tx.TransactionType !== "AMMDeposit" || tx.Account !== bounds.ACCOUNT) throw coded("deposit proof is not the W1 deposit", "PROOF");
  if (tx.Amount !== mission.locked_drops || tx.Fee !== mission.fee_drops) throw coded("deposit proof does not match the reservation", "PROOF");
  if ((tx.Flags & 0x00100000) === 0) throw coded("deposit proof is not two-asset", "PROOF");
  const xrpIn = BigInt(tx.Amount);
  const fee = BigInt(tx.Fee);
  if (xrpDelta(proof.meta) !== -(xrpIn + fee)) uncertain("deposit XRP delta does not match the amount and fee");
  const aeth = lineDelta(proof.meta, bounds.AETH, bounds.ACCOUNT, bounds.ISSUER);
  const expectedAeth = tx.Amount2 ? signedScaled(tx.Amount2.value, 6) : null;
  if (expectedAeth == null || aeth !== -expectedAeth) uncertain("deposit AETH delta does not match Amount2");
  const lp = lineDelta(proof.meta, mission.lp_currency, bounds.ACCOUNT, anchors.AMM);
  if (lp <= 0n) uncertain("deposit did not receive LP tokens");
  if (ammXrpDelta(proof.meta) !== xrpIn) uncertain("AMM XRP balance did not increase by the deposit");
  return { hash: proof.hash, ledgerIndex: proof.ledgerIndex, xrpIn, fee, aethIn: -aeth, lpOut: lp };
}

function withdrawOutcome(response, mission) {
  const proof = validatedTx(response);
  bind(proof, mission);
  const tx = proof.tx;
  if (tx.TransactionType !== "AMMWithdraw" || tx.Account !== bounds.ACCOUNT) throw coded("withdraw proof is not the W1 withdraw", "PROOF");
  if (tx.Fee !== mission.fee_drops) throw coded("withdraw proof does not match the reservation", "PROOF");
  if (!tx.LPTokenIn || tx.LPTokenIn.issuer !== anchors.AMM) throw coded("withdraw proof redeems the wrong token", "PROOF");
  const fee = BigInt(tx.Fee);
  const balanceDelta = xrpDelta(proof.meta);
  const xrpOut = balanceDelta + fee;
  const floor = BigInt(mission.min_xrp_out || "0");
  if (floor <= 0n || xrpOut < floor) uncertain("withdraw returned less XRP than the reserved floor");
  const aeth = lineDelta(proof.meta, bounds.AETH, bounds.ACCOUNT, bounds.ISSUER);
  if (aeth <= 0n) uncertain("withdraw did not return AETH");
  const lp = lineDelta(proof.meta, tx.LPTokenIn.currency, bounds.ACCOUNT, anchors.AMM);
  if (lp >= 0n) uncertain("withdraw did not burn LP tokens");
  if (ammXrpDelta(proof.meta) !== -xrpOut) uncertain("AMM XRP balance did not fall by the XRP returned");
  return { hash: proof.hash, ledgerIndex: proof.ledgerIndex, xrpOut, fee, aethOut: aeth, lpIn: -lp };
}

module.exports = {
  depositOutcome,
  withdrawOutcome,
};
