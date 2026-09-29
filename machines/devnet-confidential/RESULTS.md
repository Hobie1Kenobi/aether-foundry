# RESULTS — Devnet confidential MPT

**Status:** live on XRPL Devnet id 2. Issuance → confidential pay → clawback.  
**Network:** XRPL Devnet, id 2.  
**Symbol:** `DEVNET-CONF` / ticker `DCONF`. TransferFee 0.  
**Issuance id:** `0056E2EDA3062D0A34565850A19B583AE92C7D07C8BECAF6`  
**Sender (public):** `rE7gSkX5HoWs9t2Tax6tYDbivRqbMxF4RX` (Devnet faucet account; not D0/D3; not Testnet W*).  
**Box merge:** `e0224883f0de4e7e82ba78986bca7ad7434ca853` (PR #31).  
**Session:** 2026-09-28 ~22:02–22:03 CDT.

## Public ledger — shows vs hides

**Shows:** issuance flags (`CanHoldConfidentialBalance` + DynamicMPT immutable), `IssuerEncryptionKey` (33-byte public; no auditor key), public Payment amounts D0→sender and D0→D3, plaintext `ConfidentialMPTConvert` `MPTAmount` (including 1-unit key registration), `ConfidentialMPTSend` accounts/destination/issuance id, `ConfidentialMPTClawback` Holder + issuance id + plaintext `MPTAmount` burned.

**Hides:** confidential send amount (ciphertexts + ZKProof; no plaintext amount field), holder confidential inbox/spending balances (ciphertext), how a confidential balance was split across earlier sends.

Issuer can still prove mirror balance with `D0_ELGAMAL_SEED`; D3 can prove receipt with `D3_ELGAMAL_SEED`. No auditor ciphertext. Seeds stay outside git.

| Step | Result | Ledger | Hash |
|------|--------|--------|------|
| MPTokenIssuanceCreate | `tesSUCCESS` | `5694645` | `BEA5357B78FF1F6F46174B6DFD8CFB9F7B580941B46314B15F72DB9BB64E6BAB` |
| MPTokenIssuanceSet keys | `tesSUCCESS` | `5694649` | `F87E30CD8830C2F711D1103333E73E7C2D9C6C257ADF13D56D9C7DD4DAA5A24A` |
| MPTokenAuthorize sender | `tesSUCCESS` | `5694651` | `7165605EC823E3BA4F77FAC971A43732FEE94AEB5210E2F17E1B6DADC99E01DE` |
| MPTokenAuthorize D3 | `tesSUCCESS` | `5694653` | `D901BC987F5C9AA77EF793AB1994A114D73EF9A09196518A6B06B63D78A859A0` |
| public Payment → sender | `tesSUCCESS` | `5694655` | `30402BAF1F26E7CE78FB664D3346401AD807DDF2BFB0EE344B7655DB58EACD2F` |
| public Payment → D3 | `tesSUCCESS` | `5694657` | `ED78172DCCD5DFE237151C2E9B7F7F3D6D878BFECFFA59A9899D88AAD133349B` |
| ConfidentialMPTConvert D3 | `tesSUCCESS` | `5694660` | `905EC2363CC1047023F95A024930BECCFC7DC46810138FE22060F736D0F44EE8` |
| ConfidentialMPTConvert sender | `tesSUCCESS` | `5694662` | `2291A2EB6B5FED04EF68F8DDFBDD3A33C01EF7CBD0312E688F75CB339EACCFB2` |
| ConfidentialMPTMergeInbox sender | `tesSUCCESS` | `5694664` | `8450715CEAFAACCE929C9D711BC196EB32D9C6DDD7DEE18233B39545914BF0AF` |
| ConfidentialMPTSend → D3 | `tesSUCCESS` | `5694666` | `E54EA0BECDFE21BFC8220B633553098266F8B18FAD1CC19B8D8C4A0F57A1FCB5` |
| lock (`tfMPTLock` on D3) | `tesSUCCESS` | `5694668` | `E6C597D0EB32F53F7441181D1063E8D8BAFE0D832EFB2B540001B5E7A23F6908` |
| ConfidentialMPTClawback | `tesSUCCESS` | `5694670` | `FD2616CF6DFCBDACAAE4E2C2F5FC6A93FF08FEADA780B758B336AE0E3482A360` |

Archive rows in `lab/frontier/devnet-ledger.jsonl`. Do not copy into Testnet desk NAV.
