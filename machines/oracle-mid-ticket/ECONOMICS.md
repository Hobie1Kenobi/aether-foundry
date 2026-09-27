# ECONOMICS — Oracle Mid-Ticket

## Why composite mid

Pure AMM mid ignores CLOB wings (session-5: asks 0.0105–0.0110 vs pool 0.01011). Pure CLOB mid is gamed by our own thin book. Blend reduces single-source bias while inventory stays Foundry-controlled.

## Ticket pricing example (1 labor unit)

| Input | Value |
|-------|-------|
| spot_amm | 0.01011 |
| mid_clob | ≈0.01000 |
| quote | ≈0.01008 XRP |
| Escrow bond | 0.01 XRP (round) or 10 XRP premium ticket |

## Costs

- Read RPCs: free  
- Mint + offer + escrow: fees + owner reserves (same as Machine #1)  
- No oracle-subscription opex on testnet

## Adversarial P&L

If we quote stale mid and buyer path-pays through AMM, Foundry inventory moves against us. Mitigation: quote TTL (N ledgers) encoded in URI; refuse accept after expiry (honor-system in v0; Hook later).
