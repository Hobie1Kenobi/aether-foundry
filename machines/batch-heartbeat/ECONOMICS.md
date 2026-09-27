# ECONOMICS — Batch Heartbeat

## Why atomicity earns

Without Batch, accept→deposit→DID can interleave with snipes: NFT accepted but deposit fails → badge of inventory without LP deepen; or DID updates claiming a heartbeat that never funded the pool. Atomic Batch makes the *public claim* (DID) true iff capital moved.

## Sizing (proposed first live trial)

| Leg | Size |
|-----|------|
| NFT accept | existing offer ≤ 10 XRP |
| AMMDeposit | 1 XRP + ~99 AETH (near spot) or single-asset 1 XRP |
| Fees | Batch fee ≥ sum of inners (TBD by amendment) |

## Idle cost while gated

Zero — spec only. No capital locked waiting for amendment.
