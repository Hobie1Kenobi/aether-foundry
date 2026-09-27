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
| 3 | `walk-in-window` | v2 storefront open; stranger buy is `npm run buy:walk-in`; remint is local |
| 4 | `oracle-mid-ticket` | Trialled |
| 5 | `lp-badge` | v0 NFT still honor-system. v1 door `lp-badge-bound` trialled: PASS `D21E08CC…FED2`, revoked `tecBAD_CREDENTIALS` `919C1C77…EE48` |
| 6 | `batch-heartbeat` | **Spec only** — gated on Batch amendment |
| 7 | `xahau-split-treasury` | Live on Xahau Testnet — SetHook + 1 XAH split |
| 8 | `governance-board` | Policy H1 in force. SignerList / RegularKey live set is Foundry-box gated |

Pack layout: `machines/<slug>/{README,PRIMITIVES,ECONOMICS,THREAT,RUNBOOK,RESULTS,artifact.json}`.

Desk constants live in `web/lib/xrpl-public.ts` (`MACHINES`). Cards render in `web/components/DeskCards.tsx`. After adding a machine to `MACHINES`, update DeskCards and redeploy.

## LP Badge bind

v0 NFT on W1 is unchanged. The ledger gate is `machines/lp-badge-bound/`: a DepositAuth door that requires credential `aether-lp-ok`. XRPL Testnet `Credentials` is enabled. No Hooks amendment is enabled here; do not SetHook against `s.altnet.rippletest.net`.

```bash
npm run lp-badge:bound -- --dry-run
npm run lp-badge:bound -- --record
```

Seeds `LPB_ISSUER_SEED`, `LPB_HOLDER_SEED`, `LPB_DOOR_SEED`, `LPB_STRANGER_SEED` stay outside the repo. The trial holder is not W1. Do not `AMMWithdraw` W1's seeded LP to "prove" the old NFT.

Follow-ups, not this cut: `oracle-mid-ticket` quote attestation is still honor-system. A same-execution LP read would be a Xahau hook on a pool that actually lives on Xahau.

## Batch gate rule

Re-probe only. Check `server_info` / feature flags for `BatchV1_1` / `fixBatchV1_2` (names may evolve). Session-8: rippled 3.4.1, both **enabled:false**. `TicketBatch` ≠ atomic Batch — do not treat it as unlock.

- If disabled: document in RESULTS / session note and **stop**. No Batch txs. No faux-batch.
- If enabled: then pack + trial `machines/batch-heartbeat/` per its README.

## Session / archive pattern

- Session notes: `lab/sessions/`
- Weekly letter: `lab/weekly/YYYY-MM-DD.md`
- P&L hygiene: `market/pnl.md`, `market/fx.md` from live `account_info` / `amm_info` / `account_lines` / `account_nfts` on W0–W6, BUYER, STRANGER, AMM
- Optional: `npm run report:nav` when present
- Continuation card: `lab/director-state.json` (`next_actions`, `blockers`, `last_session_id`). Session notes still get a copy. Contract: `lab/DIRECTOR_WAKE.md`.

## Walk-In Window loop

The shop stays open without a human session watching the screen. Signing stays on the founder box.

1. `.github/workflows/walk-in-remint-watch.yml` (every 30 minutes, or `workflow_dispatch`) runs `node src/walk-in-remint-watch.js --quiet`. Read-only Testnet HTTP. Exit 0 while W2 still has a sell offer. No seeds in GitHub Actions.
2. When that sell offer is gone, the run writes `lab/remint-plans/walk-in-*.json`, appends `lab/ledger-log.jsonl` (`walk_in_sold_out`), and a detection line in `machines/walk-in-window/RESULTS.md`, then commits those files. That line is not a remint. A wake listener then runs `npm run director:snapshot` and `npm run director:wake -- --check --routine walk-in-remint` (exit 2 when the offer is gone).
3. Founder, with secrets outside the repo: `npm run remint:walk-in`. Loads `W2_SEED` from `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`, mints, and relists. Refuses while a sell offer is still open. Refuses when `CI` or `GITHUB_ACTIONS` is set. Does not accept.
4. Desk reads `account_objects` and shows OPEN again.

## Stranger Walk-In buy

A stranger or an external agent buys the open W2 sell offer without the Director signing. The published OfferID in `INBOUND.md` is not required.

