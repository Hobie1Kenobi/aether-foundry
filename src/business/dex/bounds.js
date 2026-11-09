"use strict";

/**
 * Hard bounds for the W1 book-offer role.
 * A caller cannot raise these. W0 is the AETH issuer, never the signer.
 */

const anchors = require("../../director/anchors");
const missionConfig = require("../../missions/config");

const ROLE = "W1";
const ACCOUNT = anchors.WALLETS.W1.address;
const ISSUER = anchors.WALLETS.W0.address;
const AETH = anchors.AETH_HEX;
const PHRASE = "ACTIVATE-W1-DEX-ROLE";
const KIND = "w1-dex-offer";
const TF_PASSIVE = 0x00010000;
const TF_TAKING = 0x00020000 | 0x00040000;
const LEDGER_WINDOW = 20;
const MAX_LOCKED_DROPS = 800000n;
const BANKROLL_DROPS = 100000000n;
const MAX_AETH = "10";
const MAX_FEE_DROPS = 10000n;
const AXELAR_DROPS = "0";

function verifiedEnv(env) {
  const source = env || {};
  if (source.FOUNDRY_DEX_EXECUTE !== "yes") return null;
  if (source.FOUNDRY_DEX_ROLE !== ROLE) return null;
  if (source.FOUNDRY_DEX_NETWORK !== missionConfig.NETWORK) return null;
  if (source.FOUNDRY_DEX_ACCOUNT !== ACCOUNT) return null;
  if (source.FOUNDRY_DEX_ACCOUNT === anchors.WALLETS.W0.address) return null;
  if (source.FOUNDRY_DEX_ACTIVATE !== PHRASE) return null;
  if (source.FOUNDRY_DEX_BANKROLL_DROPS !== BANKROLL_DROPS.toString()) return null;
  if (source.FOUNDRY_DEX_MAX_AETH !== MAX_AETH) return null;
  if (source.FOUNDRY_DEX_AXELAR_DROPS !== AXELAR_DROPS) return null;
  return {
    role: ROLE,
    account: ACCOUNT,
    issuer: ISSUER,
    network: missionConfig.NETWORK,
    network_id: missionConfig.NETWORK_ID,
    phrase: PHRASE,
    max_locked_drops: MAX_LOCKED_DROPS.toString(),
    bankroll_drops: BANKROLL_DROPS.toString(),
    max_aeth: MAX_AETH,
    axelar_drops: AXELAR_DROPS,
  };
}

module.exports = {
  ROLE,
  ACCOUNT,
  ISSUER,
  AETH,
  PHRASE,
  KIND,
  TF_PASSIVE,
  TF_TAKING,
  LEDGER_WINDOW,
  MAX_LOCKED_DROPS,
  BANKROLL_DROPS,
  MAX_AETH,
  MAX_FEE_DROPS,
  AXELAR_DROPS,
  verifiedEnv,
};
