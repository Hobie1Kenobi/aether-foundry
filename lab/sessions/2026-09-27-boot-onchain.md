# Session: XRPL Testnet on-chain boot — 2026-09-27

**Network:** XRPL Testnet (`wss://s.altnet.rippletest.net:51233`)  
**Explorer:** https://testnet.xrpl.org  
**Time (CT):** ~09:37–09:38 AM CT (UTC-5)  
**Roles:** Protocol + Treasurer + Atelier  
**Scripts:** `/workspace/xrpl-boot/boot-onchain.mjs` + `boot-aeth-amm.mjs` (scratch outside git; seeds never in repo)

## Dry-run → submitAndWait

Every step used `client.autofill` (dry log) then `submitAndWait`. Network ID confirmed `1` (not mainnet). Amendments probed: DID, AMM, NonFungibleTokensV1_1 all **enabled**.

## Results

| Step | Result | Hash / ID |
|------|--------|-----------|
| 1. DIDSet (W0 → charter URI) | tesSUCCESS | `95FD1096AE2D7F777697B65D2F97B7CBE3F08826654AE3CDC2D845A8022832A1` |
| 2. AccountSet asfDefaultRipple (W0) | tesSUCCESS; Flags=`8388608` (`lsfDefaultRipple`) | `55AA90B5611B20B014819C643604583C3CDFF5118AC11D6CD78CC22A4C9BC932` |
| 3a. TrustSet W1→W0 AETH limit 1e6 | tesSUCCESS | `BA6DEB736BE3C72DF8431D9BC5B87BA471B15B3E43DDA9285DB70338E6902243` |
| 3b. Payment W0→W1 10000 AETH | tesSUCCESS | `0E46250ADB4366F70C21140043A8F586ABB4EBBF995A0AFB2643AD4046FC7A2F` |
| 4. AMMCreate AETH/XRP (W1: 5000 AETH + 50 XRP, fee 0.5%) | tesSUCCESS | `ED9D47A42456A1504918CDFC1648BA4F86EDDBDFFB5CACC01F943B810B45A740` |
| 5. NFTokenMint Artifact #0 (W2, taxon 20260927, TransferFee 1000=1%) | tesSUCCESS | `DD7FEFB46E0443A5E9DB7357FD62FC8B501EAACCB8656FC315711F6F056E3995` |

### Derived IDs

| Kind | Value |
|------|-------|
| AMM account | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| LP token | currency `0330E60FAE706EAD2C7D511D790B07A6F3B89931`, issuer=AMM, value `500000` @ W1 |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF129D634CE0141DD56` |
| DID URI | https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/corp/charter.md |
| NFT URI | https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/README.md |

## Currency note (AETH)

`AETH` is **4 characters**. XRPL standard currency codes are 3-char ASCII; xrpl.js rejects raw `"AETH"`. On-ledger code is the 160-bit hex of ASCII `AETH` zero-padded:

`4145544800000000000000000000000000000000`

First TrustSet/Payment attempts failed client-side with `Unsupported Currency representation: AETH` (no tx submitted). Retried with hex — success. Documented here so future scripts use hex.

## Reserves / adversary notes

- Reserve base 1 XRP, inc 0.2 XRP (Testnet at time of boot).
- W0 OwnerCount rose for DID (+1).
- W1 OwnerCount: trust line + LP token line + AMM-related objects; still well under 100 XRP runway after seeding 50 XRP into AMM.
- W2 OwnerCount: NFTokenPage for Artifact #0.
- No account stranded.

## Secrets

Seeds read from `/workspace/aether-foundry-secrets/.env` only — **not** written into this session, wallets.md, ledger-log, or any git path.

## Follow-ups

- Machine #1 stub: `machines/work-ticket-escrow/README.md`
- Optional: mint further artifacts; AMMDeposit; x402 hooks