```bash
npm run buy:walk-in -- --dry-run
npm run buy:walk-in -- --faucet
WALKIN_BUYER_SEED='s...' npm run buy:walk-in -- --record
```

Testnet only. Discovery is `account_objects` (`type: nft_offer`, validated). The script refuses mainnet hosts and NetworkID 0. It refuses any address in `web/lib/xrpl-public.ts` `WALLETS` (W0–W6, AMM, BUYER, STRANGER) — exit 2. It refuses `CI` / `GITHUB_ACTIONS` before signing. Sold out exits 3. `--with-aeth` is the only path-pay, and it is off by default. `--record` appends `lab/ledger-log.jsonl` and a RESULTS note only after a real `tesSUCCESS` hash. Do not invent that hash.

The desk stays read-only. `GET /api/inbound/walk-in` returns the live offer, `howToBuy`, and the npm hint. Agent tool shapes live in `machines/inbound-mcp/tools.json` (`walk_in_status`, `walk_in_buy`, `x402_catalog`, `x402_buy`). Those buy tools delegate to the npm scripts. They do not take a seed argument.

Desk SKUs, one click against production:

```bash
DESK_URL=https://aether-foundry-desk.vercel.app npm run x402:pay -- reserve-audit
```

W3 must not be that buyer. See `machines/x402-desk/INBOUND.md`.

`next_actions` in `lab/director-state.json` tells a wake that `npm run buy:walk-in` is the open-shop path. Remint is still Foundry-box only after `sold_out`. No buy hash is stored there until a real `--record`.

## Desk ops

1. Merge machine UI + constants to `main`.
2. Redeploy Vercel project `aether-foundry-desk` (Root Directory `web`). No seeds in Vercel. Optional public env only: `NEXT_PUBLIC_XRPL_HTTP`, `NEXT_PUBLIC_XRPL_WS`, `NEXT_PUBLIC_NETWORK_LABEL`.
3. Verify:
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://aether-foundry-desk.vercel.app/`
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml`
4. Desk is **read-only**: no Wallet.sign, no AccountSet/OracleSet from the Next app.
5. x402 merchant: unpaid `GET /api/x402/<sku>` is HTTP 402. Pay Testnet XRP to W3, then retry. See `machines/x402-desk/README.md`. The desk does not persist hits. `npm run x402:hit` appends `lab/ledger-log.jsonl` and sets `x402_hits` in `market/pnl.md`.

## x402 merchant

Testnet only (`xrpl:1`). Pay-to is W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`. No facilitator: the desk verifies a validated Payment on the public Testnet RPC and does not submit a signed blob. `npm run x402:pay` is the operator buyer (seed in `XRPL_BUYER_SEED`, never in Vercel).

| SKU | Path | Drops | XRP | SourceTag |
|-----|------|-------|-----|-----------|
| machine-spec | `/api/x402/machine-spec` | 100000 | 0.1 | 202609271 |
| reserve-audit | `/api/x402/reserve-audit` | 250000 | 0.25 | 202609272 |
| composition-quote | `/api/x402/composition-quote` | 500000 | 0.5 | 202609273 |

## x402 outbound (W3 pays a foreign shop)

`npm run x402:outbound` loads `W3_SEED` from `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`. It refuses CI, mainnet (`xrpl:0` and mainnet hosts), and any payTo in `web/lib/xrpl-public.ts` `WALLETS` (W0–W6, AMM, BUYER, STRANGER). Never buy a Foundry payTo with W3 — the desk merchant settles to W3, so W3 buying the desk is circular.

The foreign trial counterparty is `machines/x402-outbound/` (payTo `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ`, not Foundry revenue). `FOREIGN_SEED` may sit in the same secrets file; it is not the payer. See that README for the one-click.

## Xahau W7 split hook

Xahau Testnet only (`wss://xahau-test.net`, network ID 21338). Not XRPL Testnet and not Xahau mainnet (`21337`).

W7 is `r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h`. The hook is already installed. HookHash `B9B6A6D5DDCF4212CC046217500AB3D90D54C7E63684F98E7991F4EBA9BC6C09`. SetHook `7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447`. A 1 XAH split validated as `E6142FB0B82375A01D7E07A3AF0046B6030F4CC34BCB9C3B0A2148E3ED9EEBD6`.

