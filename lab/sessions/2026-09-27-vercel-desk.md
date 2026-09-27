# Session STOP — vercel-desk (2026-09-27)

**Network:** XRPL Testnet ONLY (NOT mainnet)  
**Scope:** public data · read-only web desk · no seeds · Unix scar untouched · no AccountSet / OracleSet run  
**Director choice:** `web/` **in** `aether-foundry` (not sibling app)

---

## A) Pages / Vercel folder layout (`web/`)

```
web/
├── .env.example                 # NEXT_PUBLIC_XRPL_WS + NETWORK_LABEL only (NO seeds)
├── .gitignore
├── README.md                    # Vercel: Root Directory = web
├── next.config.ts
├── next-env.d.ts
├── package.json
├── tsconfig.json
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                 # desk (force-dynamic)
├── components/
│   └── DeskCards.tsx            # account_info / amm_info / book_offers / account_nfts + machine cards
├── lib/
│   ├── xrpl-public.ts           # addresses, AETH hex, taxon, RESULTS hashes
│   └── xrpl-read.ts             # read-only Client helpers (no Wallet.sign)
└── public/
    └── .well-known/
        └── xrp-ledger.toml      # identical to public/xrp-ledger.toml at repo root
```

Repo twin toml (raw/GitHub until Domain set):

```
public/xrp-ledger.toml
```

Vercel: **Root Directory = `web`**. No secrets required for deploy.

---

## B) curl after deploy (verify toml)

```bash
curl -sS https://HOST_PLACEHOLDER/.well-known/xrp-ledger.toml | head
```

Expect `[METADATA]` with `network = "XRPL Testnet"` and `[[ACCOUNTS]]` / `[[ISSUERS]]` / `[[TOKENS]]` / `[[WEBLINKS]]`.

---

## C) AccountSet Domain skeleton (DO NOT submit from this session)

After founder pastes the real host, operator fills `Domain` as **ASCII hostname hex** (no `https://`, no path).

Example: hostname `foundry.example.com` → hex of those bytes only.

```json
{
  "TransactionType": "AccountSet",
  "Account": "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
  "Domain": "HOST_PLACEHOLDER_AS_HEX"
}
```

**Note:** `Domain` is hex of the hostname string only (e.g. `foundry.example.com` → hex). Not the full URL. Not run in this session. No OracleSet.

---

## Safety checklist

- [x] No seeds in `web/` or Vercel `.env.example`
- [x] Toml dual path: `public/xrp-ledger.toml` ≡ `web/public/.well-known/xrp-ledger.toml`
- [x] Desk read-only (NAV reads + RESULTS hash constants)
- [x] Unix scar escrow on BUYER untouched
- [x] No AccountSet / OracleSet executed

## Commit

`feat(web): vercel desk read-only + well-known toml`
