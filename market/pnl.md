# P&L (testnet simulation)

| Metric | Value | As of |
|--------|-------|-------|
| tesnet_nav_xrp | ~650 XRP free + 50 XRP in AMM + IOU float | 2026-09-27 CT |
| aeth_outstanding | 10000 (5000 in AMM, 5000 on W1) | 2026-09-27 |
| amm_lp_value | ~50 XRP + 5000 AETH (LP 500000 @ W1) | 2026-09-27 |
| inbound_tx_7d | boot txs only | |
| unique_counterparties | faucet + internal W0–W2 | |
| artifacts_minted | 1 (Artifact #0) | 2026-09-27 |
| artifacts_sold | 0 | |
| machines_with_results | 1 (genesis-artifact) | |
| x402_hits | 0 | |
| grants_paid | 0 | |
| surprises | 0 | |

## Ledger

| Date (CT) | Δ | Hash | Note |
|-----------|---|------|------|
| 2026-09-27 ~09:37 | DIDSet W0 | 95FD1096AE2D7F777697B65D2F97B7CBE3F08826654AE3CDC2D845A8022832A1 | charter URI |
| 2026-09-27 ~09:37 | AccountSet DefaultRipple | 55AA90B5611B20B014819C643604583C3CDFF5118AC11D6CD78CC22A4C9BC932 | W0 flags |
| 2026-09-27 ~09:38 | TrustSet AETH | BA6DEB736BE3C72DF8431D9BC5B87BA471B15B3E43DDA9285DB70338E6902243 | W1 limit 1e6 |
| 2026-09-27 ~09:38 | +10000 AETH → W1 | 0E46250ADB4366F70C21140043A8F586ABB4EBBF995A0AFB2643AD4046FC7A2F | issue |
| 2026-09-27 ~09:38 | AMMCreate −50 XRP −5000 AETH | ED9D47A42456A1504918CDFC1648BA4F86EDDBDFFB5CACC01F943B810B45A740 | pool seed |
| 2026-09-27 ~09:37 | NFTokenMint Artifact #0 | DD7FEFB46E0443A5E9DB7357FD62FC8B501EAACCB8656FC315711F6F056E3995 | taxon 20260927 |
