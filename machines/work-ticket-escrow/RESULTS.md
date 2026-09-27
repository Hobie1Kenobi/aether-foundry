# Machine: work-ticket-escrow — RESULTS

**Network:** XRPL Testnet  
**Date (CT):** 2026-09-27 ~09:47–09:50 AM  
**Session:** 2026-09-27-2  
**Operator:** Foundry Director / Machine #1 primary

## BUYER

| Field | Value |
|-------|-------|
| Address | `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` |
| Seed | secrets `.env` `BUYER_SEED` only (never in git) |

## Artifact #1

| Field | Value |
|-------|-------|
| Minter | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Taxon | `20260927` |
| TransferFee | `1000` (1%) |
| URI | machine README raw GitHub URL |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF13EFDC5CD0141DD57` |
| Mint hash | `C1A9589142A00453A3E447D0A7D167C3C9BDB58891BB989C652FFEC539D975C8` |
| Sell offer hash | `3E452FD4EA276DCD1A281558F7655132EAB4A744CFCD71CA8D9454E1B70DA7E5` |
| Sell offer ID | `91FDCB9DE0B16861F19BD6351BBE5DB9FEC829DE22A95B3F8A71B7A51EE8CF3A` |
| Accept hash | `07A8CE674CDA95CCBA63B0820806F882FF9F4ED95B99C1574E68B0EA7BF7F187` |
| Explorer NFT | https://testnet.xrpl.org/nft/000803E8D25E64BC6D436EA502CE71902FE64120C571FCF13EFDC5CD0141DD57 |

## Trial A — happy path (finish)

| Step | Result | Hash |
|------|--------|------|
| EscrowCreate 10 XRP → W4 | tesSUCCESS | `DEEB7689A9A6521313414B5B991F5E15950E3257D2FCFEC3184E97BC30454EDD` |
| EscrowFinish (by W4) | tesSUCCESS | `0F87A94FCCAC7F8E34FB4BEB0E371BD13197A3B1BC16D4FF65437F24E1D003F4` |
| Create seq | 21094054 | |
| Escrow index | `1DD52A94369E20CAF343BA4F7E4DEE70858EC436CCC57F343ECFA6EB58043CAD` | |
| FinishAfter (Ripple) | 843835726 | |

## Trial B — cancel path

| Step | Result | Hash |
|------|--------|------|
| EscrowCreate 2 XRP → W4 | tesSUCCESS | `33C9CCB5AA3914BD7DFDE52FEDE29BD6FA2151EE94B5B73EF6E8011F319B3360` |
| EscrowCancel (by BUYER) | tesSUCCESS | `48B66E863CA6989D08F15C052942E674579E5EECDD49AB83EA43C1BDA81FEC4E` |
| Create seq | 21094055 | |
| Escrow index | `27AFC27EE27EA12FE6FD63C668DF844E764C1AF0FE608173784EE7908370BEB9` | |

## Known bad escrow (learning)

| Field | Value |
|-------|-------|
| Hash | `6B9528CCE3F90E39A6D6E1A8A1F1E637E1A38B575F0DDB105785D3A66A319462` |
| Cause | Unix timestamps passed as Ripple Epoch → ~2056 lock |
| Amount | 10 XRP still locked on BUYER |
| Seq | 21094052 |

## Notes

- No seeds in this file.
- Time locks only; no Condition.

---

## TokenEscrow probe (session 2026-09-27-3) — M1 v0.1 housekeeping

**Determination: ENABLED** on XRPL Testnet.

| Check | Value |
|-------|-------|
| Amendment | `TokenEscrow` |
| Amendment ID | `138B968F25822EFBF54C00F97031221C47B1EAB8321D93C7C2AEAF85F04EC5DF` |
| `feature` | `enabled: true`, `supported: true` |
| Companion | `fixTokenEscrowV1` also enabled |

### Setup txs

| Step | Result | Hash |
|------|--------|------|
| W0 `AccountSet` asfAllowTrustLineLocking (17) | tesSUCCESS | `B0F214DB216FF071515C2F125DB8A429273ED769CDBFB7071891741E3079E1F6` |
| BUYER TrustSet AETH→W0 | tesSUCCESS | `D5FF70E1A4DAFE1DBB7FC62E11FEFC9C9880E670B023E20E753CD0DAE7B1A421` |
| W0 Payment 100 AETH → BUYER | tesSUCCESS | `C4880AB08F048ADEACAA127841195D67FC82D3D7225A05E49EFDC399C8AD56DC` |

### Trial — cancel path (50 AETH)

| Step | Result | Hash |
|------|--------|------|
| EscrowCreate 50 AETH → W4 | tesSUCCESS | `C6A1CCC405CA800065A2313EADD00C4AF6C6F9ACFEF799C1BA0D0D32813393F9` |
| Create seq | 21094058 | |
| Escrow index | `79EC5CB83D3A169D04EC4CB22C2B0349353D5166E9B6121AFEBDF0379D279213` | |
| EscrowCancel (BUYER) | tesSUCCESS | `A37A107E0FA093BA9525F8EEF68E6C51A24B0CCA60B228F7CDD7641BD8D78163` |

Note: first finish wait used missing `server_info.validated_ledger.close_time`; CancelAfter elapsed → cancel path taken. Wait fixed to use `ledger` close_time.

### Trial — finish path (50 AETH)

| Step | Result | Hash |
|------|--------|------|
| EscrowCreate 50 AETH → W4 | tesSUCCESS | `C93C2F957C6C72636ABD620F28393BA74EF65E997FBE8EAC837C453FE123E852` |
| Create seq | 21094060 | |
| Escrow index | `5E7EC32B4F1B0B90AF3F5913292D8CAF89EB5C10F4DE67507A123F23F7F38EAA` |
| FinishAfter (Ripple) | 843836411 | |
| CancelAfter (Ripple) | 843836691 | |
| EscrowFinish (W4) | tesSUCCESS | `612BD199AB78E7923E4C84226CDB1658ED299E31ACDA3B4BAA193B04543ECFF7` |

Token escrows require **CancelAfter**. Times are Ripple Epoch only (`unix - 946684800`).
