# RESULTS — Oracle Mid-Ticket

**Status:** trialled (session 2026-09-27-6)  
**Network:** XRPL Testnet

## Quote math (live)

| Field | Value |
|-------|-------|
| spot_amm | **0.010107545765657899** XRP/AETH |
| pool | 4973.542951524584 AETH / 50.270313 XRP |
| best_bid / best_ask | 0.0095 / 0.0105 |
| mid_clob | **0.01** |
| clob_thin | **false** |
| weights | 0.7 AMM + 0.3 CLOB |
| quote | **0.010075282035960528** (= 0.7×spot + 0.3×mid) |
| labor_units_aeth | 1 |
| labor_xrp (drops) | **0.010075** XRP (`10075` drops) |
| quote JSON | `lab/oracle/2026-09-27-1144.json` |
| quote ledger anchor | mint ledger **21096178** (amm_info returned `ledger_current_index` only; URI fragment recorded `ledger=undefined`) |

## On-chain trial

| Step | Hash / ID | Ledger |
|------|-----------|--------|
| NFTokenMint | `BDB214A12685448014153F0A4E7612DFED48964ACEFEEE29F6DAA078E3D55705` | 21096178 |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF19A5519C90141DD5B` | — |
| Sell offer | `298085ADCE0D6C8ED3DB33B25110E6B323C03C34C49DB669F05306268B2BA376` | 21096179 |
| Offer ID | `A9340A8EA4B281A0B27CB994D5480F3302099A48E55F2F1348BB0003BB81A59A` | — |
| BUYER accept | `F22A3A9BF15D18ED39E34F49FB8D4FE64CFE8AF52954C066C4EA46B236AF6E33` | — |
| EscrowCreate | `A45A05F1C01095C27B70902A28EAD49C1D9D8A7100C63BFCEE2053AE0CA6522C` | 21096181 |
| Escrow index | `9570CDE8AA8073045A64E625FEBC2D7C70652455F4A82B6A1268051914A3428D` | — |
| EscrowFinish (W4) | `A2D8E84C265DCCDD3E2E7A422B8F60D3439739E7A257154ED857AA7AB380E3A6` | — |

- **Purchaser:** BUYER `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` (existing faucet actor OK for this machine)
- **Escrow dest:** W4 `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN`
- **FinishAfter / CancelAfter:** Ripple Epoch via `src/time/rippleEpoch` (never Unix)
- **TransferFee:** 1000 (1%) to NFT issuer W2 (XRPL model; W0 is AETH treasury)
- **Taxon:** `20260927`
- **Operator script:** `src/oracle-mid-ticket-session.js`
- **Raw log:** `lab/sessions/2026-09-27-6-raw.json`

## Honor-system

Operator-attested composite mid; ledger stores quote text in NFT URI, not cryptographic proof of formula.
