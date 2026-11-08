"use strict";

const config = require("./config");
const { exclusive, coded } = require("./ledger");
const { fold, signedClaimMayRelease } = require("./engine");
const { assertSequenceAvailable } = require("./sequence-hold");
const missionPolicy = require("./policy");
const serviceResult = require("./service-result");
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
    && tx.NetworkID == null
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
    const nextAccount = mission.unsigned_tx && mission.unsigned_tx.Account;
    assertSequenceAvailable(state, nextAccount, input);
    const tx = mission.unsigned_tx;
    if (!tx || tx.TransactionType !== "Payment") {
      throw coded("claim payment is not an xrpl:1 Payment", "TX");
    }
    if (tx.NetworkID != null && Number(tx.NetworkID) !== 1) {
      throw coded("standard xrpl:1 payments must omit NetworkID", "MAINNET");
    }
    if (Number(tx.NetworkID) === 1) delete tx.NetworkID;
    delete tx.Memos;
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

function signedFields(tx) {
  if (!tx || typeof tx !== "object") return null;
  // Record only fields present on this payment. A standard xrpl:1 payment
  // omits NetworkID. Older ledger lines that stored NetworkID 1 are left
  // as they were written.
  const fields = {
    TransactionType: "Payment",
    Account: tx.Account,
    Destination: tx.Destination,
    Amount: String(tx.Amount),
    Fee: String(tx.Fee),
    Sequence: Number.isSafeInteger(tx.Sequence) ? tx.Sequence : null,
    LastLedgerSequence: Number.isSafeInteger(tx.LastLedgerSequence) ? tx.LastLedgerSequence : null,
    SourceTag: Number.isInteger(tx.SourceTag) ? tx.SourceTag : null,
  };
  if (tx.NetworkID != null) fields.NetworkID = tx.NetworkID;
  if (typeof tx.InvoiceID === "string") fields.InvoiceID = tx.InvoiceID;
  if (tx.Memos != null) fields.memos_present = true;
  return fields;
}

function withoutEchoFields(tx, binding) {
  const next = Object.assign({}, tx);
  if (binding) {
    next.SourceTag = binding.sourceTag;
    next.InvoiceID = binding.invoiceIdField;
  }
  delete next.Memos;
  delete next.NetworkID;
  return next;
}

function notePresign(dir, missionId, hash, fields) {
  const now = new Date().toISOString();
  const upper = String(hash || "").toUpperCase();
  if (!anchors.HASH_RE.test(upper)) throw coded("presign hash is not a ledger hash", "SUBMIT");
  const meta = signedFields(fields && fields.tx);
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[missionId];
    if (!mission || mission.submit_state !== "signing") throw coded("no open signing claim", "CLAIM");
    if (mission.signer_accepted === true) throw coded("claim already handed to the signer", "NO_RETRY");
    if (mission.presigned_hash && mission.presigned_hash !== upper) throw coded("refusing a second presign", "NO_RETRY");
    if (
      Number.isInteger(mission.last_ledger_sequence)
      && meta
      && meta.LastLedgerSequence != null
      && meta.LastLedgerSequence !== mission.last_ledger_sequence
    ) {
      throw coded("refusing to refresh LastLedgerSequence after it was stored", "NO_RETRY");
    }
    mission.presigned_hash = upper;
    mission.presigned = true;
    mission.signed = true;
    mission.submitted = false;
    mission.live = false;
    mission.complete = false;
    if (meta) mission.signed_fields = meta;
    if (meta && meta.Sequence != null) mission.sequence = meta.Sequence;
    if (meta && meta.LastLedgerSequence != null) mission.last_ledger_sequence = meta.LastLedgerSequence;
    mission.rationale = "A signature is stored. It has not been submitted. The claim stays open until a supported result is recorded, or a future signature's validated ledger window has passed and the hash is absent.";
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission };
  });
}

function applyChallenge(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission || mission.hold !== "unsubmitted" || !mission.unsigned_tx) {
      throw coded("no unsubmitted payment to bind", "TX");
    }
    if (mission.presigned_hash || mission.submit_state) throw coded("refusing to bind a claim that may have been signed", "NO_RETRY");
    const tx = withoutEchoFields(mission.unsigned_tx, {
      sourceTag: input.sourceTag,
      invoiceIdField: input.invoiceIdField,
    });
    mission.unsigned_tx = tx;
    mission.invoice_id = input.invoiceId;
    mission.source_tag = input.sourceTag;
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { mission };
  });
}

