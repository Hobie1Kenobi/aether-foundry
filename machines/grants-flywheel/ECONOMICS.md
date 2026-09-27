# ECONOMICS — grants flywheel

**Network:** XRPL Testnet. These drops are not mainnet XRP.

## Unit

The default grant is **1 XRP** (`1000000` drops), inside the 0.5–2 XRP band. The fee is one single-sign base fee, paid by W6. `SetRegularKey` is not repeated here; the regular key from the governance pack is only a signer.

W6's opening balance was 100 XRP. Spendable after the 1 XRP reserve is about 99 XRP before grants. Each default grant reduces that float by 1 XRP plus the fee.

## Caps

| Rule | Drops |
|------|------:|
| Default | 1_000_000 |
| Optional AETH SendMax | 2_000_000 |
| Float kept on W6 after the grant | 10_000_000 spendable |
| Motion required | ≥ 50_000_000 |

A motion is a markdown file in `lab/motions/` other than `README.md`. It must contain the destination and either `amount_drops` or `amount_xrp`, matching the Payment exactly. The same directory is the W0 treasury motion book. This pack does not build a W0 Payment.

The float check uses live `account_info` and `server_state` reserves. If the grant would leave fewer than 10 spendable XRP, the command exits before it signs. It does not faucet W6 and it does not pull XRP from W0.

## Metric

`grants_paid` in `market/pnl.md` is the count of distinct `tesSUCCESS` hashes appended with `--record`. A dry-run does not change it. A cooldown row without `--record` does not change it either: `lab/grants/ledger.jsonl` is written on success so the next scan will not double-pay, and the public P&L row waits for `--record`.

## What this does not spend

- W0 treasury, including the Unix-epoch BUYER escrow.
- W3 channel float. Inbound x402 is evidence, not a second payment from W3.
- More than one destination per command.
- AETH unless `--aeth` is set and the chosen counterparty's open reason is `aeth_counterparty`.
