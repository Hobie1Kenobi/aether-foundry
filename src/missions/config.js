"use strict";

/**
 * Authorized Testnet ceilings. Runtime spending stays off until a later activation.
 * Caps are integer drops. They are not raised by restart, env, or a visitor request.
 */

const PER_MISSION_DROPS = 1000000n;
const DAILY_DROPS = 5000000n;
const TIMEZONE = "America/Chicago";
const HOLD_TTL_MS = 30 * 60 * 1000;
const NETWORK = "xrpl:1";
const NETWORK_ID = 1;
const STALE_MS = 15 * 60 * 1000;
const DEFAULT_SPENDING_ENABLED = false;
const ACTIVATE_PHRASE = "ACTIVATE-XRPL1-MISSION-SPEND";
const DEACTIVATE_PHRASE = "DEACTIVATE-XRPL1-MISSION-SPEND";
const CLEAR_KILL_PHRASE = "CLEAR-MISSION-KILL";

const ACTIONS = [
  "discover",
  "qualify",
  "plan_purchase",
  "validate_payload",
  "publish_artifact",
  "observe",
  "evaluate",
];

const REFUSED_ACTIONS = ["sign", "submit", "faucet", "bridge_submit", "retry"];

const EXPLORER_TX = "https://testnet.xrpl.org/transactions/";

module.exports = {
  PER_MISSION_DROPS,
  DAILY_DROPS,
  TIMEZONE,
  HOLD_TTL_MS,
  NETWORK,
  NETWORK_ID,
  STALE_MS,
  DEFAULT_SPENDING_ENABLED,
  ACTIVATE_PHRASE,
  DEACTIVATE_PHRASE,
  CLEAR_KILL_PHRASE,
  ACTIONS,
  REFUSED_ACTIONS,
  EXPLORER_TX,
};
