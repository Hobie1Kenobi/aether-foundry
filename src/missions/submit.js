"use strict";

const config = require("./config");
const { exclusive, coded } = require("./ledger");
const { fold } = require("./engine");
const missionPolicy = require("./policy");
const anchors = require("../director/anchors");

function reservedDrops(events, missionId) {
  let total = 0n;
  for (const event of events) {
    if (event && event.type === "budget.reserved" && event.mission_id === missionId) {
      total += BigInt(event.budget_drops || "0");
    }
  }
  return total;
}

function claimMatches(mission, tx) {
  const claim = mission && mission.claim;
  if (!claim || !tx) return false;
  return tx.TransactionType === "Payment"
    && tx.Account === claim.account
    && tx.Destination === claim.destination
    && tx.Amount === claim.amount
    && String(tx.Fee) === String(claim.fee)
    && Number(tx.NetworkID) === 1
    && tx.Destination === mission.seller
    && !missionPolicy.isHouse(tx.Account)
    && !missionPolicy.isHouse(tx.Destination);
}

function beginSubmit(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const events = api.read();
    const state = fold(events);
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.submitted || mission.submit_state === "settled") return { proceed: false, replay: true, mission };
    if (
      mission.submit_state === "signing"
      || mission.submit_state === "uncertain"
      || mission.signer_accepted === true
      || mission.retry_blocked
    ) {
      throw coded("refusing to submit or retry an unknown claim", "NO_RETRY");
    }
    if (!state.spending_enabled || state.killed) throw coded("spending is not activated", "SPENDING_DISABLED");
    if (mission.status !== "ready_for_signer") throw coded("mission is not ready for the dedicated signer", "SIGN");
    const tx = mission.unsigned_tx;
    if (!tx || tx.TransactionType !== "Payment" || Number(tx.NetworkID) !== 1) {
      throw coded("claim payment is not an xrpl:1 Payment", "TX");
    }
    if (missionPolicy.isHouse(tx.Destination) || missionPolicy.isHouse(tx.Account) || tx.Destination !== mission.seller) {
      throw coded("claim destination is not the qualified seller", "CLAIM");
    }
    const reserved = reservedDrops(events, mission.id);
    const total = BigInt(tx.Amount) + BigInt(tx.Fee || "0");
    if (reserved <= 0n || total !== reserved || reserved > config.PER_MISSION_DROPS) {
      throw coded("claim does not match the reserved budget", "CAP");
    }
    if (missionPolicy.dayUsed(state, mission.day) > config.DAILY_DROPS) throw coded("daily cap would be exceeded", "CAP");
    api.append({
      type: "budget.uncertain",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      drops: reserved.toString(),
      settlement: "submit_unknown",
      live: true,
    });
    mission.submit_state = "signing";
    mission.retry_blocked = true;
    mission.hold = "uncertain";
    mission.settlement = "submit_unknown";
    mission.signer_accepted = false;
    mission.complete = false;
    mission.claim = {
      account: tx.Account,
      destination: tx.Destination,
      amount: String(tx.Amount),
      fee: String(tx.Fee),
      network_id: 1,
    };
    mission.updated_at = now;
    mission.rationale = "Submit claim is open. A crash before a validated result stays uncertain and is not retried.";
    api.append({ type: "mission.upsert", at: now, mission });
    return { proceed: true, mission, tx: Object.assign({}, tx, { Amount: String(tx.Amount), Fee: String(tx.Fee) }) };
  });
}

function finishSubmit(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.submit_state === "settled") return { mission, replay: true, uncertain: false };
    if (mission.submit_state !== "signing" || mission.signer_accepted !== true) {
      throw coded("no signer-accepted claim", "CLAIM");
    }
    const result = input.result || {};
    if (anchors.EMBEDDED_SEED_RE.test(JSON.stringify(result))) throw coded("refusing a result that contains a seed", "SEED");
    const hash = String(result.hash || "").toUpperCase();
    const ok = result.submitted === true
      && result.engine_result === "tesSUCCESS"
      && anchors.HASH_RE.test(hash)
      && Number(result.network_id) === 1;
    if (!ok) {
      mission.submit_state = "uncertain";
      mission.status = "uncertain";
      mission.complete = false;
      mission.rationale = "Signer result was not a validated network-id-1 success. The claim stays uncertain and is not retried.";
      mission.updated_at = now;
      api.append({ type: "mission.upsert", at: now, mission });
      return { mission, uncertain: true };
    }
    const drops = (BigInt(mission.claim.amount) + BigInt(mission.claim.fee)).toString();
    api.append({
      type: "budget.settled",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      from: "uncertain",
      drops,
      live: true,
      hash,
    });
    mission.submit_state = "settled";
    mission.status = "submitted";
    mission.submitted = true;
    mission.signed = true;
    mission.live = true;
    mission.hold = "spent";
    mission.settlement = "xrpl_validated";
    mission.complete = false;
    mission.proof_hash = hash;
    mission.explorer = `${config.EXPLORER_TX}${hash}`;
    mission.updated_at = now;
    mission.rationale = "Payment submitted. The mission is not complete until the qualified artifact is validated.";
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission, uncertain: false };
  });
}

function acceptClaim(dir, missionId, tx) {
  return exclusive(dir, (api) => {
    const events = api.read();
    const state = fold(events);
    const mission = state.missions[missionId];
    if (!mission || mission.submit_state !== "signing" || !claimMatches(mission, tx)) {
      throw coded("signer claim does not match the reserved payment", "CLAIM");
    }
    if (mission.signer_accepted === true) throw coded("claim already handed to the signer", "NO_RETRY");
    const reserved = reservedDrops(events, mission.id);
    const total = BigInt(tx.Amount) + BigInt(tx.Fee || "0");
    if (reserved !== total || total > config.PER_MISSION_DROPS) throw coded("claim does not match the reserved budget", "CAP");
    if (missionPolicy.dayUsed(state, mission.day) > config.DAILY_DROPS) throw coded("daily cap would be exceeded", "CAP");
    mission.signer_accepted = true;
    mission.updated_at = new Date().toISOString();
    api.append({ type: "mission.upsert", at: mission.updated_at, mission });
    return { mission };
  });
}

function releasePrepared(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.submit_state || mission.submitted || mission.signer_accepted) {
      throw coded("refusing to release a claim that may have been signed", "NO_RETRY");
    }
    if (mission.hold !== "unsubmitted" || !mission.budget) return { mission, replay: true };
    api.append({
      type: "budget.released",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      drops: mission.budget.budget_drops,
      reason: input.code || "fee_stale",
      live: false,
    });
    mission.hold = "released";
    mission.status = "blocked";
    mission.code = input.code || "FEE_STALE";
    mission.complete = false;
    mission.rationale = input.rationale || "The XRPL network fee quote was stale or above the reserved bound. Nothing was signed.";
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission, replay: false };
  });
}

module.exports = {
  reservedDrops,
  claimMatches,
  beginSubmit,
  finishSubmit,
  acceptClaim,
  releasePrepared,
};
