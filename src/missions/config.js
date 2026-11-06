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
const SPENDING_ENABLED = false;
const SIGNING_ENABLED = false;

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
  SPENDING_ENABLED,
  SIGNING_ENABLED,
  ACTIONS,
  REFUSED_ACTIONS,
  EXPLORER_TX,
};
