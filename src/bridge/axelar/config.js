"use strict";

/**
 * Pinned Axelar testnet route for native XRP.
 * Snapshot of https://axelar-testnet.s3.us-east-2.amazonaws.com/configs/testnet-config-1.x.json
 * read on 2026-11-06, checked against
 * https://docs.axelar.dev/dev/send-tokens/xrpl/xrpl-its/ and
 * https://docs.xrplevm.org/pages/bridge/deployed-contracts-testnet.
 * This module does not fetch, sign, or submit.
 */

const hosts = require("../../xrpl-hosts");

const PINNED_ON = "2026-11-06";
const CONFIG_URL = "https://axelar-testnet.s3.us-east-2.amazonaws.com/configs/testnet-config-1.x.json";
const ITS_DOC = "https://docs.axelar.dev/dev/send-tokens/xrpl/xrpl-its/";
const EVM_DOC = "https://docs.xrplevm.org/pages/bridge/deployed-contracts-testnet";
const TRANSFER_DOC = "https://docs.xrplevm.org/pages/users/using-the-bridge/transfer-xrp-with-axelar";
const GMP_DOC = "https://docs.axelar.dev/dev/axelarjs-sdk/tx-status-query-recovery/";

const XRPL_CHAIN = "xrpl";
const EVM_CHAIN = "xrpl-evm";
const XRPL_NETWORK = "xrpl_testnet";
const XRPL_NETWORK_ID = 1;
const EVM_CHAIN_ID = "1449000";
const EVM_CHAIN_ID_HEX = "0x161c28";

const XRPL_GATEWAY = "rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2";
const XRPL_GATEWAY_MAINNET_REFUSED = "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw";

const EVM_GATEWAY = "0xe432150cce91c13a887f7D836923d5597add8e31";
const EVM_GAS_SERVICE = "0xbe406f0189a0b4cf3a05c286473d23791dd44cc6";
const EVM_ITS = "0xb5fb4be02232b1bba4dc8f81dc24c26980de9e3c";
const EVM_ITS_FACTORY = "0x83a93500d23fbc3e82b410ad07a6a9f7a0670d66";
const XRP_TOKEN_ID = "0xba5a21ca88ef6bba2bfff5088994f90e1077e2a1cc3dcc38bd261f00fce2824f";
const EVM_NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const EVM_TOKEN_MANAGER = "0xdb0a778c57bd31e401d52ba6cf936d06e1324ae8";

const XRPL_HTTP = hosts.LABS_HTTP;
const XRPL_WS = hosts.LABS_WS;
const IGNORED_PUBLISHED_XRPL_RPC = "https://s.altnet.rippletest.net:51234";
const EVM_RPC = "https://rpc.testnet.xrplevm.org";
const EVM_EXPLORER = "https://explorer.testnet.xrplevm.org/";
const GMP_API = "https://testnet.api.axelarscan.io";

const ITS_VERSION = "2.1.1";
const TRANSFER_SIGNATURE = "interchainTransfer(bytes32,string,bytes,uint256,bytes,uint256)";
const MEMO_TYPE = "interchain_transfer";

const MAX_AMOUNT_DROPS = 2000000n;
const MAX_GAS_DROPS = 500000n;
const MAX_DAY_DROPS = 5000000n;
const MAX_AMOUNT_WEI = 2000000000000000000n;
const MAX_GAS_WEI = 500000000000000000n;
const MAX_IN_FLIGHT = 1;

const REVIEW_PHRASE = "REVIEW-AXELAR-TESTNET";
const STELLAR_CHAIN_SEEN = "stellar-2026-q1-2";

const REFUSED_HOSTS = [
  "ripple.com",
  "s1.ripple.com",
  "s2.ripple.com",
  "xrplcluster.com",
  "xrpl.ws",
  "xrpl.link",
  "xahau.network",
  "rpc.xrplevm.org",
  "api.axelarscan.io",
  "axelar-mainnet.s3.us-east-2.amazonaws.com",
];

function isGatewayAddress(address) {
  return address === XRPL_GATEWAY || address === XRPL_GATEWAY_MAINNET_REFUSED;
}

function stellarRoute() {
  return {
    supported: false,
    implemented: false,
    signable: false,
    submitted: false,
    status: "unsupported_pending_verified_official_testnet_route",
    chain_id_seen_in_axelar_testnet_config: STELLAR_CHAIN_SEEN,
    reason:
      "Stellar is not wired. The Axelar testnet static config publishes a dated chain id stellar-2026-q1-2. That name is not an approved Aether Foundry route. This pack does not encode Stellar memos, addresses, or transactions.",
  };
}

module.exports = {
  PINNED_ON,
  CONFIG_URL,
  ITS_DOC,
  EVM_DOC,
  TRANSFER_DOC,
  GMP_DOC,
  XRPL_CHAIN,
  EVM_CHAIN,
  XRPL_NETWORK,
  XRPL_NETWORK_ID,
  EVM_CHAIN_ID,
  EVM_CHAIN_ID_HEX,
  XRPL_GATEWAY,
  XRPL_GATEWAY_MAINNET_REFUSED,
  EVM_GATEWAY,
  EVM_GAS_SERVICE,
  EVM_ITS,
  EVM_ITS_FACTORY,
  XRP_TOKEN_ID,
  EVM_NATIVE_SENTINEL,
  EVM_TOKEN_MANAGER,
  XRPL_HTTP,
  XRPL_WS,
  IGNORED_PUBLISHED_XRPL_RPC,
  EVM_RPC,
  EVM_EXPLORER,
  GMP_API,
  ITS_VERSION,
  TRANSFER_SIGNATURE,
  MEMO_TYPE,
  MAX_AMOUNT_DROPS,
  MAX_GAS_DROPS,
  MAX_DAY_DROPS,
  MAX_AMOUNT_WEI,
  MAX_GAS_WEI,
  MAX_IN_FLIGHT,
  REVIEW_PHRASE,
  STELLAR_CHAIN_SEEN,
  REFUSED_HOSTS,
  isGatewayAddress,
  stellarRoute,
};
