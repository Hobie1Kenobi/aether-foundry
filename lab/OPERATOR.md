# Aether Foundry — Operator manual

Agent-run ops for the XRPL **Testnet** corporation. Read this before any session that signs, deploys, or archives.

## Hard laws (never violate)

1. **Testnet / altnets only.** Never mainnet transactions, seeds, or hosts.
2. **Public addresses and hashes only in git.** Seeds never in git, never in Vercel env, never committed under any name.
3. **Secrets live outside the repo.** On the Foundry box: `/workspace/aether-foundry-secrets/.env` (`W0_SEED`…`W6_SEED`, BUYER/STRANGER seeds and addresses). Never print seed values into chat or logs.
4. **Unix-epoch BUYER escrow scar is permanent.** Do not `EscrowFinish` / `EscrowCancel` that scar. BUYER was faucet-topped; leave the scar alone.
5. **Domain host** is `aether-foundry-desk.vercel.app` — **not** `*.v0.build`. Session-6 Domain `AccountSet` hash: `15D20D72A5BECEE3A84998503F8D357B68D321563959497D2FF629A6D0685F76`.

## Public anchors

| What | Value |
|------|--------|
| Repo | https://github.com/Hobie1Kenobi/aether-foundry |
| Desk (production) | https://aether-foundry-desk.vercel.app |
| Vercel project | `aether-foundry-desk` — **Root Directory = `web`** |
| Toml | https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml |
| W0 Treasury | `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` |
| AMM | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| HTTP JSON-RPC | https://s.altnet.rippletest.net:51234 |
| WebSocket | wss://s.altnet.rippletest.net:51233 |
| Explorer | https://testnet.xrpl.org |
| Founder GitHub | Hobie1Kenobi |

## Machine queue

| # | Slug | Status |
|---|------|--------|
| 1 | `work-ticket-escrow` | Trialled — RESULTS on disk |
| 2 | `drip-pass` | Trialled |
| 3 | `walk-in-window` | Trialled (STRANGER inbound) |
| 4 | `oracle-mid-ticket` | Trialled |
| 5 | `lp-badge` | Trialled (honor-system LP threshold) |
| 6 | `batch-heartbeat` | **Spec only** — gated on Batch amendment |

Pack layout: `machines/<slug>/{README,PRIMITIVES,ECONOMICS,THREAT,RUNBOOK,RESULTS,artifact.json}`.

Desk constants live in `web/lib/xrpl-public.ts` (`MACHINES`). Cards render in `web/components/DeskCards.tsx`. After adding a machine to `MACHINES`, update DeskCards and redeploy.

## Batch gate rule

Re-probe only. Check `server_info` / feature flags for `BatchV1_1` / `fixBatchV1_2` (names may evolve). Session-8: rippled 3.4.1, both **enabled:false**. `TicketBatch` ≠ atomic Batch — do not treat it as unlock.

- If disabled: document in RESULTS / session note and **stop**. No Batch txs. No faux-batch.
- If enabled: then pack + trial `machines/batch-heartbeat/` per its README.

## Session / archive pattern

- Session notes: `lab/sessions/`
- Weekly letter: `lab/weekly/YYYY-MM-DD.md`
- P&L hygiene: `market/pnl.md`, `market/fx.md` from live `account_info` / `amm_info` / `account_lines` / `account_nfts` on W0–W6, BUYER, STRANGER, AMM
- Optional: `npm run report:nav` when present
- Put continuation cards in session notes, not chat-only

## Desk ops

1. Merge machine UI + constants to `main`.
2. Redeploy Vercel project `aether-foundry-desk` (Root Directory `web`). No seeds in Vercel. Optional public env only: `NEXT_PUBLIC_XRPL_HTTP`, `NEXT_PUBLIC_XRPL_WS`, `NEXT_PUBLIC_NETWORK_LABEL`.
3. Verify:
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://aether-foundry-desk.vercel.app/`
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml`
4. Desk is **read-only**: no Wallet.sign, no AccountSet/OracleSet from the Next app.

## Routines (agent schedules, America/Chicago)

Created 2026-09-27:

| Routine | When | Behavior |
|---------|------|----------|
| Foundry morning health | Weekdays 08:56 | Quiet if green; alert on broken desk/toml/treasury |
| Foundry weekly NAV | Mondays 08:56 | Digest NAV / AETH outstanding / counterparties |
| Foundry Batch probe | Mon/Wed/Fri 12:56 | Quiet if Batch still disabled; alert only if gate flips |

## Push path (Foundry box)

Prefer `/workspace/aether-foundry-push.sh` when pushing from the box checkout. Never stage `.env` or anything under `aether-foundry-secrets/`.

## Never-touch checklist

- [ ] Mainnet hosts / seeds
- [ ] Unix-epoch BUYER escrow scar
- [ ] Committing secrets
- [ ] Batch txs while amendment disabled
- [ ] Domain host set to a `*.v0.build` preview
