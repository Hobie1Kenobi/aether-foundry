# PRIMITIVES — grants flywheel

**Network:** XRPL Testnet. Network id 1.

The composition is discovery plus one Payment. No OfferCreate, no Batch, no grid.

| Primitive | Role |
|-----------|------|
| `account_tx` | Read the newest 20 validated txs on W2, W3, and W6. No marker follow. |
| `nfts_by_issuer` | Read up to 20 taxon `20260927` NFTs minted by W2. |
| `nft_info` | Optional owner lookup. A missing method is skipped. |
| `account_info` / `server_state` | W6 balance and reserve, read-only, before a live sign. |
| `Payment` | W6 to one eligible classic address. XRP drops. `Account` is W6. |
| `Memos` | `purpose` = `aether-grant`, `experiment` = `grants-flywheel`, `reason` = the eligibility reason. |
| `SourceTag` | `202609276` marks the flywheel. |
| Path `Payment` (optional) | `--aeth` delivers 1 AETH (issuer W0) with `SendMax` ≤ 2 XRP. No `tfPartialPayment`. |

## Reasons

| Reason | Evidence |
|--------|----------|
| `walk_in_acceptor` | `walk_in_buy` buyer, a Walk-In `NFTokenAcceptOffer`, or a W2 accept in the capped `account_tx` page |
| `x402_payer` | `x402_hit` payer, or a Payment to W3 whose `SourceTag` is `202609271`, `202609272`, or `202609273` |
| `artifact_holder` | Owner of a taxon `20260927` NFT who is not already a `walk_in_acceptor` |
| `aeth_counterparty` | TrustSet or path-pay whose currency is AETH, including the LP-badge trust line and AETH buy |

One invocation pays one address, using the highest open reason. A cooled reason falls through to the next open reason for that address. A second command inside the 7-day window does not repeat the same pair.

## What is not a candidate

- Any `WALLETS` address, including STRANGER and BUYER.
- Faucet Payments to W3 that lack an x402 source tag.
- W3's own outbound x402 Payment. The foreign shop was paid by Foundry; it did not pay Foundry.
- Xahau accounts. This pack does not submit on `wss://xahau-test.net`.
