# ECONOMICS — Walk-In Window v0

## Reserves (testnet)

| Item | Cost |
|------|------|
| STRANGER account reserve | ~1 XRP (faucet funds 100) |
| Trust line (AETH) | +owner reserve |
| NFT accept | +owner reserve for NFToken page |
| Sell price | **10 XRP** → W2 |
| Path-pay ~50 AETH | ~0.50 XRP input @ AMM mid (~0.01 XRP/AETH) + fees; SendMax headroom used |
| W0 Check tip | 2 XRP to STRANGER |
| TransferFee | 1000 = **1%** of secondary sale Amount to W2 issuer |

## Pricing rationale

- 5–15 XRP band keeps Walk-In affordable for a fresh faucet wallet (~100 XRP).
- 10 XRP chosen mid-band; leaves runway for trust line + NFT reserve + path-pay.
- AETH path-pay proves stranger can touch Foundry IOU liquidity without a privileged BUYER.

## Royalty

Primary sale Amount goes to W2. Secondary sales: 1% TransferFee to W2 (issuer = minter).
