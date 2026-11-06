"use strict";

/**
 * Record that the next purchase must use a different isolated Testnet
 * account. The open claim stays uncertain. The day ledger is not reset
 * and the old candidate is not retried.
 */

const path = require("path");
const { exclusive, coded, readEvents } = require("./ledger");
const { view } = require("./engine");
const guard = require("./runtime-guard");
const { blockingClaim } = require("./sequence-hold");

const PHRASE = "USE-NEW-ISOLATED-ACCOUNT";
const PRIOR_RE = /^msn[a-f0-9]{16}$/;

function assertAuth(env) {
  const source = env || {};
  guard.assertNoHouseSeeds(source);
  if (source.override === "yes" || source.FOUNDRY_MISSION_ACCOUNT_OVERRIDE === "yes") {
    throw coded("operator override does not release a signed claim", "NO_RETRY");
  }
  const token = source.FOUNDRY_MISSION_ACCOUNT_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("account decision token is missing", "AUTH");
  if (source.FOUNDRY_MISSION_ACCOUNT_PHRASE !== PHRASE) throw coded("account decision phrase is missing", "AUTH");
}

function findDecision(events, priorId) {
  return events.find((event) => (
    event
    && event.type === "control.new_account"
    && event.prior_claim_id === priorId
    && event.preserves_hold === true
    && event.resets_budget === false
    && event.retries_prior_key === false
    && event.sequence_policy === "new_account"
  )) || null;
}

function decideNewAccount(dir, env, now) {
  assertAuth(env);
  const clock = now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const events = api.read();
    const state = view(dir, clock);
    const held = blockingClaim(state, null);
    if (!held) throw coded("no unresolved claim is waiting for a new account", "CLAIM");
    const requested = env && env.FOUNDRY_MISSION_PRIOR_CLAIM;
    if (requested && requested !== held.mission_id) {
      throw coded("the named prior claim is not the unresolved hold", "CLAIM");
    }
    if (!PRIOR_RE.test(held.mission_id)) throw coded("prior claim id is malformed", "CLAIM");
    const existing = findDecision(events, held.mission_id);
    if (existing) return { recorded: false, replay: true, decision: existing, held };
    const decision = {
      type: "control.new_account",
      counted: false,
      at: clock,
      phrase: PHRASE,
      prior_claim_id: held.mission_id,
      prior_account: held.account,
      prior_hold_drops: held.hold_drops,
      sequence_policy: "new_account",
      preserves_hold: true,
      resets_budget: false,
      retries_prior_key: false,
      execute: false,
    };
    api.append(decision);
    return { recorded: true, replay: false, decision, held };
  });
}

function requireDecision(dir, priorId) {
  if (!PRIOR_RE.test(String(priorId || ""))) throw coded("prior claim id is malformed", "CLAIM");
  const found = findDecision(readEvents(dir), priorId);
  if (!found) throw coded("new account decision is missing", "AUTH");
  return found;
}

function linkPriorClaim(dir, missionId, priorId, now) {
  const clock = now || new Date().toISOString();
  requireDecision(dir, priorId);
  return exclusive(dir, (api) => {
    const { fold } = require("./engine");
    const mission = fold(api.read()).missions[missionId];
    if (!mission) throw coded("new purchase is missing", "PLAN");
    if (mission.idempotency_key && /cand-17|fee-retry/.test(mission.idempotency_key)) {
      throw coded("refusing to rename the old candidate as a new purchase", "NO_RETRY");
    }
    mission.prior_claim_id = priorId;
    mission.rationale = `New isolated account. Prior unresolved claim ${priorId} stays open. Nothing in that claim was released.`;
    mission.updated_at = clock;
    api.append({ type: "mission.upsert", at: clock, mission });
    return { mission };
  });
}

if (require.main === module) {
  const home = process.env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const dir = process.env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger");
  try {
    const result = decideNewAccount(dir, process.env);
    process.stdout.write(`${JSON.stringify({
      recorded: result.recorded,
      replay: result.replay,
      prior_claim_id: result.decision.prior_claim_id,
      preserves_hold: true,
      resets_budget: false,
      retries_prior_key: false,
      execute: false,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "AUTH"}\n`);
    process.exit(1);
  }
}

module.exports = {
  PHRASE,
  decideNewAccount,
  requireDecision,
  linkPriorClaim,
  findDecision,
};
