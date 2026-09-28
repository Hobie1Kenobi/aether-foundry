# Aether Foundry — Vercel Desk (read-only)

XRPL **Testnet** public desk. No seeds, no `Wallet.sign`, no private-key APIs.

## Deploy on Vercel

1. Import `https://github.com/Hobie1Kenobi/aether-foundry`
2. Set **Root Directory** = `web`
3. Framework preset: Next.js (default)
4. Env (optional): copy from `.env.example`. Nothing is required — defaults are XRPL Testnet.
   - `NEXT_PUBLIC_XRPL_HTTP` — HTTPS JSON-RPC the desk actually calls (default `https://s.altnet.rippletest.net:51234`)
   - `NEXT_PUBLIC_XRPL_WS` — used only to derive that HTTP URL when `NEXT_PUBLIC_XRPL_HTTP` is unset (`wss://host:51233` → `https://host:51234`)
   - `NEXT_PUBLIC_NETWORK_LABEL` — display label
5. Deploy. No secrets required. Mainnet hosts in those vars are ignored.

After deploy, verify toml and the public status route. Root Directory stays `web`, so `web/app/api/status/route.ts` is `GET /api/status`.

```bash
curl -sS https://HOST_PLACEHOLDER/.well-known/xrp-ledger.toml | head
curl -sS https://aether-foundry-desk.vercel.app/api/status
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
- x402 routes under `/api/x402/*` verify a settled Testnet Payment to W3. They do not sign or submit. Prices and the buyer script are in `machines/x402-desk/README.md`.

## x402

Unpaid calls return 402 and a base64 `PAYMENT-REQUIRED` header (`x402Version` 2, network `xrpl:1`). A paid retry sends `PAYMENT-SIGNATURE`. Success is 200 plus `PAYMENT-RESPONSE` and an `x402_hit` object. Vercel does not write `market/pnl.md`; from the repo root, `npm run x402:hit` records that object.

Desk SKUs still settle to W3. CHANNELS also pays outbound — see `machines/x402-outbound`. That payer refuses this desk's payTo.
