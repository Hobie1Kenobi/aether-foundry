# Inbound MCP wrapper

Schema for an external agent that buys from Aether Foundry without the Director in the loop. This directory is the contract. It is not a running server.

**Network:** XRPL Testnet (`xrpl:1`). Mainnet `xrpl:0` and NetworkID 0 are refused.  
**Desk:** https://aether-foundry-desk.vercel.app — read-only. No `Wallet.sign`.

Tool definitions: [`tools.json`](./tools.json).

## Tools

| Tool | Kind | What an implementer calls |
|------|------|---------------------------|
| `walk_in_status` | read | `GET /api/inbound/walk-in` or `npm run buy:walk-in -- --dry-run` |
| `walk_in_buy` | sign, delegated | `npm run buy:walk-in` |
| `x402_catalog` | read | `GET /api/x402` |
| `x402_buy` | sign, delegated | `npm run x402:pay` |

Read tools take no secrets. Buy tools must not add a seed field to `inputSchema`. The process environment already has `WALKIN_BUYER_SEED` or `XRPL_BUYER_SEED`, or the Walk-In command is run with `--faucet`.

## walk_in_status

Return the live W2 sell offer. Map the desk JSON `status` through as `open` or `sold_out`. Include `offers[0].offerId` when open. A published OfferID in `INBOUND.md` can be stale; do not prefer it over this response.

## walk_in_buy

Translate arguments to the npm command. Do not pass a seed as an argument.

| Argument | Flag |
|----------|------|
| `dry_run: true` | `--dry-run` (do not also pass `--record`) |
| `faucet: true` | `--faucet` |
| `with_aeth: true` | `--with-aeth` |
| `offer_id` | `--offer <64 hex>` |
| `record: true` | `--record` |

Exit codes from the script: `0` accepted or dry-run printed, `1` refused or RPC error, `2` Foundry labeled wallet, `3` sold out. Archive a hash only when the script printed one. Do not invent one.

Foundry addresses in `web/lib/xrpl-public.ts` `WALLETS` (W0–W6, AMM, BUYER, STRANGER) cannot be the buyer.

## x402_catalog / x402_buy

Catalog is free. A buy sets `DESK_URL=https://aether-foundry-desk.vercel.app` and runs:

```bash
npm run x402:pay -- reserve-audit
npm run x402:pay -- machine-spec --prompt "channel plus nft receipt" --record
npm run x402:pay -- composition-quote --units 10 --record
```

`XRPL_BUYER_SEED` stays in the operator environment. If that seed's classic address is W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`, the script exits. W3 buying a desk SKU is circular. The outbound payer already refuses every Foundry payTo, including W3.

Details: `machines/x402-desk/INBOUND.md`.
