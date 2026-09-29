# ECONOMICS — x402 citizen

**Network:** XRPL Testnet. Drops are not mainnet XRP.

Inbound SKUs are unchanged and still settle to W3:

| SKU | Drops | XRP | SourceTag |
|-----|-------|-----|-----------|
| machine-spec | 100000 | 0.1 | 202609271 |
| reserve-audit | 250000 | 0.25 | 202609272 |
| composition-quote | 500000 | 0.5 | 202609273 |

A hit counts as `x402_hits`. `x402_foreign_hits` on `/api/status` is the subset whose `payer` is not in `WALLETS`. W3 paying W3 is not that subset.

Outbound is a cost, not revenue. The citizen buyer will not send more than **0.5 XRP** (500000 drops) in one Payment, and the runtime still refuses a second `x402_outbound` on the same UTC day. `x402_outbound_hits` counts distinct outbound hashes whose payTo is outside `WALLETS`.

No foreign shop was in `candidates.json` for this pack, so the dry-run does not spend. A later `--live` against a real 402 is the first drop that moves.
