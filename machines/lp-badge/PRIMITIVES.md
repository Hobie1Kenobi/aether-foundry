# PRIMITIVES — LP Badge v0

## AMM LP (existing)

| Field | v0 usage |
|-------|----------|
| AMM account | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| Asset | AETH hex `41455448…` issuer W0 |
| Asset2 | XRP |
| LP currency | `0330E60FAE706EAD2C7D511D790B07A6F3B89931` |
| LP holder (session-5) | W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` (~500000) |

## NFTokenMint

| Field | v0 usage |
|-------|----------|
| Account | W2 ATELIER |
| NFTokenTaxon | `20260927` |
| Flags | `tfTransferable` (8) |
| TransferFee | `1000` (1%) |
| URI | hex of this machine README raw GitHub URL + memo `#lp-threshold=<N>` |

## NFTokenCreateOffer / AcceptOffer

| Field | v0 usage |
|-------|----------|
| Sell Account | W2 |
| Amount | 0 (transfer) or 1 XRP (priced badge) |
| Destination (optional) | LP holder classic address — reduces sniping |
| Accept Account | intended LP holder |

## Read path (verifier)

```
account_lines(account=holder) → LP balance
account_nfts(account=holder)  → badge NFTokenID present
amm_info(asset=AETH, asset2=XRP) → pool context
```

No on-ledger assert that NFT ownership requires LP ownership in v0.
