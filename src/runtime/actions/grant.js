"use strict";

/**
 * W6 grant plan. Wraps grants policy and the scan engine.
 * Daemon cap is 1000000 drops. Labeled WALLETS never qualify. No seed on dry-run.
 */

const path = require("path");
const grants = require("../../grants/policy");
const engine = require("../../grants/engine");
const policy = require("../policy");

function historyFile(root) {
  return path.join(root, "lab", "ledger-log.jsonl");
}

function planSyncChecks(opts) {
  const options = opts || {};
  if (options.alerts && options.alerts.length) {
    return policy.decision("grant_pay", { code: "ALERTS", message: "grant waits until wake alerts are clear" });
  }
  if (!options.state || policy.isStale(options.state, options.now || new Date())) {
    return policy.decision("grant_pay", { code: "STALE", message: "refusing to sign on stale director state" });
  }
  return null;
}

async function plan(opts) {
  const options = opts || {};
  const blocked = planSyncChecks(options);
  if (blocked) return blocked;
  const now = options.now || new Date();
  const root = options.root;
  const rows = options.history || policy.readJsonl(historyFile(root), options.io);
  if (policy.paidOnUtcDay(rows, "grant_paid", now)) {
    return policy.decision("grant_pay", { code: "NOT_DUE", message: "a grant_paid row already exists for this UTC day" });
  }
  let result;
  try {
    result = await engine.execute(["--dry-run", "--no-rpc", "--drops", policy.SPEC.grant_pay.max_drops], {
      env: options.env || {},
      root,
      now: now.getTime(),
      loadSeed: () => {
        throw policy.coded("dry-run grant read a seed", "SEED");
      },
    });
  } catch (error) {
    if (error && error.code === "SEED") throw error;
    return policy.fromError("grant_pay", error);
  }
  if (!result || !result.tx || !result.chosen) {
    return policy.decision("grant_pay", { code: "NONE", message: "no eligible non-labeled counterparty" });
  }
  try {
    policy.assertGrant({
      destination: result.tx.Destination,
      drops: result.tx.Amount,
      w6: policy.w6FromState(options.state),
      index: options.index,
    });
    policy.assertSigningTx(result.tx, options.state);
    if (result.tx.Account !== grants.W6) throw policy.coded("grant Account must be W6", "PAYER");
  } catch (error) {
    return policy.fromError("grant_pay", error);
  }
  return policy.decision("grant_pay", {
    allow: true,
    code: "DUE",
    message: `${result.chosen.reason} ${result.chosen.address}`,
    tx: result.tx,
    destination: result.chosen.address,
    reason: result.chosen.reason,
  });
}

async function execute(opts) {
  const options = opts || {};
  policy.assertLiveGate(options.env);
  const draft = await plan(options);
  if (!draft.allow || !draft.tx) throw policy.coded(draft.message || "grant refused", draft.code || "REFUSED");
  const result = await engine.execute(["--record", "--drops", draft.tx.Amount], {
    env: options.env,
    root: options.root,
    now: (options.now || new Date()).getTime(),
    loadSeed: () => {
      const seed = options.loadSeed("W6_REGULAR_SEED");
      if (!seed) return null;
      return { mode: "regular", name: "W6_REGULAR_SEED", seed };
    },
  });
  if (!result || !result.hash) throw policy.coded("grant submit missing hash", "SUBMIT");
  return {
    hash: result.hash,
    result: "tesSUCCESS",
    destination: result.destination,
    reason: result.reason,
  };
}

module.exports = { plan, execute };
