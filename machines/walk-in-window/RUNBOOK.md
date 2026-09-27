# RUNBOOK — Walk-In Window

**Network:** XRPL Testnet `wss://s.altnet.rippletest.net:51233` / HTTPS `https://s.altnet.rippletest.net:51234`  
**Buyer doc:** `machines/walk-in-window/INBOUND.md`  
**Desk:** read-only. This runbook is operator-side. Never commit or print seeds.

## Stranger buy (no Director)

A stranger or an external agent accepts the open sell offer. The Director does not sign this path.

```bash
npm run buy:walk-in -- --dry-run
npm run buy:walk-in -- --faucet
WALKIN_BUYER_SEED='s...' npm run buy:walk-in -- --record
```

| Flag / case | Behavior |
|-------------|----------|
| `--dry-run` | Prints the live offer and `NFTokenAcceptOffer`. Does not load a seed or sign. |
| `--faucet` | `client.fundWallet()` on Testnet, then accept. Ignores buyer seeds in the environment. |
| `WALKIN_BUYER_SEED` | Preferred seed. `XRPL_BUYER_SEED` is the fallback when `--faucet` is omitted. |
| Foundry wallet | Exit 2. Addresses in `web/lib/xrpl-public.ts` `WALLETS` (W0–W6, AMM, BUYER, STRANGER) do not count as walk-in. |
| Mainnet host or NetworkID 0 | Exit 1. No sign. |
| `CI` or `GITHUB_ACTIONS` | Exit 1 before any live sign. Dry-run still works. |
| No sell offer | Exit 3 (`SOLD OUT`). Do not reuse the OfferID table below. |
| `--with-aeth` | After a successful accept, TrustSet plus a ~50 AETH path-pay. Off unless this flag is set. |
| `--record` | Appends `lab/ledger-log.jsonl` (`action` `walk_in_buy`) and a RESULTS note. Requires the submitted hash. Refused together with `--dry-run`. |

Discovery is `account_objects` on W2, `type: nft_offer`, `ledger_index: validated`. Agents can also `GET /api/inbound/walk-in` on the desk. That route is seedless.

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

### Watcher (no seeds)

```bash
npm run watch:walk-in
# node src/walk-in-remint-watch.js [--quiet]
```

Polls `https://s.altnet.rippletest.net:51234` `account_objects` on W2 with `type: nft_offer` and `ledger_index: validated`.

| Result | Behavior |
|--------|----------|
| OPEN (sell offer, Flags bit 1) | Exit 0. `--quiet` prints nothing. |
| SOLD OUT | Writes `lab/remint-plans/walk-in-YYYYMMDD-HHMMSS.json` (mint + createOffer fields, URI text and hex, `npm run remint:walk-in`). Appends one `walk_in_sold_out` line to `lab/ledger-log.jsonl` and a detection section to `RESULTS.md`. Does not sign. A second poll for the same OfferID does not append again. |
| RPC error | Exit 1. An outage is not a sale. |

GitHub Action `.github/workflows/walk-in-remint-watch.yml` runs the watcher every 30 minutes and on `workflow_dispatch`. It commits the plan, ledger line, and RESULTS only when those files change. It does not load seeds or sign.

To exercise the writer without touching this checkout:

```bash
node src/walk-in-remint-watch.js --simulate-sold-out --root /tmp/walk-in-sim
```

That event is tagged `"simulated": true`. Do not commit it over a live OPEN listing.

### When the offer is taken

1. Confirm SOLD OUT: the watcher, the desk card, or `account_objects` on W2 with `type: nft_offer` returns no sell offer (`Flags` bit `1`).
2. On the founder box (secrets outside the repo), run `npm run remint:walk-in`. That submits the two transactions below and refuses while a sell offer is still open. It also refuses when `CI` or `GITHUB_ACTIONS` is set.
3. `NFTokenMint` — taxon `20260927`, flag `tfTransferable` (`8`), TransferFee `1000`, URI = hex of  
   `https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/INBOUND.md`
4. `NFTokenCreateOffer` — Amount `10000000`, flag `tfSellNFToken` (`1`), no Destination.
5. Confirm the new object via `account_objects` / the desk (status OPEN). The one-click script appends mint hash, create-offer hash, NFTokenID, and OfferID to `RESULTS.md` and `lab/ledger-log.jsonl`.
6. Do not accept the new offer.

Secrets stay in the operator env outside the repo (`AETHER_SECRETS`, or `/workspace/aether-foundry-secrets/.env` on the Foundry box). The desk and the GitHub Action never load them.

`src/walk-in-window-session.js` is the v0 session script only. It accepted a sale; the v2 one-click does not.

## v0 session (historical)

`node src/walk-in-window-session.js` funded a faucet STRANGER, path-paid ~50 AETH, minted walk-in-0001, and had STRANGER accept, then an optional 2 XRP Check. That NFT is not the standing storefront.

## Verify

- `npm run buy:walk-in -- --dry-run` prints the live OfferID and does not sign.
- `npm run watch:walk-in` exits 0 while the listing is OPEN (`--quiet` is silent).
- `account_objects` on W2 (`type: nft_offer`, validated ledger) shows one sell offer, or the desk card says SOLD OUT while a remint is pending.
- `INBOUND.md` matches the token URI.
- `public/xrp-ledger.toml` and `web/public/.well-known/xrp-ledger.toml` both link `INBOUND.md`.
- `npm run build` in `web/` passes.
- No seeds in git.
