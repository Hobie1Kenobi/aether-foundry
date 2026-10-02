# x402 outbound — W3 pays a foreign agent shop

**Network:** XRPL Testnet only. CAIP-2 `xrpl:1`. Mainnet `xrpl:0` is refused.  
**Payer:** W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`  
**Foreign payTo:** `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ`  
**Not Foundry revenue.** This address is not W0–W6, not the AMM, not BUYER, and not STRANGER. Do not add it to `web/lib/xrpl-public.ts` `WALLETS`.

CHANNELS buying the desk merchant is circular: those routes settle to W3. This pack is the other direction. W3 buys someone else's x402 service.

## Pieces

| Piece | Where |
|-------|--------|
| Outbound payer | `src/x402-outbound.js` (`npm run x402:outbound`) |
| Foreign agent shop | `machines/x402-outbound/foreign-shop.js` (`npm run x402:foreign`) |
| Hit counter | `x402_outbound_hits` in `market/pnl.md` plus `lab/ledger-log.jsonl` action `x402_outbound` |

The shop is a standalone Node process. It does not run inside the Vercel desk. It verifies an exact XRP Payment on the public Testnet RPC and does not sign or submit a blob. No facilitator.

## Foreign SKU

| SKU | Path | Drops | XRP | SourceTag | DIY drops |
|-----|------|-------|-----|-----------|-----------|
| Foreign oracle ping | `/foreign-oracle-ping` | 5000 | 0.005 | 77402101 | 0 |

Unpaid `GET` returns **402** and a base64 `PAYMENT-REQUIRED` header (x402 v2, `xrpl:1`). A paid **200** is JSON:

```json
{ "ok": true, "work": "foreign-oracle-ping", "ledger_index": 0 }
```

`ledger_index` is the validated ledger from `https://s.altnet.rippletest.net:51234`. It is not a hard-coded stub. `diyCostDrops` is `0` because that same RPC read is free. The 5000 drops buy the counterparty, not hidden data.

## Payer

```bash
npm run x402:outbound -- --url <RESOURCE_URL> [--max-drops <drops>] [--record] [--dry-run]
```

`RESOURCE_URL` is required (flag `--url` or the first positional). Optional ceiling: `--max-drops` or env `MAX_DROPS`. Optional `--record` appends a real `x402_outbound` line after HTTP 200 only.

Flow:

1. `GET` the resource. Require HTTP 402 and `PAYMENT-REQUIRED`.
2. Require x402 v2 and an `exact` XRP accept on `xrpl:1`.
3. Refuse if `payTo` is any address in `WALLETS` (W0–W6, AMM, BUYER, STRANGER).
4. Cheapness gate. Ceiling is `--max-drops`, else `MAX_DROPS`, else a stated `diyCostDrops` on the challenge. If `accept.amount` is above that ceiling, the process prints `too expensive vs DIY` and exits 2 without paying. If the challenge states no DIY cost and you set no ceiling, the payer will pay the ask — set a ceiling for unknown shops.
5. Prefer `W3_REGULAR_SEED`, else `W3_SEED` (env overrides the same name in the secrets file). A regular seed must match the W3 regular key in `machines/governance-board/activated.json`, or `W3_REGULAR_ADDRESS` when that env is set. A master seed's classic address must be W3. The Payment `Account` stays W3. Refuse CI / `GITHUB_ACTIONS`. Refuse mainnet websockets and `NetworkID` 0. The seed is never printed.
6. Sign a Testnet Payment: `Amount`, `SourceTag`, and invoice memo from the accept. Do not submit it yet. The signing key is the regular key when that seed is loaded.
7. Retry with `PAYMENT-SIGNATURE`. The payload is `signedTxBlob` plus `invoiceId` from `accept.extra.invoiceId` when the challenge has one. A shop that settles the blob (CryptoBuddy / t54 on Testnet) returns 200 and submits that blob itself. A shop that answers `payment_not_on_ledger` does not settle; the payer then submits that same blob once and retries. Print the status, the body, and the tx hash only after HTTP 200 or after that submit.

`--dry-run` stops before the seed is read and does not invent a hash.

## One-click (Foundry box)

Terminal 1:

```bash
npm run x402:foreign
```

Terminal 2, with `W3_REGULAR_SEED` (or `W3_SEED` if the regular seed is absent) in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`:

```bash
npm run x402:outbound -- --url http://127.0.0.1:8787/foreign-oracle-ping --max-drops 10000 --record
```

`--max-drops 10000` is above the 5000-drop SKU and above the stated DIY cost of 0. Omit it and the payer exits with `too expensive vs DIY` and does not sign.

`FOREIGN_SEED` may live in that same secrets file so the throwaway account can be swept later. The payer never uses it. It is not in git.

WebSocket default: `wss://s.altnet.rippletest.net:51233`. Override only with another `*.rippletest.net` URL (`XRPL_WS_URL`).

## What this VM archived

No `W3_SEED` on the cloud agent, so there is no outbound payment hash. The unpaid 402, the dry-run, and the faucet funding of the foreign account are in `RESULTS.md`. Do not treat the faucet hash as an x402 purchase.
