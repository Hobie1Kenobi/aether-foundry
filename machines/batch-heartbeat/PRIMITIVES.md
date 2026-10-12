# PRIMITIVES — Batch Heartbeat

## Batch

| Field | Usage |
|-------|--------|
| TransactionType | `Batch` |
| Flags | `65536` (`tfAllOrNothing`) only |
| RawTransactions | `NFTokenAcceptOffer`, `AMMDeposit`, `DIDSet`, in that order |
| Account | W1 |
| BatchSigners | absent. Single-account. |
| Network | id 1. Testnet only. |

`BatchV1_1` and `fixBatchV1_2` are enabled on XRPL Testnet as of the 2026-10-12 Labs probe. The daemon still refuses a generic `Batch`. Only intent `batch_heartbeat` passes, and only inside the amount caps.

## NFTokenAcceptOffer

| Field | Usage |
|-------|--------|
| Account | W1 |
| NFTokenSellOffer | W2 sell, destination W1, taxon `20261012`, issuer W2 |
| Amount | absent (the offer carries the price) |

Prepare, outside the Batch, is `NFTokenMint` (flags `9`) and `NFTokenCreateOffer` (sell flag `1`) from W2. Intent `batch_heartbeat_prepare`. The Walk-In taxon `20260927` is refused.

## AMMDeposit

| Field | Usage |
|-------|--------|
| Account | W1 |
| Flags | inner flag plus `tfSingleAsset` (`1074266112`) |
| Asset | XRP |
| Asset2 | AETH issued by W0 |
| Amount | drops. Default `1000000`. Cap `2000000`. |
| Pool | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |

## DIDSet

| Field | Usage |
|-------|--------|
| Account | W1, not W0 |
| URI | charter URL plus `#heartbeat=<ISO timestamp>` |
| Data | `{"machine":"batch-heartbeat","heartbeat":"<same stamp>"}` |

A W0 `DIDSet` would require a `BatchSigner`. This signer will not load `W0_SEED` to produce one.
