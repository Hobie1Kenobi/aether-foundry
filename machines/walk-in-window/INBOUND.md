# Walk-In Window — inbound for strangers & agents (v2)

**Network:** XRPL Testnet only (`wss://s.altnet.rippletest.net:51233` / HTTPS `https://s.altnet.rippletest.net:51234`)  
**Not mainnet. No Foundry seeds are ever shared.**

Aether Foundry keeps a **standing storefront NFT sell offer** on W2 Atelier. Anyone with a Testnet faucet wallet can buy it with plain XRP. Path-paying for AETH is optional after the purchase.

The NFT URI is this file:

`https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/INBOUND.md`

## Public anchors

| Role | Address |
|------|---------|
| W0 Treasury (AETH issuer) | `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` |
| W2 Atelier (NFT minter / seller) | `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| AMM AETH/XRP | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| Desk | https://aether-foundry-desk.vercel.app |
| Toml | https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml |

Currency AETH hex: `4145544800000000000000000000000000000000`

## Steps (stranger or agent)

1. **Faucet** — fund a fresh Testnet wallet (for example `client.fundWallet()` on `wss://s.altnet.rippletest.net:51233`, or https://faucet.altnet.rippletest.net/accounts). Keep enough XRP for the 10 XRP price, the fee, and the NFT reserve. Do **not** reuse a Foundry labeled wallet (BUYER does not count as walk-in).
2. **Find the open offer** — do this at buy time. The OfferID below is the listing that was open when this page was published; a purchase deletes it and Foundry remints a new one.
   - Desk: the Walk-In Window card on https://aether-foundry-desk.vercel.app (live `account_objects` read).
   - Or HTTPS JSON-RPC `account_objects` on W2 with `type: "nft_offer"` and `ledger_index: "validated"`. A sell offer has `Flags` bit `1` (`tfSellNFToken`). The OfferID is the object's `index`. `Amount` is drops (`10000000` = 10 XRP).
   - Or `nft_sell_offers` with the current `nft_id` / `NFTokenID`. The OfferID is `nft_offer_index`.
3. **Buy** — submit `NFTokenAcceptOffer` paying that XRP amount. No `Destination` was set, so any funded Testnet account can accept.

```json
{
  "TransactionType": "NFTokenAcceptOffer",
  "Account": "<your faucet address>",
  "NFTokenSellOffer": "<OfferID from step 2>"
}
```

4. **Optional AETH** — after you hold the NFT: `TrustSet` a limit for AETH issued by W0, then a same-account `Payment` of about 50 AETH with `SendMax` in XRP and `Paths` from `ripple_path_find` (AMM `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`). Machine #3 `RESULTS.md` has a worked v0 example (TrustSet `A784D97D6EF6B9E69C754676C7A3D2CFEB6E15B43C852E15B7D60EFBC9FAAFCB`, path-pay `BAF7B71ADCC203985D5686B201CE2E1FA94677D73A59428C02C902747E8C1158`). Quotes move; do not reuse that session's `SendMax` blindly.
5. **Discover more** — W0 Domain points at the desk. Machine READMEs are linked from the toml and from GitHub.

## Listing published with this page

Verify on the desk before you sign. These are the v2 objects that were open on Testnet when the URI was set — not a promise that this OfferID is still for sale.

| Field | Value |
|-------|-------|
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D` |
| NFTokenOfferID | `08F7769F074C8C80C4DD6A691D2CEE3A3996458D845DA3C15F62BBAF699421B0` |
| Mint hash | `DC7609E1331198731F7C0B2E58378C39F4F11511F40337DB3A4C865F00368E10` |
| CreateOffer hash | `2C013A0988DA6610B088D72B8E6F0378CFF52E9D7CB2ED2B181D3546318DDDBC` |
| Price | 10 XRP (`10000000` drops) |
| Flags | `tfSellNFToken` (`1`); no Destination |
| Taxon | `20260927` |
| TransferFee | `1000` (1%) |
| NFT | https://testnet.xrpl.org/nft/000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D |

## What this is / is not

- **Is:** an open Testnet storefront artifact (taxon `20260927`). The offer stays open until a stranger takes it.
- **Is not:** a mainnet product, a signing desk, or an invitation-only drop. BUYER accepting does not count as walk-in. This page never includes seeds or `Wallet.sign` material.

When the standing offer is taken, Foundry remints and relists. Check the desk for the current OfferID.
