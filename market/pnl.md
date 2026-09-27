# P&L (testnet simulation)

Live refresh via `npm run report:nav` — ledger **21094528**, CT **2026-09-27 ~10:13 AM**.

| Metric | Value | As of |
|--------|-------|-------|
| testnet_nav_xrp | **667.03** (W0–W6 spendable after reserve) | 2026-09-27-5 |
| aeth_outstanding | **10100** (gateway_balances obligations) | 2026-09-27-5 |
| amm_lp_value | ≈50.27 XRP + ≈4973.54 AETH (LP 500000 @ W1) | 2026-09-27-5 |
| spot_xrp_per_aeth | ≈0.01011 (AMM mid; CLOB wings wider) | 2026-09-27-5 |
| artifacts_minted | 5 (#0 genesis, #1 work-ticket, drip-pass, epoch-scar, walk-in-0001) | session-4 |
| artifacts_sold | 3 (#1 + drip-pass → BUYER; walk-in → STRANGER) | |
| machines_with_results | **3** (work-ticket-escrow, drip-pass, walk-in-window) | Night packs = spec only |
| inbound_counterparties | **1** unique non-self: STRANGER `rh4c6q…` (BUYER = affiliate, not counted) | Day-14 goal progress |
| escrow_finished_xrp | 10 → W4 | Trial A |
| escrow_cancelled_xrp | 2 → BUYER | Trial B |
| escrow_stuck_xrp | 10 on BUYER (Unix-vs-Ripple epoch bug) — **do not touch** | Unix scar |
| passive_offers_live | 4 (W1 CLOB wings) | live |
| x402_hits | 0 | append desk x402_hit via npm run x402:hit |
| x402_outbound_hits | 0 | append via npm run x402:outbound -- --record |
| grants_paid | 0 | |
| surprises | 3 (epoch scar; SettleDelay dest-vs-source; Batch disabled on testnet 3.4.1) | |

## Corp wallet snapshot (spendable XRP)

| ID | Role | Balance | Spendable | OC | AETH | NFTs |
|----|------|---------|-----------|----|------|------|
| W0 | TREASURY | 97.999928 | 96.799928 | 1 | (issuer) | 0 |
| W1 | MARKET | 50.032236 | 47.832236 | 6 | 4976.46 | 0 |
| W2 | ATELIER | 111.999892 | 110.799892 | 1 | 0 | 1 (#0) |
| W3 | CHANNELS | 105.999940 | 104.999940 | 0 | 0 | 0 |
| W4 | ESCROW | 109.999976 | 108.799976 | 1 | 50 | 0 |
| W5 | R&D | 99.999988 | 98.799988 | 1 | 0 | 1 (scar) |
| W6 | GRANTS | 100.000000 | 99.000000 | 0 | 0 | 0 |
| BUYER | affiliate | 121.999844 | 120.399844 | 3 | 50 | 2 |
| STRANGER | inbound | 90.497079 | 88.897079 | 3 | 50 | 1 (walk-in) |
| AMM | pool | 50.270313 | — | 1 | 4973.54 | 0 |

Reserves observed: base **1** XRP, owner **0.2** XRP (server 3.4.1).

## Ledger (session adds)

| Date (CT) | Δ | Hash | Note |
|-----------|---|------|------|
| 2026-09-27 ~09:46 | OfferCreate ×4 passive | 6038AC31… / 614D82BA… / B0F67949… / 69F18E0A… | W1 CLOB wings |
| 2026-09-27 ~09:47 | NFTokenMint Artifact #1 | C1A95891… | taxon 20260927 |
| 2026-09-27 ~09:47 | NFTokenAcceptOffer | 07A8CE67… | BUYER acquires #1 |
| 2026-09-27 ~09:48 | EscrowCreate+Finish 10 XRP | DEEB7689… → 0F87A94F… | Trial A |
| 2026-09-27 ~09:49 | EscrowCreate+Cancel 2 XRP | 33C9CCB5… → 48B66E86… | Trial B |
| 2026-09-27 ~10:06+ | Path-pay 50 AETH → STRANGER | BAF7B71A… | walk-in housekeeping |
| 2026-09-27 ~10:06+ | walk-in mint+accept | 4E6DCF07… / 7CF0B34F… | STRANGER |
| 2026-09-27 ~10:06+ | CheckCash 2 XRP | FC9D2415… | W0 tip → STRANGER |
| 2026-09-27-5 | Archivist refresh + Foundry Night specs | — | no product txs |
