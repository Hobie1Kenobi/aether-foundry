# ECONOMICS — TokenEscrow labor

## What is locked

One labor unit of issued `AETH-LABOR` (`0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED`, `AssetScale` 0). If `lab/metrics.json` has no id, the unit is 1 AETH issued by W0. The AMM pair is unchanged. This escrow does not set `tfMPTCanTrade` and does not deposit into the pool.

The XRP value of 1 AETH is the W5 oracle quote (about `0.01` XRP on the Day-3 object). The lock itself is not that XRP. F1's ticket still escrows drops. F3 escrows the token.

## Quote drift

Finish re-reads the oracle. `quoted` is the decimal stored from create.

| Live quote vs quoted | Check |
|----------------------|--------|
| Equal | none |
| Lower | none. The payer did not lock more XRP-value than quoted |
| Higher | W6 `CheckCreate` to W2 for the extra XRP value of 1 unit |

Drops = `(current - quoted) / 100` at 8 decimal places of the quote. Under 1 drop is dust and is not a Check. The cap is 1 XRP (`1000000` drops). That is under the 50 XRP motion line, so this Check does not need `lab/motions/`.

## Costs

| Item | Effect |
|------|--------|
| `server_info` / `feature` / `ledger_entry` / `account_info` | Read. No fee. |
| `EscrowCreate` | One owner reserve on W2 for the escrow object, plus the base fee. The token leaves W2's balance until finish or cancel. |
| `EscrowFinish` | Base fee on W4. The token arrives at W4. |
| `EscrowCancel` | Base fee on W2. The token returns to W2. |
| `NFTokenMint` | Not submitted here. A later mint is one NFT reserve on W2. |
| `CheckCreate` | Base fee on W6, and up to 1 XRP when the Check is cashed. |

None of the submitted amounts are 50 XRP.

## Archive

Dry-run prints `predicted_sequence` from W2's current sequence. That number is not an `OfferSequence` to paste into RESULTS. The live create writes `offer_sequence` from the autofilled sequence into `lab/ledger-log.jsonl`. It does not write `mpt_issuance_id`. That field stays the F2 create's job.
