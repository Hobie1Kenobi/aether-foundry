# Aether Foundry — Vercel Desk (read-only)

XRPL **Testnet** public desk. No seeds, no `Wallet.sign`, no private-key APIs.

## Deploy on Vercel

1. Import `https://github.com/Hobie1Kenobi/aether-foundry`
2. Set **Root Directory** = `web`
3. Framework preset: Next.js (default)
4. Env (optional): copy from `.env.example`. Nothing is required — defaults are XRPL Testnet.
   - `NEXT_PUBLIC_XRPL_HTTP` — HTTPS JSON-RPC the desk actually calls (default `https://testnet.xrpl-labs.com`). A transport failure retries `https://s.altnet.rippletest.net:51234` once.
   - `NEXT_PUBLIC_XRPL_WS` — used only to derive that HTTP URL when `NEXT_PUBLIC_XRPL_HTTP` is unset (`wss://host:51233` → `https://host:51234`). Default `wss://testnet.xrpl-labs.com`.
   - `NEXT_PUBLIC_NETWORK_LABEL` — display label
   - `XRPL_FACILITATOR_URL` — **server-only**. Do not use the `NEXT_PUBLIC_` prefix. Set it in the Vercel project (Production, and Preview if that environment should match) to `https://xrpl-facilitator-testnet.t54.ai`. Optional companion: `XRPL_NETWORK=xrpl:1`. Any other facilitator host, including `https://xrpl-facilitator-mainnet.t54.ai`, makes `facilitator.mode` `refused`. Unset keeps `self-verify`.
   - `X_BEARER_TOKEN` — **server-only**. X API v2 app bearer for Wall of Change recent search. Do not use the `NEXT_PUBLIC_` prefix and do not commit a value. `TWITTER_BEARER_TOKEN` is the alias when `X_BEARER_TOKEN` is unset. Unset leaves X headlines empty; Cointelegraph still loads. The search query is fixed in code. See `lab/wall/README.md`.
5. Deploy. No secrets required. Mainnet hosts in those vars are ignored. After the facilitator env is saved, redeploy so the server process sees it.

`/api/status` then reports `facilitator.mode` `dual`, `remoteVerify: true`, and `settles: false`. The desk may `POST /verify` on that testnet host. It does not call settle. Devnet F8–F10 cards read public git (`corp/wallets.md`, `lab/frontier/devnet-ledger.jsonl`) and stay off the Testnet NAV strip. No Devnet seed is read on Vercel.

After deploy, verify toml and the public status route. Root Directory stays `web`, so `web/app/api/status/route.ts` is `GET /api/status`.

```bash
curl -sS https://HOST_PLACEHOLDER/.well-known/xrp-ledger.toml | head
curl -sS https://aether-foundry-desk.vercel.app/api/status
curl -sS https://aether-foundry-desk.vercel.app/api/peers/hellos
curl -sS https://aether-foundry-desk.vercel.app/api/peers/sessions
curl -sS https://aether-foundry-desk.vercel.app/api/wall
curl -sS https://aether-foundry-desk.vercel.app/api/wall/rss.xml | head
```

`/api/wall` is the one route that calls a public mainnet JSON-RPC, for `server_info`, `feature`, and `account_info` on allowlisted mainnet-live accounts, all on `https://xrplcluster.com/`. It does not submit. The env vars above still cannot steer the rest of the desk onto a mainnet host. The same route merges Cointelegraph Ripple RSS with X recent search. X rows are labeled `X post. Not on-chain.` After `X_BEARER_TOKEN` is saved, redeploy, then:

```bash
curl -sS https://aether-foundry-desk.vercel.app/api/wall | jq '.headlines[] | {actor,label,url,title}'
```

## Domain host

`*.v0.build` preview hosts are **not** the Domain host. A private v0 preview (for example `https://aether-foundry-desk.v0.build`) is a visual reference only.

The Domain host is the Vercel-from-GitHub production or preview URL for this repo (`Root Directory` = `web`), after the founder pastes that hostname. See `lab/sessions/2026-09-27-vercel-desk.md`.

Do not `AccountSet`. Do not `OracleSet`. This desk does not submit either.

## Local

```bash
cd web
npm install
npm run dev
```

## Safety

- Addresses hardcoded from `corp/wallets.md` (public).
- Reads only, over HTTPS JSON-RPC (not the `xrpl` WebSocket client): `account_info`, `amm_info`, `book_offers`, `account_nfts`, and `account_objects` (`type: nft_offer`) for the Walk-In storefront. A failed call renders an ERROR chip; it does not fail the page.
- The NAV strip sums those live `account_info` XRP balances. It does not use a hardcoded figure.
- Machine cards show RESULTS hashes as constants — no signing.
- x402 routes under `/api/x402/*` verify a settled Testnet Payment to W3. They do not sign or submit. With `XRPL_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai` they also accept a T54 receipt and may `POST /verify`. They never call settle. Any other facilitator host is refused. Prices and the buyer script are in `machines/x402-desk/README.md`. Dual mode is `machines/x402-citizen`.

## x402

Unpaid calls return 402 and a base64 `PAYMENT-REQUIRED` header (`x402Version` 2, network `xrpl:1`). A paid retry sends `PAYMENT-SIGNATURE`. Success is 200 plus `PAYMENT-RESPONSE` and an `x402_hit` object. `/api/status` includes `facilitator` (`host`, `mode`, `networkId` 1, `settles: false`), `x402_outbound_hits`, and `x402_foreign_hits` (payers outside `WALLETS`). Vercel does not write `market/pnl.md`; from the repo root, `npm run x402:hit` records that object.

Desk SKUs still settle to W3. CHANNELS also pays outbound — see `machines/x402-outbound`. That payer refuses this desk's payTo.
