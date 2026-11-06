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

The old checkout stays where it is: `/workspace/aether-foundry` local `main` at `d442347`, one commit ahead of stale `origin/main` `0bd1127`, with dirty `lab/director-state.json`. Do not pull, reset, stash, or checkout over it. Leave the processes from `/workspace/foundry-ops/ensure-up.sh` running: signer `127.0.0.1:8787`, scribe `8792`, license `8793`. systemd is not installed, PID 1 is tini, and `crontab` is absent. `ensure-up.sh` loads the ordinary signer token, W1–W6 regular seeds, and Ollama. It does not load a mission account. `runtime:watch` stays off. `machines/missions/ensure-up.snippet.sh` is not sourced.

`npm run missions:ready` and `FOUNDRY_MISSION_RUN=yes` print one ready check and return. That command is not a loop and it does not pay. The scheduled worker is the release `bin/start`, which runs `src/missions/worker.js`.

Install the non-secret tar into an isolated directory. The tar's `INSTALL.md` names the git SHA.

```bash
install -d /workspace/foundry-ops/releases/<sha>
tar -xf foundry-missions-<sha>.tar -C /workspace/foundry-ops/releases/<sha>
cd /workspace/foundry-ops/releases/<sha>
npm ci --omit=dev
./bin/start
./bin/health
./bin/stop
```

`npm ci` installs locked `xrpl@5.3.0` from the public npm registry. Node must be `>=20.19`. No other service is required. `bin/start` writes pid files under `/workspace/foundry-ops/missions-runtime` and strips W0–W6 seed variables before the child starts. It does not set `FOUNDRY_MISSION_EXECUTE`. `bin/stop` signals only those pid files.

Two health checks:

- Ordinary signer `GET http://127.0.0.1:8787/health` field `signing: true` means the existing W1–W6 signer is armed. `mission_spend` on that body is `false`.
- Release `./bin/health` reads `127.0.0.1:8794` (worker) and, if started, `127.0.0.1:8788` (dedicated signer). The dedicated signer reports `signing: false` always. Its `mission_spend` field is true only when `MISSION_XRPL_ADDRESS` and `MISSION_XRPL_SEED` are in that process. `execute_armed` is false under `bin/start`.

The worker stays asleep until both `FOUNDRY_MISSION_WORKER=yes` and a ledger activate event for class `foreign-xrpl1-purchase`. A `worker.json` of `{ "asleep": true }` forces it back to sleep. It reads `/workspace/foundry-ops/missions-runtime/discovery.json`. If that file is missing or empty, it does not invent a seller or an amount. One discovery item is handled per tick. The default interval is 60 seconds and the floor is 15 seconds. A prepared dry-run is not submitted later just because execute is turned on; a new discovery id is required.

Activate the class inside the isolated ledger, not the old checkout:

```bash
cd /workspace/foundry-ops/releases/<sha>
export FOUNDRY_MISSION_TOKEN='<set on the box, not in git>'
export FOUNDRY_MISSION_LEDGER=/workspace/foundry-ops/missions-runtime/ledger
node -e 'require("./src/missions/engine").control(process.env.FOUNDRY_MISSION_LEDGER,{action:"activate",confirm:"ACTIVATE-XRPL1-MISSION-SPEND",token:process.env.FOUNDRY_MISSION_TOKEN,now:new Date().toISOString()},{token:process.env.FOUNDRY_MISSION_TOKEN})'
```

Create the isolated testnet account on the box after this code is in place. The tool uses `xrpl.Wallet.generate`. Funding uses `Client.fundWallet` on `wss://s.altnet.rippletest.net:51233` and `faucet.altnet.rippletest.net` only when `FOUNDRY_MISSION_FAUCET=yes`. XRPL Labs has no faucet.

```bash
cd /workspace/foundry-ops/releases/<sha>
FOUNDRY_MISSION_WALLET_TOOL=yes FOUNDRY_MISSION_FAUCET=yes \
  node src/missions/wallet-tool.js --out /workspace/foundry-ops/missions-runtime/account.json
```

Stdout is the address only. The seed stays in that one file, mode 0600. Put `MISSION_XRPL_ADDRESS` and `MISSION_XRPL_SEED` in the dedicated signer environment. Do not copy them into `ensure-up.sh` and do not put W0–W6 seeds in the mission process.

Publishing uses the GitHub contents API for `lab/missions/public-status.json` only. It does not run git in the dirty checkout. Set `FOUNDRY_MISSION_GITHUB_TOKEN` in the environment. The token is not in the tar.

```bash
cd /workspace/foundry-ops/releases/<sha>
export FOUNDRY_MISSION_LEDGER=/workspace/foundry-ops/missions-runtime/ledger
export FOUNDRY_MISSION_GITHUB_TOKEN='<parent token, not in git>'
node src/missions/github-publish.js
```

The desk reads that one path at the main SHA. The hash detects a corrupt file. It is not authentication. `prev_sequence` cannot show a rolled-back chain. Until that upload exists, production stays `unavailable` and live spend is null.

Live submit stays off unless the parent starts the dedicated signer with `FOUNDRY_MISSION_EXECUTE=yes` outside `bin/start`, and the worker is also started with that variable. `bin/start` removes it. EVM gas stays `NON_XRP`. A lost signer response is not retried.
