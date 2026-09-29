# RESULTS — x402 citizen

**Status:** code and docs. No new outbound hash.  
**Network:** XRPL Testnet. Network id 1.  
**Live flag:** false (no foreign `xrpl:1` SKU under the cap answered 402 outside Foundry desk / WALLETS).

## Facilitator probe (read)

`GET https://xrpl-facilitator-testnet.t54.ai/supported` returned 200:

```json
{"kinds":[{"x402Version":2,"scheme":"exact","network":"xrpl:1"},{"x402Version":2,"scheme":"upto","network":"xrpl:1"}],"extensions":["x402Secure"],"signers":{"xrpl:*":[]}}
```

Desk self-verify path remains OK. This session did not `POST /settle`.

## Foreign SKU discovery (2026-09-28 CDT)

Sought a public HTTPS resource that returns HTTP 402 with `accepts[].network` = `xrpl:1` and `payTo` outside `WALLETS`. Probes:

| URL | HTTP | Networks in PAYMENT-REQUIRED (or note) |
|-----|------|----------------------------------------|
| `https://xrpl-facilitator-testnet.t54.ai/supported` | 200 | facilitator only — not a shop resource |
| `https://xrpl-x402.t54.ai/hello` | 404 | docs site; no protected demo route |
| `https://xrpl-x402.t54.ai/ai-news` | 404 | same |
| `https://x402.org/protected` | 402 | `eip155:84532`, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — not XRPL |
| `https://x402.vercel.app/protected` | 402 | same EVM/Solana accepts |
| `https://www.x402scan.com/api/x402/resources?limit=50` | 402 | `eip155:8453` only |
| `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?network=xrpl:1&limit=20` | 200 | 0 items with `xrpl:*` accepts (sample page) |
| `https://agora402.io/api/v1/discover` | 200 | registry OK; no XRPL agents in sample |
| `https://aether-foundry-desk.vercel.app/api/x402/reserve-audit` | 402 | `xrpl:1` payTo W3 — **own desk**, refused by citizen guard |

No inventing a fake SKU. `machines/x402-citizen/candidates.json` stays `urls: []`. Local `npm run x402:foreign` on `127.0.0.1:8787` is not a public foreign HTTPS candidate.

## Outbound dry-run

```text
foreign_shop none
signed false
network xrpl:1
network_id 1
cap_drops 500000
fingerprint_source_tag 202609296
fingerprint_memo aether-foundry:f11
reason no foreign shop configured
no tx hash (not submitted)
```

Stopped before `--live`. No new `x402_outbound` ledger row.