function stampPrepared(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission || mission.hold !== "unsubmitted" || !mission.unsigned_tx) {
      throw coded("no unsubmitted payment to prepare", "TX");
    }
    if (mission.presigned_hash || mission.submit_state || Number.isInteger(mission.last_ledger_sequence)) {
      throw coded("refusing to refresh LastLedgerSequence after it was stored", "NO_RETRY");
    }
    const tx = withoutEchoFields(mission.unsigned_tx);
    tx.Sequence = input.sequence;
    tx.LastLedgerSequence = input.lastLedgerSequence;
    mission.unsigned_tx = tx;
    mission.signed_fields = signedFields(tx);
    mission.sequence = tx.Sequence;
    mission.last_ledger_sequence = tx.LastLedgerSequence;
    mission.presigned = false;
    mission.signed = false;
    mission.submitted = false;
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

function noteDeliveryFailure(dir, input) {
  const now = input.now || new Date().toISOString();
  const status = Number(input.http_status);
  return exclusive(dir, (api) => {
    const mission = fold(api.read()).missions[input.mission_id];
    if (!mission || !mission.presigned_hash) throw coded("no presigned claim", "CLAIM");
    if (mission.hold !== "uncertain" && mission.submit_state !== "signing") {
      throw coded("claim is not an open presign", "NO_RETRY");
    }
    mission.status = "uncertain";
    mission.code = input.code === "unsupported_delivery" ? "unsupported_delivery" : "delivery_failed";
    mission.settlement = "submit_unknown";
    mission.retry_blocked = true;
    mission.complete = false;
    mission.submitted = false;
    mission.live = false;
    const diagnostic = serviceResult.sanitizeDiagnostic(input.parsed);
    mission.delivery_http_status = Number.isInteger(status) ? status : null;
    mission.delivery_error_code = typeof input.error_code === "string" && /^[a-z0-9_]{1,40}$/.test(input.error_code)
      ? input.error_code
      : "unparsed";
    mission.delivery_reason = diagnostic.reason;
    mission.delivery_invalid_reason = diagnostic.invalid_reason;
    mission.delivery_error_reason = diagnostic.error_reason;
    mission.rationale = "The seller response did not match a supported purchase result. The presigned claim stays uncertain and is not released or retried.";
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
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

function releasePassedWindow(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const events = api.read();
    const mission = fold(events).missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (!Number.isInteger(mission.last_ledger_sequence)) {
      return { released: false, reason: "no_last_ledger_sequence", mission };
    }
    if (!signedClaimMayRelease({
      lastLedgerSequence: mission.last_ledger_sequence,
      validatedLedgerIndex: input.validatedLedger,
      hashFound: input.hashFound,
    })) {
      return { released: false, reason: "not_proven", mission };
    }
    const drops = mission.claim
      ? (BigInt(mission.claim.amount) + BigInt(mission.claim.fee)).toString()
      : mission.budget.budget_drops;
    const live = events.some((event) => event
      && event.type === "budget.uncertain"
      && event.mission_id === mission.id
      && event.live === true);
    api.append({
      type: "budget.ledger_expired",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      drops,
      live,
    });
    mission.hold = "released";
    mission.status = "blocked";
    mission.code = "LEDGER_EXPIRED";
    mission.complete = false;
    mission.submitted = false;
    mission.live = false;
    mission.retry_blocked = true;
    mission.rationale = "The validated ledger passed LastLedgerSequence and the hash was absent. The hold was released. This is not a completed purchase.";
    mission.updated_at = now;
    api.append({ type: "mission.upsert", at: now, mission });
    return { released: true, mission };
  });
}

module.exports = {
  reservedDrops,
  claimMatches,
  beginSubmit,
  finishSubmit,
  notePresign,
  applyChallenge,
  stampPrepared,
  releasePassedWindow,
  acceptClaim,
  noteDeliveryFailure,
  releaseUnsignedClaim,
  narrowUnsubmittedFee,
  releasePrepared,
};
