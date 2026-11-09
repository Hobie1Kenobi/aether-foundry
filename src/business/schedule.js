"use strict";

/**
 * Propose one business action. This does not sign, submit, or write a ledger.
 */

const crypto = require("crypto");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const missionConfig = require("../missions/config");
const missionPolicy = require("../missions/policy");
const { view } = require("../missions/engine");
const { capability, axelarAdapter, PERMANENT_HOLD, LEGACY_DROPS } = require("./capabilities");

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function planId(parts) {
  return `biz-${crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function accounting(state, now) {
  const day = missionPolicy.chicagoDay(now);
  const used = state ? missionPolicy.dayUsed(state, day) : 0n;
  return {
    day,
    day_used_drops: used.toString(),
    per_mission_drops: missionConfig.PER_MISSION_DROPS.toString(),
    daily_drops: missionConfig.DAILY_DROPS.toString(),
    legacy_hold: PERMANENT_HOLD,
    legacy_drops: LEGACY_DROPS,
    killed: Boolean(state && state.killed),
    spending_enabled: Boolean(state && state.spending_enabled),
  };
}

function loadState(input, now) {
  if (input && input.ledger) return view(input.ledger, now);
  return input && input.state ? input.state : null;
}

function refused(input, now, row, code, rationale) {
  const state = loadState(input, now);
  return {
    schema: "aether.business.plan",
    id: planId([row.id, input.role || row.role, now, code]),
    role: input.role || row.role,
    capability: row.id,
    cls: row.cls,
    armed: false,
    signed: false,
    submitted: false,
    execution: false,
    code,
    rationale,
    exposure_drops: "0",
    accounting: accounting(state, now),
    axelar: axelarAdapter(),
  };
}

function propose(input) {
  const body = input || {};
  const now = body.now || new Date().toISOString();
  const state = loadState(body, now);
  if (body.network === "xrpl:0" || body.network === "mainnet" || body.network_id === 0) {
    throw coded("refusing mainnet", "MAINNET");
  }
  if (state && state.killed) throw coded("hard stop is on", "killed");
  const role = body.role || "risk-accounting";
  if (role === "treasury") {
    return refused(body, now, capability("xrpl.staking"), "EXCLUDED", "W0 is not an autonomous spender, and native XRP staking is not implemented.");
  }
  if (role === "trading") {
    return refused(body, now, capability("xrpl.dex.offer"), "DISABLED", "The W1 offer role is not activated. This call does not reserve, sign, or submit.");
  }
  if (role === "liquidity") {
    return refused(body, now, capability("xrpl.amm.lp"), "UNSUPPORTED", "The published AETH/XRP pool is an LP candidate only after pool state and the live owner reserve are verified. This call does not deposit.");
  }
  if (role === "bridge") {
    const row = capability("axelar.gmp.write");
    const plan = refused(body, now, row, "AXELAR_DISABLED", row.note);
    plan.exposure_drops = "0";
    return plan;
  }
  if (role === "risk-accounting") {
    const books = accounting(state, now);
    return {
      schema: "aether.business.plan",
      id: planId(["risk", books.day, books.day_used_drops]),
      role,
      capability: "xrpl.payment.exact",
      cls: "real_testnet",
      armed: false,
      signed: false,
      submitted: false,
      execution: false,
      code: null,
      rationale: "Accounting snapshot. Nothing was signed or reserved.",
      exposure_drops: books.day_used_drops,
      accounting: books,
      axelar: axelarAdapter(),
    };
  }
  if (role !== "procurement") throw coded("business role is not supported", "UNSUPPORTED");
  const seller = body.seller;
  if (typeof seller !== "string" || !xrpl.isValidClassicAddress(seller)) throw coded("seller is not a classic address", "ADDRESS");
  if (missionPolicy.isHouse(seller) || seller === anchors.WALLETS.W0.address) throw coded("refusing a house payee", "W0");
  const priced = missionPolicy.quote({
    payment_drops: body.payment_drops || "0",
    network_fee_drops: body.network_fee_drops || "0",
  });
  const books = accounting(state, now);
  const next = BigInt(books.day_used_drops) + BigInt(priced.budget_drops);
  if (next > missionConfig.DAILY_DROPS) throw coded("Chicago-day cap would be exceeded", "CAP");
  const id = planId(["procurement", seller, priced.budget_drops, books.day]);
  return {
    schema: "aether.business.plan",
    id,
    idempotency_key: id,
    role,
    capability: "xrpl.payment.exact",
    cls: "real_testnet",
    armed: false,
    signed: false,
    submitted: false,
    execution: false,
    code: null,
    rationale: "Proposed xrpl:1 XRP payment. The runtime was not armed and nothing was signed.",
    seller,
    network: missionConfig.NETWORK,
    network_id: missionConfig.NETWORK_ID,
    budget: priced,
    exposure_drops: priced.budget_drops,
    accounting: books,
    axelar: axelarAdapter(),
  };
}

module.exports = { propose };
