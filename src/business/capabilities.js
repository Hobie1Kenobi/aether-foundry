"use strict";

/**
 * Availability, implementation, authorization, and enablement are separate.
 * A documented Axelar or DEX path is not a spend approval.
 */

const missionConfig = require("../missions/config");
const axelar = require("../bridge/axelar/config");
const anchors = require("../director/anchors");

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
    cls: "real_testnet",
    available: true,
    implemented: true,
    authorized: false,
    enabled: false,
    submits: false,
    offline_submit_adapter: true,
    production_activated: false,
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: "OfferCreate",
    note: "An isolated W1 adapter can reserve on the shared mission ledger and sign or submit only through an injected client. Production is not activated. The mission signer remains Payment-only. AETH issued by W0 is the asset, not the signer.",
  },
  {
    id: "xrpl.amm.lp",
    role: "liquidity",
    cls: "candidate",
    available: true,
    implemented: false,
    authorized: false,
    enabled: false,
    submits: false,
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: "AMMDeposit",
    pool: anchors.AMM,
    pool_state_verified: false,
    fees_are_apr: false,
    note: "Deposit and withdraw code exists and stays disabled. Each activation must re-read amm_info. A sole LP position is inventory, not a reason to deposit more. Trading fees are not a guaranteed APR.",
  },
  {
    id: "xrpl.staking",
    role: "treasury",
    cls: "unsupported",
    available: false,
    implemented: false,
    authorized: false,
    enabled: false,
    submits: false,
    armed: false,
    network: missionConfig.NETWORK,
    transaction_type: null,
    amendment_probe_required: true,
    note: "UNL consensus is not holder staking. Single Asset Vaults and Lending need a current amendment probe before any code path.",
  },
  {
    id: "axelar.gmp.write",
    role: "bridge",
    cls: "disabled",
    available: true,
    implemented: false,
    authorized: false,
    enabled: false,
    submits: false,
    armed: false,
    network: "xrpl-evm",
    transaction_type: "Payment",
    note: "Official docs describe a Payment plus memos to the testnet gateway. This repository does not implement that send, and it is not authorized.",
  },
];

function capability(id) {
  return CAPABILITIES.find((row) => row.id === id) || null;
}

function axelarAdapter() {
  return {
    schema: "aether.business.axelar",
    verified_on: "2026-11-09",
    sources: [
      "https://docs.axelar.dev/its/integrations/xrpl",
      "https://docs.axelar.dev/gmp/integrations/xrpl",
      "https://docs.xrplevm.org/pages/bridge/deployed-contracts-testnet",
      "https://docs.xrplevm.org/pages/operators/validators/join-the-proof-of-authority",
    ],
    available: true,
    implemented: false,
    authorized: false,
    enabled: false,
    writes_enabled: false,
    gas_budget_drops: "0",
    gas_budget_wei: "0",
    asset_budget_authorized: false,
    w8_present: false,
    direct_l1_path_documented: true,
    direct_l1_path_implemented: false,
    xrpl_can_send_gmp: true,
    xrpl_can_execute_gmp: false,
    testnet_gateway: axelar.XRPL_GATEWAY,
    mainnet_gateway_refused: axelar.XRPL_GATEWAY_MAINNET_REFUSED,
    chain_names: [axelar.XRPL_CHAIN, axelar.EVM_CHAIN],
    evm_consensus: "proof_of_authority",
    evm_chain_id_pinned: axelar.EVM_CHAIN_ID,
    evm_chain_id_restated_on_contracts_page: false,
    documented_gas_example_drops: { its_amount: "1000000", its_gas: "100000", gmp_amount_all_gas: "1000000" },
    gas_example_is_permission: false,
    documented_rpc_example: "wss://s.altnet.rippletest.net:51233",
    foundry_diagnostic_uses_that_rpc: false,
    contracts_page_warns_addresses_may_change: true,
    native_xrp_staking: false,
    xrpl_network: axelar.XRPL_NETWORK,
    xrpl_network_id: axelar.XRPL_NETWORK_ID,
    evm_chain: axelar.EVM_CHAIN,
    evm_chain_id: axelar.EVM_CHAIN_ID,
    reason: "Docs describe the XRPL Payment-and-memo path. It is not implemented here, not authorized, and not enabled. Example gas of 0.1 to 1 XRP can consume the mission cap and is not permission.",
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
    "The W1 DEX adapter reserves on the shared mission ledger and signs only through an injected client. Production is not activated, and the mission signer remains Payment-only.",
    "Every outstanding hold counts toward the Chicago-day cap. The 1747-drop hold is one of those holds, not a special exception.",
    "DEX and LP share one 100000000-drop Testnet bankroll, including live LP XRP, open offers, incremental reserves, in-flight holds, and realized losses. It is not 100 XRP per agent and it does not refill daily. Payment missions stay at 1000000 and 5000000 drops.",
    "AMM LP, native staking, and SAV/Lending are not authorized. A sole-owned pool is not external demand. LP fees are not a guaranteed APR.",
    "The original vendor HTTP 403 and the 1747-drop hold are specific open issues. They do not by themselves forbid an unrelated plan that still fits the aggregate cap.",
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
