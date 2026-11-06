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

## Box handoff

Checked layout, not a new supervisor:

- Checkout: `/workspace/aether-foundry` on local `main` at `d442347`, one commit ahead of stale `origin/main` `0bd1127`. `lab/director-state.json` is dirty. Do not `git pull`, `reset`, `stash`, or `checkout` over that.
- Processes already up, started by `/workspace/foundry-ops/ensure-up.sh`: signer `127.0.0.1:8787`, scribe `8792`, license `8793`. Leave them running. systemd units are not installed. PID 1 is tini. `crontab` is not on the box.
- `ensure-up.sh` loads the signer token, W1–W6 regular seeds, and Ollama. It does not load a mission account. `runtime:watch` stays off.
- Signer `GET /health` field `signing: true` means that ordinary signer is armed. `mission_spend` on the same body is `false`. Mission readiness is `npm run missions:ready`, not the signer health flag.

The mission runner is dormant. `machines/missions/ensure-up.snippet.sh` is not sourced. Parent adds that one commented block only when they want it, and still does not set `FOUNDRY_MISSION_EXECUTE`.

```bash
cd /workspace/aether-foundry
npm run missions:ready
```

That prints booleans only. It does not submit and it does not print a seed.

Class `foreign-xrpl1-purchase` becomes autonomous only after the ledger activate event. Until then every purchase waits. A different `kind` still waits for a separate approval. Bridge return and EVM gas stay `NON_XRP`.

```bash
cd /workspace/aether-foundry
export FOUNDRY_MISSION_TOKEN='<set on the box, not in git>'
node -e 'require("./src/missions/engine").control("lab/missions",{action:"activate",confirm:"ACTIVATE-XRPL1-MISSION-SPEND",token:process.env.FOUNDRY_MISSION_TOKEN,now:new Date().toISOString()},{token:process.env.FOUNDRY_MISSION_TOKEN})'
```

A missing token fails closed. Add `MISSION_XRPL_ADDRESS` and `MISSION_XRPL_SEED` to the environment `ensure-up.sh` already uses, only when that isolated account exists. Do not put W0–W6 seeds in the mission process.

Publish writes one sanitized file and does not commit unless `FOUNDRY_MISSION_PUBLISH=yes`. It does not push. It does not stage `lab/director-state.json`.

```bash
cd /workspace/aether-foundry
npm run missions:publish
git add -- lab/missions/public-status.json
git diff --cached --name-only
git commit -m "Publish sanitized mission snapshot"
git status
```

`git status` should still show the dirty director file unstaged, and the local NAV commit still ahead of origin. Push that snapshot commit when you choose. Do not pull first.

The desk reads status, detail, and replay from that file at the current main SHA. The hash detects a corrupt file. It is not authentication. `prev_sequence` only checks the numbers inside the file. The reader has no saved checkpoint, so it cannot see a rolled-back chain. No snapshot is committed in this PR, so production stays `unavailable` and live spend is null.
