# Foundry Box daemon

**Network:** XRPL Testnet. Network id `1`. Xahau Testnet `21338` is read by the director snapshot only.  
**Signs:** RegularKeys on W2, W3, W5, and W6. Never W0. Never in GitHub Actions.  
**Default:** `--dry-run`. Unsigned transaction JSON. No seed read.

The company stays session-operated until a Foundry box runs a live action and a real `tesSUCCESS` hash is archived. This pack is the allowlist and the dry-run. It does not invent a hash.

```bash
npm run runtime:policy
npm run runtime:dry
npm run heartbeat:dry
```

`npm run runtime:live` and `npm run runtime:watch` throw `CI` when `CI`, `CI=1`, or `GITHUB_ACTIONS` is set. Live also requires `FOUNDRY_DAEMON_LIVE=yes`. Seed values stay in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`. The env var names are `W2_REGULAR_SEED`, `W3_REGULAR_SEED`, `W5_REGULAR_SEED`, and `W6_REGULAR_SEED`.

## Allowlist

| Action | Account | Key env | Max | Refuse |
|---|---|---|---|---|
| `walk_in_remint` | W2 | `W2_REGULAR_SEED` | 10 XRP offer, fees only extra | offer open; `offer_count` ≥ 1; CI; mainnet |
| `grant_pay` | W6 | `W6_REGULAR_SEED` | `1000000` drops | labeled `WALLETS`; ≥ 50 XRP; W6 spendable under 10 XRP |
| `heartbeat` | W5 | `W5_REGULAR_SEED` | default `1` drop, max `1000` | more than 4 per UTC day; rolling 24h backstop; inside 6h; destination not W3 or W6 |
| `x402_outbound` | W3 | `W3_REGULAR_SEED` | `500000` drops | circular W3→W3; mainnet; missing 402 |
| `director_snapshot` | none | none | 0 | must not sign |

Heartbeat memo is `purpose=aether-heartbeat`, `experiment=foundry-runtime`. Grant memo stays `purpose=aether-grant`, `experiment=grants-flywheel`. The Walk-In sell offer has no `Destination`. Taxon `20260927`.

## What this process does

One pass (`--once`) loads `src/runtime/allowlist.json` and `lab/director-state.json`, runs `director:wake --check` in process, and prints a plan. `--live` is the only path that can submit. `lab/ledger-log.jsonl` grows only after `tesSUCCESS`. A missing hash is not filled in.

The desk does not gain a signer. `.github/workflows/walk-in-remint-watch.yml` stays detect-only.

`src/runtime/allowlist.json` is `mode` `agent-sign` as well as the five daemon actions. `npm run signer` is the loopback RegularKey process for W1–W6 and the W7 hook account. It is not a Vercel route. See the runbook for `foundry-signer.service` and `foundry-daemon.service`, which restart on reboot.

`GET /api/status` is the read-only desk route. It does not sign. The daily flywheel is not in this pack.
