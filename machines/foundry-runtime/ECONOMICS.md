# ECONOMICS — Foundry Box daemon

**Network:** XRPL Testnet. These drops are not mainnet XRP.

## Caps

| Action | Payer | Cap | Floor |
|---|---|---:|---|
| `walk_in_remint` | W2 | sell offer `10000000` drops (10 XRP). Fee is the only extra. | Offer must be `sold_out` and `offer_count` 0. |
| `grant_pay` | W6 | `1000000` drops (1 XRP) | W6 must keep `10000000` spendable drops. ≥ `50000000` drops is refused here even if `lab/motions/` matches. |
| `heartbeat` | W5 | default `1` drop, hard max `1000` drops | At most 4 heartbeats in 24h, at least 6 hours apart. Worst case 4000 drops per UTC day plus fees. |
| `x402_outbound` | W3 | `500000` drops (0.5 XRP) | One `x402_outbound` ledger row per UTC day. `payTo` is not W3 and not any `WALLETS` address. |
| `director_snapshot` | none | 0 | Read-only. |

A Payment or NFToken amount at or above 50 XRP is a treasury motion, not a daemon action. The daemon cap sits under that line and does not spend W0.

## What a dry-run spends

Nothing. `--dry-run` does not read `W2_REGULAR_SEED`, `W3_REGULAR_SEED`, `W5_REGULAR_SEED`, or `W6_REGULAR_SEED`, and it does not submit.

## What live mode can spend

On the Foundry box, with `FOUNDRY_DAEMON_LIVE=yes`, one pass may remint only when the sell offer is gone, pay one grant, emit one heartbeat, and buy one foreign x402 under the caps above. The watch loop cannot repeat a heartbeat inside 6 hours. It cannot pay W3. It cannot pay STRANGER, BUYER, W0–W6, or the AMM.

## Metric

No new public counter in this pack. `grants_paid` and `x402_outbound_hits` still move only through the existing recorders, and only after `tesSUCCESS` (outbound hit only after HTTP 200 as well). A dry-run does not change `market/pnl.md`.
