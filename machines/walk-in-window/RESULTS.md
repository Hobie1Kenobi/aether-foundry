# Machine: walk-in-window — RESULTS

**Network:** XRPL Testnet  
**v2 listing:** 2026-09-27T18:24:22Z (mint tx `date`; offer left open)  
**v0 session:** 2026-09-27 ~10:06–10:10 AM CT (session-4)  
**Operator:** Foundry Director / Machine #3 primary

## v2 standing storefront (open)

Sell offer was **not** accepted. `INBOUND.md` is the token URI and the buyer instructions. When this offer is taken, remint, relist, and append the new hashes here. Do not treat the IDs below as permanent — the desk reads W2 live.

| Field | Value |
|-------|-------|
| Minter / seller | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Taxon | `20260927` |
| TransferFee | `1000` (1%) |
| Flags | mint `tfTransferable`; offer `tfSellNFToken` (`1`); no Destination |
| URI | https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/INBOUND.md |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D` |
| Mint hash | `DC7609E1331198731F7C0B2E58378C39F4F11511F40337DB3A4C865F00368E10` |
| CreateOffer hash | `2C013A0988DA6610B088D72B8E6F0378CFF52E9D7CB2ED2B181D3546318DDDBC` |
| OfferID | `08F7769F074C8C80C4DD6A691D2CEE3A3996458D845DA3C15F62BBAF699421B0` |
| Price | 10 XRP (`10000000` drops) |
| Disposition | OPEN on W2 at listing |
| Explorer NFT | https://testnet.xrpl.org/nft/000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D |
| Explorer mint | https://testnet.xrpl.org/transactions/DC7609E1331198731F7C0B2E58378C39F4F11511F40337DB3A4C865F00368E10 |
| Explorer offer | https://testnet.xrpl.org/transactions/2C013A0988DA6610B088D72B8E6F0378CFF52E9D7CB2ED2B181D3546318DDDBC |

## v0 — STRANGER (new faucet)

| Field | Value |
|-------|-------|
| Address | `rh4c6qMMyafccZrPFCPCN742BNMXfjKYss` |
| Funded via | `client.fundWallet()` (~100 XRP) |
| Seed location | secrets `.env` `STRANGER_SEED` only (never in git) |

## Path-pay (~50 AETH)

| Field | Value |
|-------|-------|
| TrustSet hash | `A784D97D6EF6B9E69C754676C7A3D2CFEB6E15B43C852E15B7D60EFBC9FAAFCB` |
| Payment hash | `BAF7B71ADCC203985D5686B201CE2E1FA94677D73A59428C02C902747E8C1158` |
| Paths | `[[{ currency: AETH, issuer: W0 }]]` (path_find → order book / AMM) |
| SendMax | `1508511` drops (~1.51 XRP) |
| delivered_amount | `50` AETH (issuer W0) |
| Source amount quote | `502837` drops |

## v0 — Walk-In NFT (walk-in-0001, sold)

| Field | Value |
|-------|-------|
| Minter | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Taxon | `20260927` |
| TransferFee | `1000` (1%) |
| URI | walk-in-window README raw URL |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1854F48CA0141DD5A` |
| Mint hash | `4E6DCF07406CB5D099CBDF0EFAD0D83E6B1ECD78A203DF2AD65F89DF58625A82` |
| Sell offer hash | `8B756EF63946A81A2C8C4F0EC450DD03D0EB3EB9723100149BA6C7BE5DBE131C` |
| Sell offer ID | `6AFBC9E248A4F4178D533AD09EAA309954561ED21E2BD007385108BD4C2CC4D4` |
| Price | 10 XRP |
| Accept hash | `7CF0B34F1A2536C55746958B0BF18FB4BE500DD7BBA9FFDA67E16F8C5F23A52F` |
| Holder | STRANGER `rh4c6qMMyafccZrPFCPCN742BNMXfjKYss` |
| Explorer | https://testnet.xrpl.org/nft/000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1854F48CA0141DD5A |

## Check (hospitality)

| Field | Value |
|-------|-------|
| CheckCreate hash | `1EF58F875EB4DE2AF3F7EFFE599AE871A0360F726B11CCE4AD1E6FCE70CC9F37` |
| Check ID | `24FC55FB6D2B2D792A7297E8CD04F212DCCD5FBDB5520680B02B759668CD809D` |
| CheckCash hash | `FC9D24150810549E5FD2E62B0DCAC2BC922445DF34CA71F765F6F9DD9CE4E0EC` |
| Amount | 2 XRP W0 → STRANGER |

## DID / TOML

| Item | Status |
|------|--------|
| W0 DID URI | Already `…/corp/charter.md` — **no DIDSet** |
| `public/xrp-ledger.toml` | Published this session (W0–W4, AMM, taxon, machine URIs) |

## Channel drill (housekeeping → drip-pass THREAT)

| Step | Hash / ID | Observation |
|------|-----------|-------------|
| Dest-close create (SettleDelay 300) | create `6AB80973…` / channel `2E812790…` | |
| Dest `tfClose` | `E233D2E8C6AB41DA5A6C9032D566D127CB21F7DA58A58BB7C97743DB5021CE33` | PayChannel **Deleted** immediately; unclaimed → source |
| Source-close create | `C1ACB9658B27DEDDF5108F63118091D345FF0B4346F77A6298119A0B7539DC5C` / `F83E073B…` | |
| Source `tfClose` | `D04A320649912A028C27E67922BF681CEF6ADF12FBF2ACF46B884962A55BCF04` | Channel **remains**; `Expiration=843837231` (~10:13:51 CT) |

## Notes

- No seeds in this file.
- Unix scar escrow on BUYER untouched.

## Walk-in buy 2026-09-27T22:07:28Z

Stranger accept via `npm run buy:walk-in`. Buyer is not a Foundry labeled wallet.

| Field | Value |
|-------|-------|
| Buyer | `rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN` |
| OfferID | `08F7769F074C8C80C4DD6A691D2CEE3A3996458D845DA3C15F62BBAF699421B0` |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D` |
| Amount | `10000000` |
| Accept hash | `C8044902172E6803154E144815A6B8D19FBD1067B71BF511DF35346DF8BC43C1` |
| AETH | not requested |

## v2 remint 2026-09-27T22:07:44Z

Founder one-click `npm run remint:walk-in`. Offer left open. Not accepted.

| Field | Value |
|-------|-------|
| Minter / seller | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1E1248CC60141DD5E` |
| Mint hash | `C66D0FDE490B18395108BD0E01EFF407BCDCD3D6364E3489D2E7A2D2F665A674` |
| CreateOffer hash | `75FCBFA093C36F92021E6FAB0C2C2E61A0ADB6B10A44416C1271B056B2E0A4CB` |
| OfferID | `CEAC38D14EBB2B544E59D78084ECAE1D52486BA29C53D248717CD42DB159654F` |
| Price | 10 XRP (`10000000` drops) |
| Disposition | OPEN on W2 — do not accept |
