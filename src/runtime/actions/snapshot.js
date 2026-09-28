"use strict";

/**
 * Read-only director snapshot. This action never signs.
 * Dry-run does not write lab/director-state.json and does not invent a ledger index.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../../director/anchors");
const directorSnapshot = require("../../director/snapshot");
const policy = require("../policy");

const PRESERVED = ["next_actions", "blockers", "last_session_id"];

function plan(opts) {
  const options = opts || {};
  policy.assertSnapshotUnsigned(null);
  const needed = Boolean(options.missing || options.stale);
  return policy.decision("director_snapshot", {
    allow: needed,
    code: options.missing ? "MISSING" : options.stale ? "STALE" : "FRESH",
    message: needed ? "snapshot is read-only HTTP; dry-run does not write" : "director state is inside 36h",
    tx: null,
    key_env: null,
    signs: false,
    write: false,
    preserves: PRESERVED.slice(),
  });
}

function cardOf(state) {
  if (!state) return null;
  return {
    next_actions: state.next_actions.slice(),
    blockers: state.blockers.slice(),
    last_session_id: state.last_session_id,
  };
}

async function execute(opts) {
  const options = opts || {};
  if (options.tx) throw policy.coded("director_snapshot must not sign", "SIGN");
  const file = path.join(options.root, anchors.STATE_REL);
  const before = options.state ? cardOf(options.state) : null;
  await directorSnapshot.run([process.execPath, "src/director/snapshot.js", "--root", options.root], {
    silent: true,
    now: options.now,
    fetchImpl: options.fetchImpl,
  });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  policy.assertNoSeedFields(after);
  if (before) {
    if (JSON.stringify(after.next_actions) !== JSON.stringify(before.next_actions)) {
      throw policy.coded("snapshot overwrote next_actions", "PRESERVE");
    }
    if (JSON.stringify(after.blockers) !== JSON.stringify(before.blockers)) {
      throw policy.coded("snapshot overwrote blockers", "PRESERVE");
    }
    if (after.last_session_id !== before.last_session_id) {
      throw policy.coded("snapshot overwrote last_session_id", "PRESERVE");
    }
  }
  const xrplLedger = after.networks && after.networks.xrpl_testnet && after.networks.xrpl_testnet.validated_ledger_index;
  if (!Number.isInteger(xrplLedger) || xrplLedger < 1) {
    throw policy.coded("snapshot did not prove a validated ledger index", "RPC");
  }
  return { signs: false, hash: null, validated_ledger_index: xrplLedger };
}

module.exports = { plan, execute, PRESERVED };
