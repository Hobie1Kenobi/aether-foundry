# RESULTS — x402 citizen

**Status:** code and docs. No new outbound hash.  
**Network:** XRPL Testnet. Network id 1.  
**Live flag:** false.

## Facilitator probe (read)

`GET https://xrpl-facilitator-testnet.t54.ai/supported` returned 200:

```json
{"kinds":[{"x402Version":2,"scheme":"exact","network":"xrpl:1"},{"x402Version":2,"scheme":"upto","network":"xrpl:1"}],"extensions":["x402Secure"],"signers":{"xrpl:*":[]}}
```

`GET https://xrpl-facilitator-mainnet.t54.ai/supported` returned kinds on `xrpl:0`. That host is refused by `parseFacilitatorUrl`. `POST /verify` on the testnet host, with an empty body, answered that `paymentPayload` and `paymentRequirements` are required. This pack did not `POST /settle`.

## Outbound

`machines/x402-citizen/candidates.json` has `urls: []`. No foreign Testnet SKU was known, so the daily buy is a dry-run:

```text
foreign_shop none
signed false
network xrpl:1
network_id 1
cap_drops 500000
fingerprint_source_tag 202609296
fingerprint_memo aether-foundry:f11
no tx hash (not submitted)
```

`x402_outbound_hits` stays the count already in `lab/metrics.json`. This session did not append one. `x402_foreign_hits` counts ledger-log payers outside `WALLETS`; it is not a substitute for a new inbound hash.

## Not done

- No `--live` Payment. The box was not asked to spend, and there was no foreign 402 to spend on.
- No Batch, Vault, ConfidentialTransfer, or Sponsor transaction.
