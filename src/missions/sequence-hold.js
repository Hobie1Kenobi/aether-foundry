"use strict";

/**
 * An unresolved signature with no LastLedgerSequence still occupies its
 * account sequence. A later payment from that account would consume the
 * sequence and is a cancellation of the unknown blob. Override does not
 * release it. A different isolated account is a separate decision.
 */

const { coded } = require("./ledger");

const OPTIONS = [
  {
    id: "hold",
    available: true,
    effect: "Leave the held account sequence unused. The open claim stays uncertain.",
  },
  {
    id: "new_account",
    available: true,
    effect: "Use a different isolated Testnet account. The held account is not spent and its sequence is not consumed.",
  },
  {
    id: "supersede",
    available: false,
    effect: "Refused. A new payment at the held sequence would cancel the unknown blob. An operator override does not release it.",
  },
];

function accountOf(mission) {
  if (!mission) return null;
  if (mission.claim && mission.claim.account) return mission.claim.account;
  if (mission.unsigned_tx && mission.unsigned_tx.Account) return mission.unsigned_tx.Account;
  if (mission.signed_fields && mission.signed_fields.Account) return mission.signed_fields.Account;
  return null;
}

function unresolvedNoWindow(mission) {
  if (!mission || mission.complete === true || mission.hold === "released" || mission.hold === "spent") return false;
  if (Number.isInteger(mission.last_ledger_sequence) && mission.last_ledger_sequence > 0) return false;
  return Boolean(
    mission.presigned_hash
    || mission.submit_state
    || mission.signer_accepted === true
    || mission.signed === true
    || mission.hold === "uncertain"
    || mission.retry_blocked === true
  );
}

function blockingClaim(state, nextAccount) {
  const missions = state && state.missions ? Object.values(state.missions) : [];
  for (const mission of missions) {
    if (!unresolvedNoWindow(mission)) continue;
    const account = accountOf(mission);
    if (nextAccount && account && account !== nextAccount) continue;
    return {
      mission_id: mission.id,
      account,
      hold_drops: mission.budget && mission.budget.budget_drops ? mission.budget.budget_drops : null,
      presigned_hash: mission.presigned_hash || null,
      last_ledger_sequence: null,
      sequence_policy: "hold",
      options: OPTIONS,
    };
  }
  return null;
}

function assertSequenceAvailable(state, nextAccount, input) {
  if (input && (input.override === true || input.operator_override === true)) {
    throw coded("operator override does not release a signed claim", "NO_RETRY");
  }
  const held = blockingClaim(state, nextAccount);
  if (!held) return null;
  const error = coded("account sequence is held by an unresolved signed claim with no ledger window", "SEQUENCE_HELD");
  error.hold = held;
  throw error;
}

module.exports = {
  OPTIONS,
  accountOf,
  unresolvedNoWindow,
  blockingClaim,
  assertSequenceAvailable,
};
