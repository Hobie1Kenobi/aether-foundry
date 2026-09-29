# PRIMITIVES — TokenEscrow labor

Five ledger objects. Create submits only the escrow. The NFT is printed unsigned. The Check is printed on finish when the quote rose, and submitted only with `--rebate`.

## 1. TokenEscrow (`EscrowCreate`)

| Field | v0 |
|-------|----|
| Account | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Destination | W4 `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN` |
| `Amount` | MPT `{ mpt_issuance_id: "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED", value: "1" }`. AETH `{ currency, issuer: W0, value: "1" }` only if metrics has no id |
| `FinishAfter` | Ripple Epoch, `rippleNow + 120` |
| `CancelAfter` | Ripple Epoch, `rippleNow + 3600`. Required for a token escrow |
| `SourceTag` | `202609294` |
| `Condition` | omitted |

`Amount` is never a drops string. `FinishAfter` and `CancelAfter` above `1000000000` are refused. That is the Unix scar line, the same gate as the oracle ticket.

MPT path preconditions, not submitted here:

- `MPTokensV1` enabled. If it is off, this pack does not switch the lock to AETH.
- Issuance flags from F2: `tfMPTCanEscrow` and `tfMPTCanTransfer`.
- `tfMPTRequireAuth`: holder opt-in, then issuer authorize. W2 already did that (Flags `2`). W4 still needs the same order before finish delivers.
- W2 holds at least 1 labor unit.

AETH path precondition, already on the ledger from 2026-09-27: W0 `asfAllowTrustLineLocking` (`B0F214DB216FF071515C2F125DB8A429273ED769CDBFB7071891741E3079E1F6`). This pack does not submit `AccountSet`.

## 2. Finish (`EscrowFinish`)

| Field | v0 |
|-------|----|
| Account | W4 |
| Owner | W2 |
| `OfferSequence` | sequence of the `EscrowCreate` |
| `FinishAfter` | absent |

Anyone can finish after `FinishAfter`. This pack signs as W4, the destination. The Foundry daemon's `assertSigningTx` still refuses every `EscrowFinish`. This command does not go through that ban. It still refuses the Unix-epoch BUYER escrow (`rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth`, sequence `21094052`).

## 3. Cancel (`EscrowCancel`)

| Field | v0 |
|-------|----|
| Account | W2 |
| Owner | W2 |
| `OfferSequence` | sequence of a second `EscrowCreate` |
| `CancelAfter` | absent on this transaction. The time lives on the create |

One escrow cannot both finish and cancel. Trial A and trial B are two creates. Cancel is valid after that create's `CancelAfter`. The same scar owner is refused.

## 4. NFT deliverable (`NFTokenMint`, unsigned)

| Field | Value |
|-------|--------|
| Account | W2 |
| Taxon | `20260927` |
| Flags | transferable |
| TransferFee | `1000` |
| URI | this README, `#mpt=<48 hex>&symbol=AETH-LABOR` or `#asset=AETH`, plus the quote when the oracle answered |

`deliverable.submitted` stays false. Create does not mint.

## 5. Quote-drift Check (`CheckCreate`)

Printed by finish when `--quoted` is the create-time `quote_xrp_per_aeth` and `ledger_entry` on the W5 oracle is higher.

| Field | Value |
|-------|--------|
| Account | W6 |
| Destination | W2 |
| `SendMax` | drops of `(current - quoted) / 100`, the XRP drift on 1 AETH, capped at `1000000` (1 XRP) |
| `Expiration` | Ripple Epoch, `rippleNow + 7 days` |

A flat quote, a fallen quote, or a drift under 1 drop leaves `rebate.tx` null. The oracle's `LastUpdateTime` is UNIX and is not copied into `Expiration`. `--rebate` on `--live` is what submits the Check. Finish alone does not.
