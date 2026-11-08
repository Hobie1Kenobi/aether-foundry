"use strict";

/**
 * Read a signed claim against the validated ledger. A release is a separate
 * audited call. It is not a clock expiry, not a retry, and it cannot touch
 * the older claim that has no LastLedgerSequence.
 */

const path = require("path");
const { view, signedClaimMayRelease } = require("./engine");
const { coded } = require("./ledger");
const guard = require("./runtime-guard");
const { releasePassedWindow } = require("./submit");
const { proveSignedAbsence } = require("./absence-proof");

const PHRASE = "AUDIT-RELEASE-PASSED-WINDOW";
const OLD_CLAIM = "msn5b5c3223e5e88526";

function report(extra) {
  return Object.assign({
    schema: "aether.missions.reconcile",
    released: false,
    retried: false,
    signed: false,
  }, extra);
}

async function reconcileClaim(dir, missionId, opts) {
  const options = opts || {};
  const env = options.env || {};
  guard.assertNoHouseSeeds(env);
  if (options.override === true || env.override === "yes") {
    throw coded("operator override does not release a signed claim", "NO_RETRY");
  }
  if (missionId === OLD_CLAIM) {
    return report({ release_allowed: false, reason: "old_claim", mission_id: missionId });
  }
  const mission = view(dir, options.now).missions[missionId];
  if (!mission) throw coded("mission not found", "PLAN");
  if (!Number.isInteger(mission.last_ledger_sequence) || mission.last_ledger_sequence <= 0) {
    return report({
      release_allowed: false,
      reason: "no_last_ledger_sequence",
      mission_id: missionId,
      last_ledger_sequence: null,
    });
  }
  const account = mission.claim && mission.claim.account;
  if (!account || !mission.presigned_hash) {
    return report({ release_allowed: false, reason: "unsigned", mission_id: missionId });
  }
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== "function") throw coded("validated ledger RPC is not configured", "LEDGER");
  const shown = proveSignedAbsence(fetchImpl, {
    account,
    hash: mission.presigned_hash,
    lastLedgerSequence: mission.last_ledger_sequence,
    sequence: mission.sequence,
  });
  const absence = await shown;
  const releaseAllowed = signedClaimMayRelease({
    lastLedgerSequence: mission.last_ledger_sequence,
    validatedLedgerIndex: absence.validated_ledger,
    hashFound: absence.hash_found,
    creationProven: absence.creation_proven === true,
    historyCoversCreationThroughLast: absence.history_covers === true,
  }) && absence.proven === true;
  const base = report({
    release_allowed: releaseAllowed,
    reason: releaseAllowed ? "ledger_window" : absence.reason,
    mission_id: missionId,
    last_ledger_sequence: mission.last_ledger_sequence,
    validated_ledger: absence.validated_ledger,
    hash_found: absence.hash_found,
    creation_ledger: absence.creation_ledger,
    complete_ledgers: absence.complete_ledgers,
    history_covers: absence.history_covers === true,
    network_id: 1,
  });
  if (!releaseAllowed || options.audit !== true) return base;
  if (env.FOUNDRY_MISSION_RECONCILE_PHRASE !== PHRASE) throw coded("reconcile audit phrase is missing", "AUTH");
  const token = env.FOUNDRY_MISSION_RECONCILE_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("reconcile audit token is missing", "AUTH");
  if (env.FOUNDRY_MISSION_RECONCILE_MISSION !== missionId) throw coded("reconcile mission does not match", "CLAIM");
  const released = releasePassedWindow(dir, {
    mission_id: missionId,
    now: options.now,
    validatedLedger: absence.validated_ledger,
    hashFound: false,
    creationProven: true,
    historyCoversCreationThroughLast: true,
  });
  return Object.assign(base, {
    released: released.released === true,
    reason: released.released ? "ledger_window" : released.reason,
    retried: false,
  });
}

if (require.main === module) {
  const home = process.env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const dir = process.env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger");
  const missionId = process.env.FOUNDRY_MISSION_RECONCILE_MISSION || "";
  const audit = process.env.FOUNDRY_MISSION_RECONCILE_PHRASE === PHRASE;
  reconcileClaim(dir, missionId, { env: process.env, fetch: globalThis.fetch, audit })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({
        release_allowed: result.release_allowed === true,
        released: result.released === true,
        retried: false,
        reason: result.reason,
        mission_id: result.mission_id,
        last_ledger_sequence: result.last_ledger_sequence == null ? null : result.last_ledger_sequence,
        validated_ledger: result.validated_ledger == null ? null : result.validated_ledger,
        hash_found: result.hash_found == null ? null : result.hash_found,
        creation_ledger: result.creation_ledger == null ? null : result.creation_ledger,
        complete_ledgers: result.complete_ledgers == null ? null : result.complete_ledgers,
        history_covers: result.history_covers === true,
      })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "LEDGER"}\n`);
      process.exit(1);
    });
}

module.exports = {
  PHRASE,
  OLD_CLAIM,
  reconcileClaim,
};
