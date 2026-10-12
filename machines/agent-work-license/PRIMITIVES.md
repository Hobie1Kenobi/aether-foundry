# PRIMITIVES — Agent Work License

XRPL Testnet. Network id `1`. No mainnet host. No W0.

## NFTokenMint (W2)

| Field | Value |
|-------|-------|
| Account | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| NFTokenTaxon | `20261012` |
| Flags | `9` (`tfBurnable` 1 + `tfTransferable` 8) |
| TransferFee | `5000` (5%, in the ledger's 1/100000 units) |
| URI | hex of `aflic:1:<64 hex sha256>` |
| Destination | omitted. A destination would mint straight to a holder and would require Amount |
| Amount | omitted |

Signer intent: `license_mint`. Allowed while a Walk-In offer is still open. Walk-In mints stay taxon `20260927` and still require `sold_out`.

## NFTokenCreateOffer (W2)

| Field | Value |
|-------|-------|
| Account | W2 |
| NFTokenID | the minted id |
| Amount | `2000000` drops (2 XRP) |
| Flags | `1` (`tfSellNFToken`) |
| Destination | omitted. A public listing, same rule as Walk-In |

Signer intent: `license_list`. Cap is exactly 2 XRP. The daemon's `assertSigningTx` path still refuses any W2 sell offer that is not the 10 XRP Walk-In price. License listing goes through the signer, not that path.

The 5% transfer fee is not taken on this first sale. The issuer is the seller. It is taken when a later owner sells to someone else. The broker percentage is defined by `TransferFee` on the token. The issuer receives it automatically. The signer does not sign third-party resales.

## NFTokenAcceptOffer (W4)

| Field | Value |
|-------|-------|
| Account | W4 `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN` |
| NFTokenSellOffer | the W2 offer id |
| Amount | omitted. The price sits on the offer |

Signer intent: `license_buy`. Before it signs, the signer reads the offer with `ledger_entry` on the same Testnet host it already proved (`network_id` 1). The offer must be a sell, owned by W2, with no Destination, and Amount `2000000`. That 2 XRP counts toward W4's float and `daily_max_drops` (`30000000`). A client-supplied amount is ignored.

## Redeem challenge

Not a transaction. `POST /sign-challenge` on `127.0.0.1:8787`.

Canonical text, one trailing newline:

```text
aether-license-redeem/v1
account=<classic holder>
nftoken_id=<64 hex>
nonce=<32 hex>
exp=<unix seconds>
job=<ledger-analysis-report|scribe-summary>
```

The signer accepts this shape only, and only for W4. The `account` line must be the W4 account, not the regular key. A `tx` field on this path is refused. The signature is `ripple-keypairs` over the UTF-8 bytes. It is not an `xrpl.Wallet.sign` of a transaction, and the blob is not submitted.

W4's master key is not what the signer holds. The signer holds `W4_REGULAR_SEED`. `deriveAddress(publicKey)` is the regular key `rfXBxqPjprj1J5Ekq5v82D3BDqRm7ms7p2`. The redeem server accepts the signature when that address is the regular key on file for the claimed account in `machines/governance-board/activated.json`, or when the derived address is the claimed account itself (an outside holder signing with the key that matches the address).

TTL is 120 seconds. Anything further than 600 seconds ahead is refused.

## Redeem checks

`POST /v1/license/redeem` on `127.0.0.1` (the demo binds an ephemeral port).

1. Parse the canonical challenge.
2. Reject an expired challenge.
3. Reject a nonce already in `lab/licenses/nonces.jsonl`.
4. Verify the signature. On success, store the nonce before the ledger read so a good signature cannot be replayed.
5. `account_nfts` on a validated ledger. The claimed account must hold that `NFTokenID`. Issuer must be W2. Taxon must be `20261012`. URI must be `aflic:1:<hash>`.
6. Load `lab/licenses/<hash>.json` or a desk file with the same hash. Job and hash must match. `expiry` must be in the future. `license_redeemed` rows for that token must be fewer than `uses`.

## Deliver

Read `account_info` and `account_objects` for the holder. The receipt line in `lab/ledger-log.jsonl` carries the report. `POST /v1/summarize` on the Scribe (`127.0.0.1:8791`) may rewrite the sentence. A down Scribe, a non-loopback URL, or a failed call keeps the fixed sentence. The job still completes.

## Settle

| Uses after this redeem | Action |
|------------------------|--------|
| Still below `uses` | `license_settled` action `counter`. No burn transaction |
| Equal to `uses` (including a 1-use license) | Unsigned `NFTokenBurn` from the holder. No `Owner` field |

The demo asks the signer to submit W4's burn (`license_burn`). An outside holder burns with their own key. The redeem server does not sign.

## Remint watch

`npm run watch:walk-in` still means the Walk-In line. Sell offers whose Amount is `10000000` drops are Walk-In. Sell offers whose Amount is `2000000` drops are the license line. A missing license offer, when `RESULTS.md` still names a last OfferID, writes `lab/remint-plans/license-<stamp>.json` and a `license_sold_out` row. `detect_only` is true. `remint` is false. The watch does not sign.
