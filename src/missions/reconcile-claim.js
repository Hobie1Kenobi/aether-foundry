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
const ledgerWindow = require("./ledger-window");

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
  const window = await ledgerWindow.readValidatedAccount(fetchImpl, account);
  const hashFound = await ledgerWindow.hashFound(fetchImpl, mission.presigned_hash);
  const releaseAllowed = signedClaimMayRelease({
    lastLedgerSequence: mission.last_ledger_sequence,
    validatedLedgerIndex: window.validated,
    hashFound,
  });
  const base = report({
    release_allowed: releaseAllowed,
    reason: releaseAllowed ? "ledger_window" : (hashFound === null ? "lookup_unknown" : (hashFound ? "hash_present" : "window_open")),
    mission_id: missionId,
    last_ledger_sequence: mission.last_ledger_sequence,
    validated_ledger: window.validated,
    hash_found: hashFound,
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
    validatedLedger: window.validated,
    hashFound: false,
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
