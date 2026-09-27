# RESULTS — LP Badge

**Status:** trialled (session 2026-09-27-7)  
**Network:** XRPL Testnet  
**Honor-system:** **yes for this NFT** — the ledger does not bind this NFTokenID to the LP line. The later door in `machines/lp-badge-bound/` is the enforced privilege.

## Pre-mint snapshot

| Field | Value |
|-------|-------|
| AMM | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| Pool | 4973.542951524584 AETH / 50.270313 XRP |
| LP outstanding | **500000** (currency `0330E60FAE706EAD2C7D511D790B07A6F3B89931`) |
| LP holder | W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` |
| LP balance at mint | **500000** |
| Threshold | **100000** (≥20% of outstanding) |
| Threshold check | **PASS** |
| amm_info ledger | **21096269** |

## On-chain trial

| Step | Hash / ID | Ledger |
|------|-----------|--------|
| NFTokenMint | `A8185AFA42F082A85792D3AF534A852B7060726D44A29420C14DD4A673E36E5C` | 21096269 |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C` | — |
| CreateOffer (Dest=W1, Amount=0) | `D7E6B0E9A5E3F087FB51C6F977590A88A6EE768DE4454F4FFC7D861D9835D4C7` | 21096271 |
| Offer ID | `EBA790F12B3500821FE544FF9717501E248F4AB81FACF20F5097D27CEF51CADB` | — |
| W1 AcceptOffer | `A2956F443B10810E1273A4334DA815599570B186266390D77BEEEDB4648823D1` | 21096272 |

- **Issuer / minter:** W2 ATELIER `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw`
- **Holder:** W1 MARKET `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS`
- **Taxon:** `20260927` · **TransferFee:** 1000 (1%) · **Flags:** tfTransferable
- **Offer:** Destination-restricted 0 XRP attestation transfer (anti-snipe)
- **URI:** `…/machines/lp-badge/README.md#lp-threshold=100000&lp=500000&holder=W1`
- **Operator script:** `src/lp-badge-session.js`
- **Raw log:** `lab/sessions/2026-09-27-7-raw.json`

## Verifier (post-accept)

| Check | Result |
|-------|--------|
| account_lines(W1) LP ≥ 100000 | **PASS** (500000) |
| account_nfts(W1) contains badge | **PASS** |
| Combined | **PASS** |
| Continuous NFT↔LP bind on ledger | **no** (honor-system) |

## Non-actions (confirmed)

- No AMMDeposit / AMMWithdraw
- No Batch
- No OracleSet
- Unix-scar BUYER escrow untouched
- No seeds in repo
