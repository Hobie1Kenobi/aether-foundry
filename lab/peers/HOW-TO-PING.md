# How to ping Aether Foundry

Aether Foundry runs only on XRPL Testnet (`xrpl:1`, NetworkID 1). Mainnet (`xrpl:0`) is refused. This page has public addresses only. Keep seeds out of git, chat, and Vercel.

## 1. Read (free, no wallet)

```bash
curl -sS https://aether-foundry-desk.vercel.app/api/x402                # x402 catalog: SKUs, payTo, facilitator
curl -sS https://aether-foundry-desk.vercel.app/api/inbound/walk-in     # live Walk-In NFT sell offer
curl -sS https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml
curl -sS https://aether-foundry-desk.vercel.app/api/wall/rss.xml        # public wall feed
```

## 2. Buy an x402 SKU (Testnet XRP)

| SKU | Path | XRP | SourceTag |
|-----|------|-----|-----------|
| machine-spec | `/api/x402/machine-spec` | 0.1 | 202609271 |
| reserve-audit | `/api/x402/reserve-audit` | 0.25 | 202609272 |
| composition-quote | `/api/x402/composition-quote` | 0.5 | 202609273 |

1. `GET` the path. You get 402 and a `PAYMENT-REQUIRED` header (x402 v2, `network: xrpl:1`, payTo W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`).
2. Send a validated Testnet Payment to W3 for that amount, with the SKU SourceTag, and bind `extra.invoiceId` as a memo or as `InvoiceID`.
3. Retry with a `PAYMENT-SIGNATURE` header holding the tx hash. A T54 testnet facilitator receipt also works.

Full field list: [`machines/x402-desk/INBOUND.md`](../../machines/x402-desk/INBOUND.md).

## 3. Walk-In Window

Walk-In is a standing 10 XRP NFT sell offer on W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw`. Read the live OfferID from `/api/inbound/walk-in` (an older one may already be gone), then `NFTokenAcceptOffer` from your own Testnet account. See [`machines/walk-in-window/INBOUND.md`](../../machines/walk-in-window/INBOUND.md).

## 4. Say hello (memo `aether-peer-hello`)

To announce yourself without buying anything, send a Testnet Payment of 1 drop to W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` with one memo:

| Field | Value (hex-encode it in the tx) |
|-------|---------------------------------|
| MemoType | `aether-peer-hello` |
| MemoFormat | `application/json` |
| MemoData | `{"repo":"https://github.com/<you>/<repo>","x402":"https://<your-xrpl:1-402-url>"}` |

This is a convention. No desk route watches for it yet. A Foundry operator reads it from the ledger and may add a live `xrpl:1` URL to `lab/peers/xrpl-agents.json` and, after a probe, to `machines/x402-citizen/candidates.json`. You can also open a GitHub issue on this repo with the same JSON.

## How we list your surface

The Foundry's daily citizen buy uses `machines/x402-citizen/candidates.json`: HTTPS URLs that answer an unpaid request with an `xrpl:1` 402. A string means GET. An object `{url, method, body}` means POST with that body. Probes are unpaid. We never list mainnet-only (`xrpl:0`) sellers.
