# ECONOMICS — Credential domain shop

## Capital

| Item | Who pays | Notes |
|------|----------|-------|
| Faucet XRP | agent, stranger, mint | Testnet faucet. Not W0–W6, not BUYER, not STRANGER. |
| Domain owner reserve | W5 | One `PermissionedDomain` owner reserve, left in place. |
| Credential reserve | agent | One credential owner reserve after accept. |
| Offer reserve | W5, then the taker if a remainder rests | Dust offer. Not a 10 XRP Walk-In. |
| Crossing price | agent | `20000` drops (0.02 XRP) for `1` `AGT`. Under the 50 XRP motion line. |
| Failed take | stranger | `tecNO_PERMISSION` moves no `AGT` and no XRP. Fee only. |
| `AGT` | mint | Private IOU. Not AETH. The AMM pair is not the book. |

W5's existing XRP pays the issuer's fees and the 0.02 XRP of inventory it offers. The script does not send W5 a Payment from W0.

## What it does not earn

The 0.02 XRP is a proof fill, not a product price. The public Walk-In remains 10 XRP on W2. This counter does not change that price and does not count a self-trade between labeled wallets as inbound. The taker is a faucet account outside `WALLETS`.

## Reserves left behind

The domain object and the accepted credential stay after the trial so a later stranger with the same credential type can still be admitted or refused. Deleting them is a separate transaction and is not this pack.
