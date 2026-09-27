# ECONOMICS — Drip Pass

## Reserves (testnet observed)

- Base reserve ≈ 1 XRP; owner reserve ≈ 0.2 XRP per object  
- PayChannel object: +1 owner count on **source** (BUYER) while open  
- NFToken page: owner count on holder  

## Channel sizing

| Item | XRP |
|------|-----|
| 3 claims × 2 | 6 |
| Settle / fee headroom | ~4–10 |
| **Create Amount (this session)** | **16** |

Unclaimed remainder returns to BUYER on successful close after SettleDelay.

## NFT

- Mint TransferFee 1% accrues to W2 on secondary sales  
- Primary sell Amount 1 XRP → W2 (trial pricing; not AETH-quoted this session)

## Optional path-pay

Quoting the pass partly in AETH via AMM `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` is a nice-to-have; **skipped** this session to bound risk/time.
