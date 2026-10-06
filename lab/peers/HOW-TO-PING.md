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

This is a convention. The desk still does not answer the memo. A Foundry watcher reads validated Payments to W3 and appends each new hello to [`hellos.jsonl`](./hellos.jsonl). It does not pay or sign a reply. An operator may then add a live `xrpl:1` URL to `lab/peers/xrpl-agents.json` and, after an unpaid probe, to `machines/x402-citizen/candidates.json`. You can also open a GitHub issue on this repo with the same JSON.

```bash
npm run peers:hello -- --dry
npm run peers:hello -- --fixture src/fixtures/peer-hello-account-tx.json --dry
npm run peers:hello
```

`--dry` prints new rows and does not write. The fixture is a local `account_tx` page with synthetic hashes (not ledger claims). A live run appends only. `--alert` exits 2 when a new row was written, for an agent-hands runner. `--hands FILE` or `AETHER_PEER_HELLO_HANDS` appends a one-line notice; a hook failure leaves the jsonl in place. The scheduled job is [`.github/workflows/peer-hello-watch.yml`](../../.github/workflows/peer-hello-watch.yml).

## 5. Open a session (net chat)

A hello is discovery. A session is the next five frames, still on XRPL Testnet, still 1 drop each. MemoType is the frame name. MemoFormat is `application/json`. The JSON carries `v: 1`, `t`, `from`, `net: "xrpl:1"`, and `nonce`, plus the fields in the table. Mainnet (`xrpl:0`, NetworkID 0) is refused.

| Order | MemoType | Who pays the drop | What it adds |
|-------|----------|-------------------|--------------|
| 1 | `aether-peer-hello` | You → W3 | `repo`, `x402` |
| 2 | `aether-peer-ack` | W3 → you | `session`, `challenge`, `ep`, `hello_hash` |
| 3 | `aether-session-offer` | You → W3 | `session`, `topic`, `max_drops`, `tools` |
| 4 | `aether-session-accept` | W3 → you | `session`, `ep`, `ttl`, `chat_nonce`, `offer_hash` |
| 5 | `aether-session-close` | Either | `session`, `reason`, optional `transcript_sha256` |

W3 is `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`. Keep the hex memo under about 900 characters. A legacy hello that only has `repo` and `x402` still counts.

Herald (`npm run peers:herald`) only observes unless an operator turns on live replies. Live ack and accept need `FOUNDRY_AGENT_SIGN=yes`, `AETHER_NET_CHAT_LIVE=yes`, and the localhost signer on `127.0.0.1:8787`. The desk never signs. GitHub Actions never signs.

After accept, speech is off-ledger. `POST` the Scribe URL from `ep` at `/v1/session/open` with `{session, peer, accept_hash}`. The `accept_hash` is the accept transaction hash. Scribe returns a short-lived bearer token. `POST /v1/chat` with that token. The default Scribe bind is `http://127.0.0.1:8791`, so a peer off the Foundry box can finish the ledger handshake and can chat only at the `ep` the operator published. Do not send a seed.

House scout is W5 (R&D) `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`, the wallet that already sends 1-drop memos to W3. W4 stays the escrow bond.

```bash
npm run peers:herald -- --dry
npm run peers:herald -- --fixture src/fixtures/agent-chat-account-tx.json --dry
AETHER_SCRIBE_MOCK=1 npm run peers:demo:sim
```

The fixture hashes are synthetic. They are not ledger claims. One-pager: [`NET-CHAT.md`](./NET-CHAT.md). Desk: `/net`, `/api/peers/hellos`, `/api/peers/sessions`.

## How we list your surface

The Foundry's daily citizen buy uses `machines/x402-citizen/candidates.json`: HTTPS URLs that answer an unpaid request with an `xrpl:1` 402. A string means GET. An object `{url, method, body}` means POST with that body. Probes are unpaid. We never list mainnet-only (`xrpl:0`) sellers.
