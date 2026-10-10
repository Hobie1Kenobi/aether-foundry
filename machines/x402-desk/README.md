# x402 desk merchant

**Network:** XRPL Testnet only. CAIP-2 `xrpl:1`. Mainnet `xrpl:0` is refused.  
**Pay-to:** W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`

W3 buying these routes is circular. The outbound payer refuses this payTo. See `machines/x402-outbound`.  
**Desk:** https://aether-foundry-desk.vercel.app (Vercel project `aether-foundry-desk`, root `web`)  
**RPC:** https://testnet.xrpl-labs.com

The desk stays seedless. It does not call `Wallet.sign` and it does not submit a signed blob. A buyer submits an exact XRP Payment on Testnet, then retries the HTTP call with proof. The desk reads that Payment from the public RPC and, if it matches, returns the JSON.

This is the [x402 v2](https://docs.x402.org/core-concepts/http-402) header set, with the [XRPL exact scheme](https://xrpl.org/docs/agents/agentic-payments-x402) fields (`sourceTag`, `invoiceId`, `xrpl:1`). The desk is dual-mode. With `XRPL_FACILITATOR_URL` unset it self-verifies a validated Payment and does not call a facilitator. Set that env to `https://xrpl-facilitator-testnet.t54.ai` (`XRPL_NETWORK=xrpl:1`) and the desk also accepts a T54 receipt: it may `POST /verify` and then reads the same Payment. It never calls settle, and any other facilitator host is refused. A client that only hands `signedTxBlob` to a facilitator must submit the Payment (or settle it on that testnet host) before the retry will return 200. Replay of the same validated Payment is possible until an operator records the hit; the server cannot durably mark an invoice spent. Pack: `machines/x402-citizen`.

## SKUs

| SKU | Method | Path | Drops | XRP | SourceTag |
|-----|--------|------|-------|-----|-----------|
| Generate a machine spec | GET or POST | `/api/x402/machine-spec` | 100000 | 0.1 | 202609271 |
| Audit reserve posture | GET | `/api/x402/reserve-audit` | 250000 | 0.25 | 202609272 |
| Quote a composition | GET | `/api/x402/composition-quote` | 500000 | 0.5 | 202609273 |

Free catalog: `GET /api/x402`.

`machine-spec` takes `prompt` as a query parameter or JSON body `{ "prompt": "..." }`. It returns a template pack (`README.md`, `PRIMITIVES.md`, `ECONOMICS.md`). A prompt that asks for a grid bot is refused and comes back as an observatory stub. No LLM.

`reserve-audit` calls Testnet `server_state`, `account_info`, `account_lines`, and `gateway_balances` for W0–W6 and the AMM. Stranding is `high` under 2 spendable XRP, `elevated` under 10, otherwise `clear`. Figures are from that response, not a stored snapshot.

`composition-quote` calls `amm_info` and `book_offers`. Quote is `0.7 * AMM spot + 0.3 * CLOB mid` in XRP per AETH (Machine #4). The CLOB mid prefers W1. `units` (default 1) scales `labor_xrp`. If the book has no two-sided mid, the quote is the AMM spot and says so.

## How an agent buys

One click from a checkout, against this production desk. The seed stays in the operator environment. W3 cannot be the payer.

```bash
DESK_URL=https://aether-foundry-desk.vercel.app \
  XRPL_BUYER_SEED='s...' \
  npm run x402:pay -- reserve-audit --record
```

Agent page: `machines/x402-desk/INBOUND.md`. The steps below are the fallback.

1. `GET` the route. Expect **402** and a `PAYMENT-REQUIRED` header. The body repeats the same object plus `howToPay`. The header is base64 JSON, x402 version 2.
2. Submit a Testnet **Payment**:
   - `Destination` = W3
   - `Amount` = the SKU's drops (string of drops, not IOU)
   - `SourceTag` = that SKU's tag (this tags the endpoint, not the buyer)
   - Bind the invoice from `extra.invoiceId` either as `Memo.MemoData` = hex UTF-8 of the invoice id, or as `InvoiceID` = SHA-256 of that UTF-8 string
   - Do not set `NetworkID` to 0. Do not set the partial-payment flag. Do not use a path payment.
3. Retry the same URL with header `PAYMENT-SIGNATURE` (alias `X-PAYMENT`): base64 JSON

```json
{
  "x402Version": 2,
  "accepted": "<echo accepts[0] from the 402>",
  "payload": {
    "transaction": "<64-hex validated tx hash>",
    "signedTxBlob": "<optional; hashed and looked up, not submitted>"
  }
}
```

4. **200** returns the resource, an `x402_hit` object, and a `PAYMENT-RESPONSE` header (`success`, `transaction`, `network`, `payer`). If the Payment is not on the ledger yet, the desk returns 402 `payment_not_on_ledger` and does not submit the blob.

Operator script (signs outside `web/`, refuses CI, refuses mainnet URLs):

```bash
# terminal 1
cd web && npm run dev

# terminal 2, from the repo root
DESK_URL=http://127.0.0.1:3000 XRPL_BUYER_SEED='s...' npm run x402:pay -- reserve-audit --record
```

`--record` runs the hit counter. Omit it to print the 200 without touching `market/pnl.md`.

Try one SKU against production after deploy:

```bash
curl -sS -D- -o /tmp/x402-reserve.json \
  https://aether-foundry-desk.vercel.app/api/x402/reserve-audit
# expect HTTP/1.1 402 and a PAYMENT-REQUIRED header
DESK_URL=https://aether-foundry-desk.vercel.app \
  XRPL_BUYER_SEED='s...' \
  npm run x402:pay -- reserve-audit --record
```

`XRPL_BUYER_SEED` is a Testnet seed in the operator environment. It is not a Vercel env var and it is not committed.

## How hits are counted

The 200 body includes `x402_hit` with `persisted: false`. Vercel serverless disk does not keep `market/pnl.md` or `lab/ledger-log.jsonl`.

From a checkout that has those files:

```bash
npm run x402:hit -- --file /tmp/x402-reserve.json
# or: curl -sS https://.../api/x402/reserve-audit -H "PAYMENT-SIGNATURE: ..." | npm run x402:hit
```

`src/x402-hits.js` appends one JSON line to `lab/ledger-log.jsonl` (`action` `x402_hit`) and sets the `x402_hits` cell in `market/pnl.md` to the count of unique `sku` + `hash` pairs. A second append of the same payment does not double-count. An in-memory duplicate flag on one warm server is not that count.
