"use strict";

const config = require("./config");
const { exclusive, coded } = require("./ledger");
const { fold } = require("./engine");
const missionPolicy = require("./policy");
const anchors = require("../director/anchors");

function reservedDrops(events, missionId) {
  let total = 0n;
  for (const event of events) {
    if (!event || event.mission_id !== missionId) continue;
    if (event.type === "budget.reserved") total += BigInt(event.budget_drops || "0");
    if (event.type === "budget.fee_narrowed") total -= BigInt(event.drops || "0");
  }
  return total < 0n ? 0n : total;
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

function notePresign(dir, missionId, hash) {
  const now = new Date().toISOString();
  const upper = String(hash || "").toUpperCase();
  if (!anchors.HASH_RE.test(upper)) throw coded("presign hash is not a ledger hash", "SUBMIT");
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[missionId];
    if (!mission || mission.submit_state !== "signing") throw coded("no open signing claim", "CLAIM");
    if (mission.signer_accepted === true) throw coded("claim already handed to the signer", "NO_RETRY");
    if (mission.presigned_hash && mission.presigned_hash !== upper) throw coded("refusing a second presign", "NO_RETRY");
    mission.presigned_hash = upper;
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission };
  });
}

function finishSubmit(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.submit_state === "settled") return { mission, replay: true, uncertain: false };
    const delivery = input.delivery || {};
    const result = input.result || {};
    if (anchors.EMBEDDED_SEED_RE.test(JSON.stringify(result)) || anchors.EMBEDDED_SEED_RE.test(JSON.stringify(delivery))) {
      throw coded("refusing a result that contains a seed", "SEED");
    }
    const hash = String(result.hash || delivery.hash || "").toUpperCase();
    const shopSettled = delivery.mode === "shop-settle" && delivery.http_status === 200 && mission.presigned_hash === hash;
    if (mission.submit_state !== "signing" || (mission.signer_accepted !== true && !shopSettled)) {
      throw coded("no signer-accepted claim", "CLAIM");
    }
    const delivered = delivery.http_status === 200 && delivery.result && typeof delivery.result === "object";
    const ok = delivered
      && (result.submitted === true || shopSettled)
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

function releaseUnsignedClaim(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const events = api.read();
    const mission = fold(events).missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.presigned_hash || mission.signer_accepted === true || mission.submitted || mission.signed) {
      throw coded("refusing to release a claim that may have been signed", "NO_RETRY");
    }
    if (mission.submit_state !== "signing" || mission.hold !== "uncertain") {
      throw coded("no unsigned signing claim", "CLAIM");
    }
    const drops = mission.claim
      ? (BigInt(mission.claim.amount) + BigInt(mission.claim.fee)).toString()
      : mission.budget.budget_drops;
    const live = events.some((event) => event
      && event.type === "budget.uncertain"
      && event.mission_id === mission.id
      && event.live === true);
    api.append({
      type: "budget.unsigned_released",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      drops,
      live,
      reason: input.code || "SIGNER",
    });
    mission.submit_state = null;
    mission.retry_blocked = false;
    mission.signer_accepted = false;
    mission.signed = false;
    mission.submitted = false;
    mission.live = false;
    mission.hold = "released";
    mission.status = "blocked";
    mission.code = input.code || "SIGNER";
    mission.settlement = "unsigned";
    mission.complete = false;
    mission.claim = null;
    mission.rationale = input.rationale || "The dedicated signer refused before any signature. The claim was released and nothing was submitted.";
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission };
  });
}

function narrowUnsubmittedFee(dir, input) {
  const now = input.now || new Date().toISOString();
  const next = BigInt(input.fee_drops);
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (
      mission.submit_state
      || mission.presigned_hash
      || mission.signer_accepted === true
      || mission.signed
      || mission.submitted
      || mission.hold === "uncertain"
    ) {
      throw coded("refusing to change a fee after a signature", "NO_RETRY");
    }
    if (mission.hold !== "unsubmitted" || !mission.budget) throw coded("no unsubmitted fee reserve", "FEE");
    const reserved = BigInt(mission.budget.network_fee_drops || "0");
    if (next <= 0n || next > config.PER_MISSION_DROPS || next > reserved) {
      throw coded("fresh fee is above the reserved network fee", "FEE_CAP");
    }
    const delta = reserved - next;
    if (delta === 0n) return { mission, replay: true };
    api.append({
      type: "budget.fee_narrowed",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      drops: delta.toString(),
      from: reserved.toString(),
      to: next.toString(),
      live: false,
    });
    const budget = BigInt(mission.budget.budget_drops) - delta;
    const committed = BigInt(mission.committed_drops || mission.budget.budget_drops) - delta;
    mission.budget = Object.assign({}, mission.budget, {
      network_fee_drops: next.toString(),
      budget_drops: budget.toString(),
    });
    if (mission.unsigned_tx) mission.unsigned_tx = Object.assign({}, mission.unsigned_tx, { Fee: next.toString() });
    mission.committed_drops = committed.toString();
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission, replay: false };
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
  notePresign,
  acceptClaim,
  releaseUnsignedClaim,
  narrowUnsubmittedFee,
  releasePrepared,
};
