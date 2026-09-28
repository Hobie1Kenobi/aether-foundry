# Inbound MCP

stdio server for an agent that reads Aether Foundry without the Director in the loop. The catalog is [`tools.json`](./tools.json). The process is `npm run mcp`.

**Network:** XRPL Testnet (`xrpl:1`). Mainnet `xrpl:0` and NetworkID 0 are refused.  
**Desk:** https://aether-foundry-desk.vercel.app — read-only. No `Wallet.sign`.  
**Sign switch:** `MCP_SIGN=off` by default. This process returns a command. It does not sign and it does not accept a seed argument.

## Thirty seconds

```bash
npm install
npm run mcp
```

Full handshake, loopback HTTP, and refusals: [`RUNBOOK.md`](./RUNBOOK.md).

`walk_in_buy` answers `{ "delegated": true, "command": "npm run buy:walk-in -- --dry-run" }`. Run that on the operator machine. Do not pass `seed`, `secret`, or `private_key` into the JSON-RPC arguments.

## Tools

| Tool | Kind | What the server calls |
|------|------|------------------------|
| `walk_in_status` | read | `GET /api/inbound/walk-in` |
| `x402_catalog` | read | `GET /api/x402` |
| `director_status` | read | `lab/director-state.json` and `GET /api/status` (404 degrades) |
| `grant_eligibility` | read | `npm run grants:scan` (no pay) |
| `amm_quote` | read | public `amm_info`, unpaid composition-quote |
| `walk_in_buy` | delegated | `npm run buy:walk-in -- --dry-run` while `MCP_SIGN=off`. Armed box signer may POST `/sign` only after `/health` is 200 and the offer is `sold_out` |
| `x402_buy` | delegated | argv for `npm run x402:pay` ; not executed. Armed box signer may POST a W3 payment to the foreign shop |
| `sign_tx` | loopback | POST `127.0.0.1:8787/sign` when `MCP_SIGN=on`, `FOUNDRY_AGENT_SIGN=yes`, and `/health` is 200 |
| `dry_run_tx` | loopback | POST `/dry-run`. Does not load a key |
| `agent_health` | read | Signer `/health` plus desk `/api/status` |

`tools.json` stays the seven inbound tools. `sign_tx`, `dry_run_tx`, and `agent_health` are registered in `src/mcp/tools.js` for the box process. The desk route does not list them.

Read tools take no secrets. Buy tools must not add a seed field to `inputSchema`. The Walk-In script's own environment may hold `WALKIN_BUYER_SEED` or `XRPL_BUYER_SEED`, or the command uses `--faucet`. Those names stay out of MCP arguments.

## walk_in_status

Return the live W2 sell offer. Map the desk JSON `status` through as `open` or `sold_out`. Include `offers[0].offerId` when open. A published OfferID in `INBOUND.md` can be stale; do not prefer it over this response. The MCP projection omits buyer-variable hints from the desk JSON.

## walk_in_buy

With `MCP_SIGN` unset or `off`, ignore buy flags and return the dry-run command. Do not pass a seed as an argument.

| Argument | Flag, only if `MCP_SIGN=on` |
|----------|------------------------------|
| `dry_run: true` | `--dry-run` (do not also pass `--record`) |
| `faucet: true` | `--faucet` |
| `with_aeth: true` | `--with-aeth` |
| `offer_id` | `--offer <64 hex>` |
| `record: true` | `--record` |

`MCP_SIGN=on` still does not execute. It returns argv for the operator. `CI` or `GITHUB_ACTIONS` refuses that signing argv.

Exit codes from the script, when the operator runs it: `0` accepted or dry-run printed, `1` refused or RPC error, `2` Foundry labeled wallet, `3` sold out. Archive a hash only when the script printed one. Do not invent one.

Foundry addresses in `web/lib/xrpl-public.ts` `WALLETS` (W0–W6, AMM, BUYER, STRANGER) cannot be the buyer.

## x402_catalog / x402_buy

Catalog is free. A delegated buy names the production desk and the sku:

```bash
npm run x402:pay -- reserve-audit
npm run x402:pay -- machine-spec --prompt "channel plus nft receipt" --record
npm run x402:pay -- composition-quote --units 10 --record
```

The MCP process does not run those. `XRPL_BUYER_SEED` stays in the operator environment of `x402:pay`. If that variable's classic address is W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`, the script exits. W3 buying a desk SKU is circular.

Details: `machines/x402-desk/INBOUND.md`.

## Desk facade

`web/app/api/mcp/route.ts` repeats the read tools and the delegated buy answers over HTTP. It does not sign. Do not point it at a seed. The signing path is the operator's npm scripts, not Vercel.
