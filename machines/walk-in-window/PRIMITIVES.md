# PRIMITIVES — Walk-In Window v0

## NFTokenMint

| Field | v0 usage |
|-------|----------|
| Account | W2 ATELIER `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| NFTokenTaxon | `20260927` |
| Flags | `tfTransferable` (8) |
| TransferFee | `1000` (= 1%) |
| URI | hex of `machines/walk-in-window/README.md` raw GitHub URL |

## NFTokenCreateOffer / NFTokenAcceptOffer

| Field | v0 usage |
|-------|----------|
| Sell Account | W2 |
| Flags | `tfSellNFToken` (1) |
| Amount | 10 XRP (drops) — stranger-payable |
| Accept Account | **STRANGER** (new faucet wallet; never BUYER for this machine) |
| NFTokenSellOffer | offer ledger index from create |

## TrustSet (AETH)

| Field | v0 usage |
|-------|----------|
| Account | STRANGER |
| LimitAmount | AETH hex `41455448…`, issuer W0, limit `1000000` |

## Payment (path-pay XRP → AETH)

| Field | v0 usage |
|-------|----------|
| Account / Destination | STRANGER (same-account conversion) |
| Amount | `{ currency: AETH, issuer: W0, value: "50" }` |
| SendMax | XRP drops (≥ path_find source_amount; session used ~1.51 XRP headroom×3) |
| Paths | from `ripple_path_find` (order-book / AMM path to AETH issuer) |

AMM pool: `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`.

## CheckCreate / CheckCash

| Field | v0 usage |
|-------|----------|
| CheckCreate Account | W0 TREASURY |
| Destination | STRANGER |
| SendMax | 2 XRP |
| CheckCash Account | STRANGER |
| Amount | 2 XRP |
| CheckID | Check ledger index |

## PaymentChannel (housekeeping drill only)

See `machines/drip-pass/THREAT.md`. SettleDelay `>= 300`. Not required for Walk-In purchase flow.
