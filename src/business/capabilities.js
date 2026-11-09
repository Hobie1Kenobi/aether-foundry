"use strict";

/**
 * What this repository can actually do.
 * real_testnet means the mission engine can build an xrpl:1 Payment.
 * It does not mean the dormant runtime is armed.
 */

const missionConfig = require("../missions/config");
const axelar = require("../bridge/axelar/config");

const PERMANENT_HOLD = "msn5b5c3223e5e88526";
const LEGACY_DROPS = "1747";

const CAPABILITIES = [
  {
    id: "xrpl.payment.exact",
    role: "procurement",
    cls: "real_testnet",
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: "Payment",
    note: "The mission class foreign-xrpl1-purchase builds an xrpl:1 XRP Payment. Spending stays off until a separate activation.",
  },
  {
    id: "xrpl.dex.offer",
    role: "trading",
    cls: "unsupported",
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: "OfferCreate",
    note: "OfferCreate exists in older desk scripts. The mission signer accepts Payment only, so autonomous trading is not enabled.",
  },
  {
    id: "xrpl.amm.create",
    role: "liquidity",
    cls: "unsupported",
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: "AMMCreate",
    note: "No mission path creates an AMM. Reserve requirements are not waived.",
  },
  {
    id: "xrpl.staking",
    role: "treasury",
    cls: "unsupported",
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: null,
    note: "XRPL has no native XRP staking path in this repository.",
  },
  {
    id: "axelar.gmp.write",
    role: "bridge",
    cls: "disabled",
    armed: false,
    network: "xrpl-evm",
    transaction_type: null,
    note: "Pinned Axelar testnet contracts are not a spend approval. Gas and asset budgets stay zero.",
  },
];

function capability(id) {
  return CAPABILITIES.find((row) => row.id === id) || null;
}

function axelarAdapter() {
  return {
    schema: "aether.business.axelar",
    writes_enabled: false,
    gas_budget_drops: "0",
    gas_budget_wei: "0",
    asset_budget_authorized: false,
    direct_l1_bridge: false,
    native_xrp_staking: false,
    xrpl_network: axelar.XRPL_NETWORK,
    xrpl_network_id: axelar.XRPL_NETWORK_ID,
    evm_chain: axelar.EVM_CHAIN,
    evm_chain_id: axelar.EVM_CHAIN_ID,
    reason: "Axelar writes stay disabled until a separate gas and asset cap is approved. XRP caps do not authorize them.",
  };
}

function activationCriteria() {
  return [
    "The installed mission runtime stays asleep with execute, spend, and signing off until an operator activates it separately.",
    "W0 and mainnet stay excluded.",
    "The legacy 1747-drop hold on msn5b5c3223e5e88526 still counts toward the Chicago-day cap.",
    "Each mission stays within 1000000 drops including the fee, and the day stays within 5000000 drops including outstanding holds.",
    "A validated ledger proof is required before a diagnostic or mission payment is treated as complete.",
    "Axelar and EVM writes stay at zero gas and zero asset budget.",
    "OfferCreate and AMMCreate are not autonomous mission types.",
    "Diagnostic attempt locks and reconcile proofs are not deleted.",
  ];
}

module.exports = {
  PERMANENT_HOLD,
  LEGACY_DROPS,
  CAPABILITIES,
  capability,
  axelarAdapter,
  activationCriteria,
};
