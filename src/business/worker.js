"use strict";

/**
 * Business worker. Disabled unless FOUNDRY_BUSINESS_EXECUTE=yes.
 * Even then it only prepares unsigned offers. It does not sign or submit.
 */

const { propose } = require("./schedule");
const { prepareOffer, prepareCancel } = require("./offer");

function tick(env, input) {
  const source = env || {};
  const enabled = source.FOUNDRY_BUSINESS_EXECUTE === "yes";
  const body = input || {};
  if (!enabled) {
    return { enabled: false, signed: false, submitted: false, written: false, plan: propose(body) };
  }
  if (source.FOUNDRY_BUSINESS_KILL === "yes" || body.killed === true) {
    return { enabled: true, signed: false, submitted: false, written: false, code: "killed" };
  }
  if (body.role !== "trading") {
    return { enabled: true, signed: false, submitted: false, written: false, plan: propose(body) };
  }
  if (!body.home) throw Object.assign(new Error("offer home is missing"), { code: "LEDGER" });
  const prepared = body.action === "cancel" ? prepareCancel(body.home, body) : prepareOffer(body.home, body);
  return {
    enabled: true,
    signed: false,
    submitted: false,
    written: prepared.replay !== true,
    replay: prepared.replay === true,
    offer: prepared.offer,
  };
}

module.exports = { tick };
