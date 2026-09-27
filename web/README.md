# Aether Foundry — Vercel Desk (read-only)

XRPL **Testnet** public desk. No seeds, no `Wallet.sign`, no private-key APIs.

## Deploy on Vercel

1. Import `https://github.com/Hobie1Kenobi/aether-foundry`
2. Set **Root Directory** = `web`
3. Framework preset: Next.js (default)
4. Env (optional): copy from `.env.example` — only `NEXT_PUBLIC_XRPL_WS` / `NEXT_PUBLIC_NETWORK_LABEL`
5. Deploy. No secrets required.

After deploy, verify toml:

```bash
curl -sS https://HOST_PLACEHOLDER/.well-known/xrp-ledger.toml | head
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
- Reads only: `account_info`, `amm_info`, `book_offers`, `account_nfts`.
- The NAV strip sums those live `account_info` XRP balances. It does not use a hardcoded figure.
- Machine cards show RESULTS hashes as constants — no signing.