```bash
npm run xahau:compile
npm run xahau:sethook -- --dry-run
npm run xahau:trial -- --drops 1000000 --dry-run
```

Live install and a new trial, on the Foundry box only:

```bash
npm run xahau:sethook -- --override --record
npm run xahau:trial -- --drops 1000000 --record
```

`W7_SEED` and `W7_PAYER_SEED` load from `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`. Signing refuses CI. Pack: `machines/xahau-split-treasury/`.

## Week-2 governance (XRPL Testnet W0–W6)

Not the Xahau hook. Pack: `machines/governance-board/`. Charter has the weights.

Hunch H1: Director 2, Treasurer 2, Atelier 1, Market 1, SignerQuorum 3. Master keys stay enabled (`asfDisableMaster` is refused). W1–W6 get `SetRegularKey`, not an AccountSet. Payments from W0 of 50 test XRP or more still need `lab/motions/`.

```bash
npm run gov:dry
npm run gov:live
npm run gov:multisign
```

`gov:dry` does not read seeds. `gov:live` and `gov:multisign` load `W0_SEED`…`W6_SEED` from `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`, generate missing `SIGNER_*_SEED` and `W*_REGULAR_SEED` values into that file, and refuse CI. The multisign demo is 10000 drops (W0 → W6, Director + Market). Do not invent a hash when the seeds are absent.

## Director wake

Canonical state is `lab/director-state.json`. The contract, merge rules, and the exact fields each routine reads are in `lab/DIRECTOR_WAKE.md`.

```bash
npm run director:snapshot
npm run director:wake
npm run director:wake -- --check --quiet --routine morning-health
```

Snapshot is read-only Testnet HTTP (XRPL network id 1, Xahau network id 21338). It refuses mainnet hosts and refuses to write seeds. It does not invent a ledger index when RPC fails. It refreshes balances and watched objects, and it keeps `next_actions`, `blockers`, and `last_session_id`.

Wake prints the continuation card and does not hit RPC. `--check` exits 0 when quiet and 2 on alert. Do not use `npm run health` for the morning routine; that script can faucet and pay.

## Routines (agent schedules, America/Chicago)

Created 2026-09-27. Each routine reads `lab/director-state.json` after a fresh snapshot. Field lists are in `lab/DIRECTOR_WAKE.md`.

| Routine | When | Wake | Behavior |
|---------|------|------|----------|
| Foundry morning health | Weekdays 08:56 | `--routine morning-health` | Quiet if desk, toml, and W0 treasury (spendable, SignerList, RegularKeys) are green |
| Foundry weekly NAV | Mondays 08:56 | `--routine weekly-nav` | Digest `watched.testnet_nav_spendable_drops`, AETH outstanding, AMM amounts. Counterparties stay in `market/pnl.md`. A changed NAV is not an alert. |
| Foundry Batch probe | Mon/Wed/Fri 12:56 | `--routine batch-probe` | Quiet while `watched.batch.atomic_enabled` is false. Alert only if the gate flips. No Batch txs from the alert. |
| Walk-In remint | after `walk_in_sold_out`, or any shop check | `--routine walk-in-remint` | Quiet while `watched.walk_in_offer.status` is `open`. Alert on `sold_out`. Signing stays on the Foundry box. |

## Push path (Foundry box)

Prefer `/workspace/aether-foundry-push.sh` when pushing from the box checkout. Never stage `.env` or anything under `aether-foundry-secrets/`.

## Never-touch checklist

- [ ] Mainnet hosts / seeds
- [ ] Unix-epoch BUYER escrow scar
- [ ] Committing secrets
- [ ] Batch txs while amendment disabled
- [ ] Domain host set to a `*.v0.build` preview
- [ ] Walk-In remint or Walk-In buy from CI (the watcher and `buy:walk-in --dry-run` do not sign)
- [ ] A Foundry labeled wallet (W0–W6, AMM, BUYER, STRANGER) accepting the Walk-In offer
- [ ] W3 paying a Foundry payTo (desk SKUs included — that is circular)
- [ ] `asfDisableMaster` / `lsfDisableMaster` without a written recovery path (week-2 leaves master enabled)
- [ ] `gov:live` or `gov:multisign` from CI
- [ ] Seeds or mainnet hosts in `lab/director-state.json`
- [ ] Inventing a ledger index when `director:snapshot` RPC fails
