# ECONOMICS — Native Price Oracle

## What the oracle is for

Labor tickets need an XRP amount a stranger can recompute. The AMM is the inventory. The CLOB is the wing. The blend is the same 0.7/0.3 weights as Machine #4. The difference is where the number lives: an `Oracle` object on W5, not a sentence in an NFT URI.

## Costs

| Item | Effect |
|------|--------|
| `amm_info` / `book_offers` / `ledger_entry` / `feature` | Read. No fee. |
| `OracleSet` | One owner reserve on W5 for a single price pair (more than five pairs would be two). Base fee only. No XRP payment. |
| Ticket mint + sell | Same owner-reserve shape as Machine #1, paid by W2 when the box actually mints. |
| Escrow | Purchaser locks the oracle-derived drops until Ripple-Epoch `FinishAfter`. |

W5's keeper does not move a balance above the fee, so it does not need a `lab/motions/` file. A later ticket escrow at or above 50 XRP still does, and that escrow is the purchaser's transaction.

## Floor

Machine #4 raised a sub-0.01 quote to 0.01 XRP. This pack does not. If scale-8 rounding yields 0 drops, the ticket script refuses. It does not substitute a local float.

## Archive

Until the first `tesSUCCESS`, `lab/metrics.json` keeps `oracle_id` and `last_oracle.hash` null. A live run writes the hash it actually got. Do not type one in.
