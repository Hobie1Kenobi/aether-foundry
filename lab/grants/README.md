# Grants cooldown log

`ledger.jsonl` is created by `npm run grants:pay` after a `tesSUCCESS` Payment from W6. One JSON object per line. Public addresses and hashes only.

A row blocks the same `destination` and `reason` for 7 days. `--record` also copies that row into `lab/ledger-log.jsonl` and increments `grants_paid` in `market/pnl.md`.

Do not hand-write a hash into this file.
