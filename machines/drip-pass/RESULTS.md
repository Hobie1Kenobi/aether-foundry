# Machine: drip-pass — RESULTS

**Network:** XRPL Testnet  
**Date (CT):** 2026-09-27 ~09:54–10:05 AM  
**Session:** 2026-09-27-3  
**Operator:** Foundry Director / Machine #2 primary

## BUYER top-up (scar hygiene)

| Field | Value |
|-------|-------|
| Address | `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` |
| Faucet +50 XRP | `FF14F6B13C99911AD252DC2295882E0A166B1625E8F6AF3D81502E90723D90B4` |
| Post-faucet balance | ~129 XRP (still holds stuck Unix-epoch 10 XRP escrow — not recovered) |

## Drip Pass NFT

| Field | Value |
|-------|-------|
| Minter | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Taxon | `20260927` |
| TransferFee | `1000` (1%) |
| URI | drip-pass README raw URL |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1579B96CC0141DD58` |
| Mint hash | `EC384B4822EAABE95B7EF0D138537D76612859A53D97B008E9DF227C6755DD62` |
| Sell offer hash | `363A23A828D3D1DEEEE56A6D673AF4BAE6F89ACA9EEA20DB54496239EEAB9643` |
| Sell offer ID | `D02CFE6EBA5E3C1CC0D01AA53DD51CC371C2914FB36AD905F8935E223546C686` |
| Accept hash | `F4587DDABFD9D1A0290007B28F95FB6FBB98CEC344BF48E5857062BBDDF41C1B` |
| Holder | BUYER |
| Explorer NFT | https://testnet.xrpl.org/nft/000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1579B96CC0141DD58 |

## Payment Channel

| Field | Value |
|-------|-------|
| Channel ID | `DCE8401B0DFFE4031FBB15935D0EC33F72B010C8B89E2F60E6E6AC8B0572E9F5` |
| Create hash | `399C4E825443C3B721F32A18F7B71E53AD2E15784BBCFED010DA4EEBEA378798` |
| Source | BUYER |
| Destination | W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` |
| Amount | 16 XRP |
| SettleDelay | 30s |

## Claims (2 XRP × 3)

| # | Cumulative | Result | Hash | Lab | sha256 |
|---|------------|--------|------|-----|--------|
| 1 | 2 XRP | tesSUCCESS | `09F69401A8A90E5196B3E6C81B8CDA19C8C879F40D1D1163760DFA0FE97F3066` | lab/drip/0001.md | `d582dfa2554bed0a53c6ebbc44254400cc70b2a8b7264a75cc8fa0fa8019b5cb` |
| 2 | 4 XRP | tesSUCCESS | `F8EAD6D84E539FC7524BA01163754A43C8E2153E21CC362E0EBD1F7AD413C6D3` | lab/drip/0002.md | `1eeea4011077d3f75bdbd1d1bf8b192e263f8d7c3b5ef72df60141881eab36bd` |
| 3 | 6 XRP | tesSUCCESS | `E37699492E8F959E45C68E3056B76833D5C146521DDC7A5C3CA35B761ECA7B05` | lab/drip/0003.md | `f56373d2f4cf2139e41f4759ef210c7cb70de055d4e5729f8abfc6c4d8e87b6b` |

## Settle / close

| Step | Result | Hash |
|------|--------|------|
| W3 `PaymentChannelClaim` + `tfClose` | tesSUCCESS (PayChannel **Deleted**; Balance 6 XRP to W3, remainder to BUYER) | `6DFB44BB86E309F995579E92E2294D8F318A142E83F185FA22AB308A638E7737` |
| BUYER follow-up `tfClose` | `tecNO_TARGET` (already settled) | `E203ECBD0C54C989CB2DD08CB764EB1D4D0120B7E074A8C913E56D9FC42C8498` |

Note: On this testnet build, destination `tfClose` destroyed the channel immediately after claims (no separate Expiration wait). Documented for RUNBOOK.

## Epoch Scar artifact (optional)

| Field | Value |
|-------|-------|
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF16CA1A7CB0141DD59` |
| Mint hash | `D0EE37B54DEEEFEFC2A434BFB735857D56CDF9BB41FDA094ABB3222A6E833A81` |
| Transfer accept | `4BEC5D85C9F0535BDC1B9F01006AC6FA072FA10BDFB7D50D085A991854C51983` |
| Holder | W5 R&D `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| URI | work-ticket-escrow THREAT.md (Unix-epoch scar section) |
| Taxon | `20260927` |

## Notes

- No seeds in this file.
- Path-pay AETH quote for NFT skipped (nice-to-have).
