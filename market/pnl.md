# P&L (testnet simulation)

| Metric | Value | As of |
|--------|-------|-------|
| tesnet_nav_xrp | ~W0–W6 float + AMM + escrow locked | 2026-09-27 CT |
| aeth_outstanding | 10000 (≈5024 in AMM, ≈4976 on W1) | 2026-09-27-2 |
| amm_lp_value | ≈49.77 XRP + ≈5024 AETH (LP 500000 @ W1) | 2026-09-27-2 |
| artifacts_minted | 2 (#0 genesis, #1 work-ticket) | 2026-09-27 |
| artifacts_sold | 1 (#1 → BUYER @ 1 XRP) | 2026-09-27-2 |
| machines_with_results | 2 (genesis-artifact, work-ticket-escrow) | |
| escrow_finished_xrp | 10 → W4 | Trial A |
| escrow_cancelled_xrp | 2 → BUYER | Trial B |
| escrow_stuck_xrp | 10 on BUYER (Unix-vs-Ripple epoch bug) | see THREAT |
| passive_offers_live | 4 (W1) | housekeeping |
| x402_hits | 0 | |
| grants_paid | 0 | |

## Ledger (session-2 adds)

| Date (CT) | Δ | Hash | Note |
|-----------|---|------|------|
| 2026-09-27 ~09:46 | OfferCreate ×4 passive | 6038AC31… / 614D82BA… / B0F67949… / 69F18E0A… | W1 CLOB wings |
| 2026-09-27 ~09:47 | NFTokenMint Artifact #1 | C1A9589142A00453A3E447D0A7D167C3C9BDB58891BB989C652FFEC539D975C8 | taxon 20260927 |
| 2026-09-27 ~09:47 | NFTokenAcceptOffer | 07A8CE674CDA95CCBA63B0820806F882FF9F4ED95B99C1574E68B0EA7BF7F187 | BUYER acquires #1 |
| 2026-09-27 ~09:48 | EscrowCreate+Finish 10 XRP | DEEB7689… → 0F87A94F… | Trial A |
| 2026-09-27 ~09:49 | EscrowCreate+Cancel 2 XRP | 33C9CCB5… → 48B66E86… | Trial B |
