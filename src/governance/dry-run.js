#!/usr/bin/env node
"use strict";

/**
 * Read-only week-2 governance plan. Does not load seeds and does not sign.
 *
 *   npm run gov:dry
 */

const hosts = require("../xrpl-hosts");
const policy = require("./policy");

function die(message) {
  console.error(message);
  process.exit(1);
}

function snapshotAccount(id, role, address, info) {
  const data = (info && info.account_data) || {};
  const flags = Number(data.Flags || 0);
  return {
    id,
    role,
    address,
    balanceDrops: data.Balance || "0",
    ownerCount: Number(data.OwnerCount || 0),
    flags,
    disableMaster: policy.masterDisabled(flags),
    passwordSpent: policy.passwordSpent(flags),
    regularKey: data.RegularKey || null,
    signerLists: (info && info.signer_lists) || [],
  };
}

async function readState(client) {
  const server = await client.request({ command: "server_state" });
  const validated = server.result.state.validated_ledger;
  const info = await client.request({ command: "server_info" });
  const networkId = info.result.info.network_id;
  policy.assertNetworkId(networkId);
  const accounts = [];
  for (const row of policy.ACCOUNTS) {
    const response = await client.request({
      command: "account_info",
      account: row.address,
      ledger_index: "validated",
      signer_lists: true,
    });
    accounts.push(snapshotAccount(row.id, row.role, row.address, response.result));
  }
  return {
    server: {
      ledgerIndex: validated.seq,
      reserveBase: String(validated.reserve_base),
      reserveInc: String(validated.reserve_inc),
      networkId: networkId == null ? null : networkId,
    },
    accounts,
  };
}

async function main() {
  const ws = policy.assertTestnetUrl(hosts.resolveWs(process.env));
  const client = await hosts.openClient(ws, {
    networkId: policy.NETWORK_ID,
    assertUrl: (url) => policy.assertTestnetUrl(url),
  });
  try {
    if (client.networkID === 0) die("refusing NetworkID 0");
    const state = await readState(client);
    console.log(policy.renderDryRun(state));
  } finally {
    await client.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => die(error.message || String(error)));
}

module.exports = {
  snapshotAccount,
  readState,
};
