"use strict";

/**
 * Settlement.
 * Single-use, and the last use of a multi-use license, burns.
 * The holder (W4 in the demo) submits NFTokenBurn. A 0-drop buyback
 * is not used: NFTokenCreateOffer rejects an empty amount, and a
 * second sale is a different machine. Intermediate uses only advance
 * the lab counter.
 */

const catalog = require("./catalog");

function decide(meta, usesConsumedAfter) {
  const allowed = Number(meta && meta.uses);
  const used = Number(usesConsumedAfter);
  if (!Number.isInteger(allowed) || allowed < 1) {
    throw catalog.coded("license uses are missing", "TX");
  }
  if (!Number.isInteger(used) || used < 1) {
    throw catalog.coded("license use counter is missing", "TX");
  }
  if (used > allowed) throw catalog.coded("license is already spent", "USED_UP");
  if (used === allowed) {
    return {
      action: "burn",
      reason: allowed === 1 ? "single-use holder burn" : "last use holder burn",
      uses_consumed: used,
      uses_allowed: allowed,
      uses_remaining: 0,
    };
  }
  return {
    action: "counter",
    reason: "uses remain in the lab log",
    uses_consumed: used,
    uses_allowed: allowed,
    uses_remaining: allowed - used,
  };
}

function burnFor(account, nftokenId) {
  return catalog.burnTx(account, nftokenId);
}

module.exports = {
  decide,
  burnFor,
};
