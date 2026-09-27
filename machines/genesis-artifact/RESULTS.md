# Machine: genesis-artifact — RESULTS

**Network:** XRPL Testnet  
**Date (CT):** 2026-09-27 ~09:37 AM  
**Operator roles:** Atelier (+ Protocol/Treasurer boot)

## Intent

Mint Artifact #0 as the permanent on-ledger receipt that Foundry identity, issuance, and AMM bootstrap completed.

## Parameters

| Param | Value |
|-------|-------|
| Minter / Issuer | W2 ATELIER `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Taxon | `20260927` |
| Flags | `tfTransferable` |
| TransferFee | `1000` (= 1%) |
| URI | README raw URL (hex-encoded on-ledger) |
| Metadata | `atelier/metadata/artifact-0-genesis.json` |

## Outcome

| Field | Value |
|-------|-------|
| Result | `tesSUCCESS` |
| Tx hash | `DD7FEFB46E0443A5E9DB7357FD62FC8B501EAACCB8656FC315711F6F056E3995` |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF129D634CE0141DD56` |
| Explorer tx | https://testnet.xrpl.org/transactions/DD7FEFB46E0443A5E9DB7357FD62FC8B501EAACCB8656FC315711F6F056E3995 |
| Explorer NFT | https://testnet.xrpl.org/nft/000803E8D25E64BC6D436EA502CE71902FE64120C571FCF129D634CE0141DD56 |

## Notes

- Royalty (TransferFee) accrues to NFT issuer = W2 on secondary sales.
- URI points at repo README; richer JSON lives in `atelier/metadata/`.
- No seeds in this file.
