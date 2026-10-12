# ECONOMICS — Batch Heartbeat

## Why atomicity earns

Without Batch, accept→deposit→DID can interleave with snipes: NFT accepted but deposit fails → badge of inventory without LP deepen; or DID updates claiming a heartbeat that never funded the pool. Atomic Batch makes the *public claim* (DID) true iff capital moved.

## Sizing (first live trial)

| Leg | Size |
|-----|------|
| NFT accept | fresh W2 sell, default `10000` drops, cap `100000` drops |
| AMMDeposit | single-asset XRP, default `1000000` drops, cap `2000000` drops |
| Fees | outer fee, cap `100000` drops. Inners are `Fee` `"0"`. |
| First-run reserve | about `400000` drops on W1 if the DID object and the LP trust line are new |

Default spend is about 1.01 XRP plus a few dozen drops of fee. The W2 offer reserve returns when the accept succeeds.

## While the trial hash is still absent

Dry-run spends nothing. Live stays on the Foundry box.
