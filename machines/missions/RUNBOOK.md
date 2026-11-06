# RUNBOOK — Missions

Spending is authorized as a ceiling and not enabled. Do not sign. Do not submit. Do not fund from this command. Do not use W0.

## Caps

| Bucket | Drops | Counts toward the cap |
| --- | --- | --- |
| Per mission | 1000000 | yes, including fees |
| Chicago day | 5000000 | yes |
| Network fee, including a failed transaction fee | part of the mission | yes, and it stays spent |
| Bridge gas (`gas_fee_amount`) | part of the mission | yes |
| Bridge custody (amount sitting at the gateway) | part of the mission | yes, labeled custody, not a fee |
| Pending or uncertain settlement | the whole remaining hold | yes, and it is not released or retried |
| Account reserve | displayed only | no |

A process restart reads `lab/missions/events.jsonl`. It does not zero the day. A new Chicago day opens a new window and leaves the old lines in the log. Unsubmitted holds expire after 30 minutes. Uncertain and bridge-pending holds do not.

## First mission

Discovery reads an observation you supply. It does not scan mainnet and it does not call a faucet. W0–W7 and `synthetic: true` accounts are not foreign. If none remain, the status is `blocked` / `no_foreign_seller`.

A foreign payee must be on the allowlist passed to the engine. The committed desk snapshot has no payees, so the public feed stays empty until a sanitized export is reviewed and committed.

Human approval is an internal call with a token that is not written to the log. After approval the status is `spending_disabled`. `sign` and `submit` are refused.

## Bridge

Use the Axelar testnet planner only as an unsigned description. This engine will not set an EVM `msg.value`. If a route needs destination-chain gas, it stops with `NON_XRP` and the prerequisite is a separate explicit testnet authorization for that gas. It is not covered by the 1 XRP / 5 XRP XRPL drop caps.

`bridge_pending` and `dest_final` are different. A pending or uncertain bridge is not retried.

## Activation on the Foundry box

Spending stays off until an authenticated ledger event. Caps cannot be raised. This does not start a daemon and it does not submit.

```bash
cd /path/aether-foundry
export FOUNDRY_MISSION_TOKEN='<box token, not committed>'
node src/missions/cli.js status
node -e 'require("./src/missions/engine").control("lab/missions",{action:"activate",confirm:"ACTIVATE-XRPL1-MISSION-SPEND",token:process.env.FOUNDRY_MISSION_TOKEN,now:new Date().toISOString()},{token:process.env.FOUNDRY_MISSION_TOKEN})'
```

The signer unit already loads `/workspace/aether-foundry-secrets/.env` via `foundry-signer.service`. Add only these names there, on the box, not in git:

- `MISSION_XRPL_ADDRESS` — isolated classic address, not W0–W7
- `MISSION_XRPL_SEED` — that account's seed

Do not add `MISSION_XRPL_SEED` to the generic seed allowlist. Mission signing reads that environment variable only, and only when all of these are true: intent `mission_spend`, `FOUNDRY_AGENT_SIGN=yes`, `FOUNDRY_MISSION_EXECUTE=yes`, `execute: true`, and a submit hook. Otherwise `/sign` is a dry-run and loads no key. Payments to the Axelar gateway are refused on that path too.

```bash
curl -sS -X POST http://127.0.0.1:8787/dry-run \
  -H "Authorization: Bearer $FOUNDRY_SIGNER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"intent":"mission_spend","dry_run":true,"tx":{"TransactionType":"Payment","Account":"'"$MISSION_XRPL_ADDRESS"'","Destination":"<allowlisted foreign r-address>","Amount":"100","Fee":"12","NetworkID":1}}'
```

Expect `key_loaded: false` and `submitted: false`. Do not set `FOUNDRY_MISSION_EXECUTE` in this cloud environment.

## Public desk

`GET /api/missions`, `GET /api/missions/status`, `GET /api/missions/:id`, and `GET /api/missions/:id/replay` are read-only. Other methods return `PUBLIC_WRITE`. The desk serves `machines/missions/public-feed.json`. It does not read the operator ledger and it does not accept a visitor command.

Source health is `source` plus `source_observed_at`. The snapshot time is not a live clock.
