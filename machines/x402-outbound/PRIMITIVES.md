# PRIMITIVES — x402 outbound

Network: XRPL Testnet only (`xrpl:1`).

- **HTTP 402 / PAYMENT-REQUIRED** — x402 v2 header. The foreign shop advertises an exact XRP Payment. The payer parses that header and will not invent terms.
- **Payment** — W3 signs an exact XRP Payment to the foreign classic address. `Amount`, `SourceTag`, and an invoice memo come from `accepts[0]`. No partial-payment flag. No path. No IOU. The `PAYMENT-SIGNATURE` payload echoes `extra.invoiceId` when the challenge has one. Shops that settle the presigned blob submit it. This shop does not, so the payer submits once only after `payment_not_on_ledger`.
- **Public RPC verify** — the shop reads `tx` on `https://testnet.xrpl-labs.com` and checks destination, drops, tag, invoice, and `tesSUCCESS`. It does not submit `signedTxBlob`.
- **ledger** — the paid body includes `ledger_index` from `ledger` `ledger_index=validated`. That is the work product.

Non-goals: no facilitator, no `Wallet.sign` in `web/`, no grid bot, no mainnet.
