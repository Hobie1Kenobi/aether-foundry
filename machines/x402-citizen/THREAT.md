# THREAT — x402 citizen

## Mainnet facilitator swapped into the env

**Adversary:** `XRPL_FACILITATOR_URL=https://xrpl-facilitator-mainnet.t54.ai`, or `XRPL_NETWORK=xrpl:0`, or a lookalike host.

**Mitigation:** `web/lib/x402-facilitator.js` accepts only `https://xrpl-facilitator-testnet.t54.ai` with network `xrpl:1`. Any other facilitator URL returns `invalid_facilitator` before `lookupTx`. `https` is required. A path, query, userinfo, or non-443 port is refused. `/api/status` publishes `facilitator.mode: "refused"` and does not echo the rejected host as `host`.

## Desk starts settling

**Adversary:** a T54 client sends `signedTxBlob` and the desk posts it to `/settle`, which submits on Testnet.

**Mitigation:** the desk module has no `/settle` path. Dual mode may `POST /verify`, which the facilitator documents as read-only. A blob that verifies and is not yet validated returns 402 `payment_not_on_ledger` with `facilitatorVerified: true`. The buyer, or their own client, submits. The desk then reads the hash.

## Receipt for a payment that is not ours

**Adversary:** a receipt names a hash that paid somewhere else, or a mainnet network id.

**Mitigation:** the receipt hash is passed through the existing exact-Payment checks: destination W3, SKU drops, SourceTag, invoice binding, `tesSUCCESS`, and `NetworkID` 1 when present. A receipt `network` of `xrpl:0` or `networkId` other than 1 is refused before the read. The receipt payer must match the settled `Account` when the receipt names one.

## Self-pay and overpay

**Adversary:** W3 buys the Foundry desk, or a foreign 402 asks for more than 0.5 XRP.

**Mitigation:** the citizen buyer uses the outbound guard. Every `WALLETS` payTo is skipped. `capDrops` refuses amounts above 500000. `--live` also requires `FOUNDRY_DAEMON_LIVE=yes` and refuses CI. Dry-run does not load a seed.

## Replay

The desk still cannot durably mark an invoice spent. A validated Payment can unlock the JSON again until an operator records the hit. That limit is the same one self-verify already had.
