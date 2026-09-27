# RUNBOOK — Walk-In Window

**Network:** XRPL Testnet `wss://s.altnet.rippletest.net:51233` / HTTPS `https://s.altnet.rippletest.net:51234`  
**Buyer doc:** `machines/walk-in-window/INBOUND.md`  
**Desk:** read-only. This runbook is operator-side. Never commit or print seeds.

## v2 standing storefront (current)

W2 keeps one open NFT sell offer. Strangers buy it themselves. The desk reads `account_objects` (`type: nft_offer`) on W2 at request time and shows OPEN or SOLD OUT.

The listing left open with this revision:

| Field | Value |
|-------|-------|
| Mint | `DC7609E1331198731F7C0B2E58378C39F4F11511F40337DB3A4C865F00368E10` |
| CreateOffer | `2C013A0988DA6610B088D72B8E6F0378CFF52E9D7CB2ED2B181D3546318DDDBC` |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D` |
| OfferID | `08F7769F074C8C80C4DD6A691D2CEE3A3996458D845DA3C15F62BBAF699421B0` |
| Amount | `10000000` drops (10 XRP) |
| Flags | `tfSellNFToken`, no Destination |
| URI | hex of the `INBOUND.md` raw URL on `main` |

Leave that offer open. Do not accept it with BUYER, STRANGER, or any other labeled Foundry wallet.

### When the offer is taken

1. Confirm SOLD OUT: desk card, or `account_objects` on W2 with `type: nft_offer` returns no sell offer (`Flags` bit `1`).
2. From W2, `NFTokenMint` — taxon `20260927`, flag `tfTransferable` (`8`), TransferFee `1000`, URI = hex of  
   `https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/INBOUND.md`
3. From W2, `NFTokenCreateOffer` — Amount `10000000`, flag `tfSellNFToken` (`1`), no Destination.
4. Confirm the new object via `account_objects` / the desk (status OPEN). Append mint hash, create-offer hash, NFTokenID, and OfferID to `RESULTS.md`.
5. Do not accept the new offer.

Secrets stay in the operator env outside the repo (`/workspace/aether-foundry-secrets/.env` or the equivalent path on the operator box). The desk never loads them.

There is no in-repo signer for v2. `src/walk-in-window-session.js` is the v0 session script only.

## v0 session (historical)

`node src/walk-in-window-session.js` funded a faucet STRANGER, path-paid ~50 AETH, minted walk-in-0001, and had STRANGER accept, then an optional 2 XRP Check. That NFT is not the standing storefront.

## Verify

- `account_objects` on W2 (`type: nft_offer`, validated ledger) shows one sell offer, or the desk card says SOLD OUT while a remint is pending.
- `INBOUND.md` matches the token URI.
- `public/xrp-ledger.toml` and `web/public/.well-known/xrp-ledger.toml` both link `INBOUND.md`.
- `npm run build` in `web/` passes.
- No seeds in git.
