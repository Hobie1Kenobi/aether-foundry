# RUNBOOK — Inbound MCP

**Network:** XRPL Testnet (`xrpl:1`) only. Network id `0` and Xahau mainnet `21337` are refused.  
**Process:** `npm run mcp` → `node src/mcp/server.js`  
**Sign switch:** `MCP_SIGN=off` (default). The process does not call `Wallet.sign` and does not spawn a signer.  
**Desk:** https://aether-foundry-desk.vercel.app — read-only. `web/app/api/mcp/route.ts` is a seedless facade. It is not a signing server.

## Thirty seconds

```bash
npm install
npm run mcp:test
npm run mcp
```

Speak newline-delimited JSON-RPC on stdin. Logs go to stderr. stdout is protocol only.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"walk_in_status","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"walk_in_buy","arguments":{}}}
```

`walk_in_buy` with `MCP_SIGN` unset returns:

```json
{"delegated":true,"signed":false,"executed":false,"command":"npm run buy:walk-in -- --dry-run"}
```

Run that command yourself, on the operator machine, if you want a dry-run. A live accept is still `npm run buy:walk-in -- --faucet` or a buyer variable in the environment of that script. Do not put the buyer variable in the MCP arguments.

## Tools

| Tool | Signs | What the server does |
|------|-------|----------------------|
| `walk_in_status` | no | `GET /api/inbound/walk-in` on the production desk |
| `x402_catalog` | no | `GET /api/x402` |
| `director_status` | no | Read `lab/director-state.json`. `GET /api/status`. HTTP 404 is `{ available: false, status: 404 }` until that route exists |
| `grant_eligibility` | no | `grants:scan` via `executeScan` (dry-run). No `grants:pay` |
| `amm_quote` | no | `server_info` then `amm_info` on `https://s.altnet.rippletest.net:51234`. Unpaid `GET /api/x402/composition-quote`. No `PAYMENT-SIGNATURE` |
| `walk_in_buy` | delegated, or POST `/sign` | Default: the dry-run command above. `MCP_SIGN=on` without `FOUNDRY_AGENT_SIGN=yes` still only returns argv. When `MCP_SIGN=on`, `FOUNDRY_AGENT_SIGN=yes`, and signer `/health` is 200, a `sold_out` shop POSTs a W2 `NFTokenMint` to `/sign`. An open offer is not reminted |
| `x402_buy` | delegated, or POST `/sign` | Default: `argv` for `npm run x402:pay -- <sku>`. Not executed. Armed the same way, it POSTs a W3 Payment to the foreign shop for the SKU amount. It does not pay W3 |
| `sign_tx` | POST `/sign` | Wallet `W1`–`W7` plus a transaction object. Refuses W0. Requires the three gates above |
| `dry_run_tx` | POST `/dry-run` | Unsigned autofill. Does not load a key |
| `agent_health` | no | `GET` signer `/health` and desk `/api/status` |

Inbound catalog file: `machines/inbound-mcp/tools.json` (seven tools). `sign_tx`, `dry_run_tx`, and `agent_health` are registered in `src/mcp/tools.js` and are not rows in that file.

## Refusals

| Case | Result |
|------|--------|
| Argument named `seed`, `secret`, or `private_key` | Error `FORBIDDEN_ARG`. Stderr says the name was rejected. The value is not logged |
| `MCP_SIGN=on` and `CI` / `GITHUB_ACTIONS` / `CI=1` on a buy that would sign | Error `CI`. Nothing is submitted |
| Argument named `seed`, `secret`, or `private_key` on `sign_tx` | Error `FORBIDDEN_ARG`. The value is not logged |
| `VERCEL` set on `sign_tx` / an armed buy | Error `DESK`. Do not deploy this MCP on Vercel |
| Host `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, `xahau.network` | Error `MAINNET` before fetch |
| Network id `0` or `21337` | Error `MAINNET` |
| `server_info` omits `network_id` | Error `RPC`. No guessed ledger index |
| `node src/mcp/server.js --http` with `MCP_HTTP_HOST=0.0.0.0` | Exit 1. Bind is `127.0.0.1` only |
| Same flag when `VERCEL` is set | Exit 1. Do not expose a signing MCP on Vercel |

Optional loopback HTTP (stdio is the default):

```bash
node src/mcp/server.js --http
# MCP_HTTP_PORT defaults to 8787. MCP_HTTP_HOST must stay loopback.
```

## Desk facade

`GET /api/mcp` and `POST /api/mcp` on the desk answer the same tool names. Buy tools always return the delegated dry-run or argv. `grant_eligibility` on the desk points at `npm run grants:scan` and does not scan from Vercel. `director_status` there does not read the git state file; the stdio server does.

## Archive

This machine does not submit. No ledger hash belongs in this runbook until a separate `buy:walk-in` or `x402:pay` run prints one. Do not invent one.
