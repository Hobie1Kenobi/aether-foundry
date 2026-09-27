"use strict";

/**
 * Public anchors for the foreign agent shop.
 * Not a Foundry wallet. Not desk revenue.
 * FOREIGN_SEED stays outside git (AETHER_SECRETS or /workspace/aether-foundry-secrets/.env).
 */

const FOREIGN_ADDRESS = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
const NETWORK = "xrpl:1";
const MAINNET = "xrpl:0";
const XRPL_HTTP = "https://s.altnet.rippletest.net:51234";
const XRPL_WS = "wss://s.altnet.rippletest.net:51233";
const DEFAULT_PORT = 8787;

const SKU = {
  id: "foreign-oracle-ping",
  title: "Foreign oracle ping",
  description:
    "Foreign agent shop: validated XRPL Testnet ledger index from the public RPC. Not Foundry revenue.",
  drops: "5000",
  xrp: "0.005000",
  sourceTag: 77402101,
  path: "/foreign-oracle-ping",
  diyCostDrops: "0",
  diyNote:
    "Reading the validated ledger index from the public Testnet RPC is free. This price is the counterparty, not the data.",
};

module.exports = {
  FOREIGN_ADDRESS,
  NETWORK,
  MAINNET,
  XRPL_HTTP,
  XRPL_WS,
  DEFAULT_PORT,
  SKU,
};
