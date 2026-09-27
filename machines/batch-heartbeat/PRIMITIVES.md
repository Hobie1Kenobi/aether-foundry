# PRIMITIVES — Batch Heartbeat v0

## Batch (amendment-gated)

| Field | Intended v0 usage |
|-------|-------------------|
| TransactionType | `Batch` |
| Flags | `tfAllOrNothing` (or current finalize flag names when docs stabilize) |
| RawTransactions | [NFTokenAcceptOffer, AMMDeposit, DIDUpdate] |
| Account | W1 or W0 (fee payer / multi-account inner mode per final amendment) |

**Probe result:** amendments `BatchV1_1` / `fixBatchV1_2` **not enabled** on testnet 3.4.1 → do not submit.

## NFTokenAcceptOffer

| Field | v0 usage |
|-------|----------|
| NFTokenBuyOffer or SellOffer | pre-booked offer index from atelier desk |
| Account | W1 or designated acceptor |

## AMMDeposit

| Field | v0 usage |
|-------|----------|
| Asset / Asset2 | AETH/W0 + XRP |
| Amount / Amount2 | small heartbeat size (e.g. 1 XRP + proportional AETH) |
| Flags | `tfLPToken` / double-asset per XRPL AMM deposit flags |

## DIDUpdate

| Field | v0 usage |
|-------|----------|
| Account | W0 TREASURY |
| URI | charter URL + `#heartbeat=<ledger>` |
| Data / DIDDocument | optional compact attestation |

Port-forward: when Batch enables, inner DIDUpdate must be valid alone (sequence/ticket hygiene).
