# Economics

The hook emits 100% of a qualifying native payment. Fees for those emits come from XAH already on W7, not from the split.

| Bucket | Basis points | 1,000,000 drops | 1,000,001 drops | 100,000 drops (floor) |
|--------|-------------:|----------------:|----------------:|----------------------:|
| MARKET | 4000 | 400,000 | 400,000 | 40,000 |
| ATELIER | 2500 | 250,000 | 250,000 | 25,000 |
| RESEARCH | 2000 | 200,000 | 200,000 | 20,000 |
| GRANTS | 1000 | 100,000 | 100,000 | 10,000 |
| SINK | remainder | 50,000 | 50,001 | 5,000 |

`share = (drops / 10000) * bps + ((drops % 10000) * bps) / 10000`. SINK is `drops` minus the four named shares. Below 100,000 drops (0.1 XAH) the hook accepts and keeps the payment on W7 so a dust payment cannot be eaten by emit fees.

## Observed costs (2026-09-27, Xahau Testnet)

| Item | Drops | Paid by |
|------|------:|---------|
| SetHook fee | 4,582,231 | W7. Wasm is 9,164 bytes. Creation fee is 500 drops per wasm byte, plus 1 drop per HookParameter name and value byte, plus the base fee. |
| Trial Payment fee | 3,292 | Payer. Includes the hook-execution burden on the triggering transaction. |
| Each emit fee | 61 | W7 float. Five emits = 305 drops. |
| OwnerCount after install | 1 | Hook object. Base reserve 1 XAH, increment 0.2 XAH, so 1.2 XAH is reserved. |

W7 was faucet-funded with 1,000 XAH (1,000,000,000 drops). After SetHook and the trial, validated Balance was 995,417,464 drops: `1000000000 - 4582231 - 305`. The 1,000,000 drop payment was emitted in full, so it did not remain on W7.

Parameter owner reserve is inside the single Hook object (OwnerCount stayed 1), not five extra objects.
