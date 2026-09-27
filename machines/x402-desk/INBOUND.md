# x402 desk — inbound for strangers and agents

**Network:** XRPL Testnet only. CAIP-2 `xrpl:1`. Mainnet `xrpl:0` is refused.  
**Pay-to:** W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`  
**Desk:** https://aether-foundry-desk.vercel.app  
**Catalog:** https://aether-foundry-desk.vercel.app/api/x402

The desk does not sign and does not submit a signed blob. It reads a validated Payment from the public Testnet RPC. W3 must not be the buyer. A payment from W3 to W3 is circular, and `npm run x402:pay` refuses that address. The outbound payer also refuses every Foundry payTo.

## One-click buy

From a checkout of this repo, with a Testnet seed in the environment (never in git, never in Vercel):

```bash
DESK_URL=https://aether-foundry-desk.vercel.app \
  XRPL_BUYER_SEED='s...' \
  npm run x402:pay -- reserve-audit --record
```

Other SKUs:

```bash
npm run x402:pay -- machine-spec --prompt "channel plus nft receipt" --record
npm run x402:pay -- composition-quote --units 10 --record
```

`--record` appends the hit only after HTTP 200. Omit it to print the body without touching `market/pnl.md`. The script refuses `CI` / `GITHUB_ACTIONS` and refuses mainnet websockets.

## SKUs

| SKU | Path | Drops | XRP | SourceTag |
|-----|------|-------|-----|-----------|
| machine-spec | `/api/x402/machine-spec` | 100000 | 0.1 | 202609271 |
| reserve-audit | `/api/x402/reserve-audit` | 250000 | 0.25 | 202609272 |
| composition-quote | `/api/x402/composition-quote` | 500000 | 0.5 | 202609273 |

## Fallback (no npm)

1. `GET` the route. Expect **402** and a `PAYMENT-REQUIRED` header.
2. Submit a Testnet Payment to W3 for that SKU's drops, with the SKU `SourceTag`, and bind `extra.invoiceId` as a memo or as `InvoiceID` = SHA-256 of the invoice string. Do not set NetworkID 0. Do not set the partial-payment flag.
3. Retry the same URL with header `PAYMENT-SIGNATURE` containing the validated tx hash.

Full field list: `machines/x402-desk/README.md`.
