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
const TEAM_RLUSD_CAP_DROPS = 3500000n;
const ROLE_RLUSD_CAP = {
  W1: 2000000n,
  W3: 500000n,
  W4: 1000000n,
};
const ROLES = {
  W1: { phrase: PHRASE, account: ACCOUNT },
  W3: { phrase: "ACTIVATE-W3-DEX-ROLE", account: anchors.WALLETS.W3.address },
  W4: { phrase: "ACTIVATE-W4-DEX-ROLE", account: anchors.WALLETS.W4.address },
};

function teamCapDrops(env) {
  const raw = env && env.FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS;
  if (raw == null || raw === "") return TEAM_RLUSD_CAP_DROPS;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value <= 0n || value > TEAM_RLUSD_CAP_DROPS) return null;
  return value;
}

function journalEnvName(role) {
  if (role === "W3") return "FOUNDRY_W3_DEX_JOURNAL";
  if (role === "W4") return "FOUNDRY_W4_DEX_JOURNAL";
  return "FOUNDRY_W1_DEX_JOURNAL";
}

function supervisorEnvName(role) {
  if (role === "W3") return "FOUNDRY_W3_DEX_SUPERVISOR";
  if (role === "W4") return "FOUNDRY_W4_DEX_SUPERVISOR";
  return "FOUNDRY_W1_DEX_SUPERVISOR";
}

function liveEnvName(role) {
  if (role === "W3") return "FOUNDRY_W3_DEX_LIVE";
  if (role === "W4") return "FOUNDRY_W4_DEX_LIVE";
  return "FOUNDRY_W1_DEX_LIVE";
}

function keyEnvName(role) {
  if (role === "W3") return "FOUNDRY_W3_DEX_ACCOUNT_FILE";
  if (role === "W4") return "FOUNDRY_W4_DEX_ACCOUNT_FILE";
  if (role === "W5") return "FOUNDRY_W5_ORACLE_ACCOUNT_FILE";
  return "FOUNDRY_W1_DEX_ACCOUNT_FILE";
}

function verifiedEnv(env) {
  const source = env || {};
  const spec = ROLES[source.FOUNDRY_DEX_ROLE];
  if (!spec) return null;
  if (source.FOUNDRY_DEX_EXECUTE !== "yes") return null;
  if (source.FOUNDRY_DEX_NETWORK !== missionConfig.NETWORK) return null;
  if (source.FOUNDRY_DEX_ACCOUNT !== spec.account) return null;
  if (source.FOUNDRY_DEX_ACCOUNT === anchors.WALLETS.W0.address) return null;
  if (source.FOUNDRY_DEX_ACTIVATE !== spec.phrase) return null;
  if (source.FOUNDRY_DEX_BANKROLL_DROPS !== BANKROLL_DROPS.toString()) return null;
  if (source.FOUNDRY_DEX_MAX_AETH !== MAX_AETH) return null;
  if (source.FOUNDRY_DEX_AXELAR_DROPS !== AXELAR_DROPS) return null;
  const team = teamCapDrops(source);
  if (team == null) return null;
  return {
    role: source.FOUNDRY_DEX_ROLE,
    account: spec.account,
    issuer: ISSUER,
    network: missionConfig.NETWORK,
    network_id: missionConfig.NETWORK_ID,
    phrase: spec.phrase,
    max_locked_drops: MAX_LOCKED_DROPS.toString(),
    bankroll_drops: BANKROLL_DROPS.toString(),
    max_aeth: MAX_AETH,
    axelar_drops: AXELAR_DROPS,
    team_rlusd_cap_drops: team.toString(),
    learning: false,
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
  TEAM_RLUSD_CAP_DROPS,
  ROLE_RLUSD_CAP,
  ROLES,
  teamCapDrops,
  journalEnvName,
  supervisorEnvName,
  liveEnvName,
  keyEnvName,
  verifiedEnv,
};
