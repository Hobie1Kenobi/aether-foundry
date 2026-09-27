# x402 outbound — RESULTS

**Network:** XRPL Testnet (`xrpl:1`)  
**Date:** 2026-09-27  
**Payer:** W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`  
**Foreign payTo:** `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ`

## Live W3 → foreign purchase (Foundry box)

| Field | Value |
|-------|--------|
| Date | 2026-09-27 (America/Chicago) |
| Payer | W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` |
| payTo | `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ` (foreign shop, not Foundry revenue) |
| Amount | 5000 drops |
| sourceTag | 77402101 |
| Invoice | `fx-foreign-oracle-ping-muk8t4tw-srvjx0` |
| Payment hash | `D621848B4C66A940CA0DA51507D61A95D7546B4BB46E7925FC1D6FB414090C4C` |
| HTTP | 200 |
| Work | `foreign-oracle-ping` |
| Ledger index (payload) | 21099699 |
| `x402_outbound_hits` | **1** (unique hash via `--record`) |
| Explorer | https://testnet.xrpl.org/transactions/D621848B4C66A940CA0DA51507D61A95D7546B4BB46E7925FC1D6FB414090C4C |

One-click used:

```bash
npm run x402:foreign
npm run x402:outbound -- --url http://127.0.0.1:8787/foreign-oracle-ping --max-drops 10000 --record
```

`--max-drops 10000` is required because stated DIY is 0. Desk self-buy remains refused (payTo W3). Cloud agent PR trial had no `W3_SEED`; this Foundry-box run is the first archived outbound Payment.

## Foreign account (faucet, not an x402 buy)

| Field | Value |
|-------|--------|
| Address | `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ` |
| Role | Foreign agent shop. Not in desk `WALLETS`. |
| Faucet Payment | `D742BF14C599BAFDC0DE82396195CFFC2B865CF7F9B2D4C2802A48EA3FFE0C8B` |
| Faucet source | `rJjHYTCPpNA3qAM8ZpCDtip3a8xg7B8PFo` (Testnet faucet) |
| Amount | 100000000 drops (100 XRP) |
| Result | `tesSUCCESS` |
| Ledger | 21099378 |
| Balance at check | 100000000 drops, validated ledger 21099654 |
| Explorer | https://testnet.xrpl.org/accounts/r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ |

`FOREIGN_SEED` was written only to the gitignored file `/workspace/aether-foundry-secrets/.env` on the agent VM. It is not in git and it is not the payer. The Foundry box does not need it to receive. Sweeping this account later needs that seed; without it, the first 5000-drop payment stays there.

## Unpaid 402 (live local shop)

`npm run x402:foreign` on `127.0.0.1:8787`.

```text
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64 x402 v2>
```

Decoded accept:

| Field | Value |
|-------|--------|
| x402Version | 2 |
| scheme | exact |
| network | `xrpl:1` |
| asset | XRP |
| payTo | `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ` |
| amount | 5000 drops |
| sourceTag | 77402101 |
| diyCostDrops | 0 |
| shop | `foreign-agent` |
| foundry_revenue | false |
| facilitator | null |

Body `code` was `payment_required`. Invoice ids look like `fx-foreign-oracle-ping-…` and change per request.

## Payer on this VM (no seed)

Bare run, ceiling = stated DIY `0`:

```text
too expensive vs DIY
accept 5000 drops > ceiling 0 (stated DIY)
```

Exit 2. No Payment.

Dry-run with `--max-drops 10000`:

```text
dry-run
resource http://127.0.0.1:8787/foreign-oracle-ping
network xrpl:1
payTo r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ
payer rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw
drops 5000
sourceTag 77402101
ceiling 10000
no tx hash (not submitted)
```

Exit 0.

Same URL with `--max-drops 10000 --record` and no `W3_SEED`:

```text
W3_SEED is not loaded. Put W3_SEED in AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.
Refusing to sign.
One-click on the Foundry box (start the foreign shop if that is the URL):
npm run x402:foreign
npm run x402:outbound -- --url http://127.0.0.1:8787/foreign-oracle-ping --max-drops 10000 --record
```

Exit 1. `--record` did not append `lab/ledger-log.jsonl`.

## RPC the paid body uses

`readValidatedLedgerIndex` against `https://s.altnet.rippletest.net:51234` returned **21099644** during this trial. That call is the shop's work product. It was not wrapped in a paid 200, because W3 did not pay.

## One-click for the Foundry box

```bash
npm run x402:foreign
npm run x402:outbound -- --url http://127.0.0.1:8787/foreign-oracle-ping --max-drops 10000 --record
```

Requires `W3_SEED` for `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`. After a real HTTP 200, append the printed tx hash here and the `x402_outbound` line will already be in `lab/ledger-log.jsonl` if `--record` was set.
