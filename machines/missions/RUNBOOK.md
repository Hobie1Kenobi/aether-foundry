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

`npm ci` installs locked `xrpl@5.3.0` from the public npm registry. Node must be `>=20.19`. `./bin/start` is off until `./bin/arm` succeeds. It strips W0–W6 seed variables. `./bin/stop` signals only its own pid files.

`GET http://127.0.0.1:8787/health` with `signing: true` is the existing W1–W6 signer. That body keeps `mission_spend: false`. `./bin/health` reads `127.0.0.1:8794` and, when the signer is up, `127.0.0.1:8788`. After arming, those bodies set `mission_signer_armed: true` and `signing_disabled: false`. Before arming, `signing_disabled` is true. `ordinary_signing` stays false on both mission ports.

Create the account on the box. The client connects to `wss://testnet.xrpl-labs.com`, requires network id 1, and only then uses the SDK faucet host `faucet.altnet.rippletest.net`. Stdout is the address. The seed stays in the `0600` file.

```bash
cd /workspace/foundry-ops/releases/<sha>
FOUNDRY_MISSION_WALLET_TOOL=yes FOUNDRY_MISSION_FAUCET=yes \
  node src/missions/wallet-tool.js --out /workspace/foundry-ops/missions-runtime/account.json
FOUNDRY_MISSION_TOKEN='<box token>' FOUNDRY_MISSION_CONFIRM='ACTIVATE-XRPL1-MISSION-SPEND' \
  FOUNDRY_MISSION_SIGNER_TOKEN='<signer token>' ./bin/arm
./bin/stop
./bin/start
./bin/health
```

`./bin/arm` records the class and the authorized caps, 1000000 and 5000000 drops. It refuses a higher cap. `./bin/start` then loads the seed only from `account.json` inside the signer process and sets execute. A `{ "asleep": true }` file at `/workspace/foundry-ops/missions-runtime/worker.json` stops ticks without clearing the arm file.

Discovery is `/workspace/foundry-ops/missions-runtime/discovery.json`. A candidate counts only as an x402 version 2 exact `xrpl:1` XRP accept with `payTo`, `amount`, a resource URL, `observed_at`, and `maxTimeoutSeconds`. The network fee is the XRPL Labs `open_ledger_fee`, not a merchant field. `payTo` does not widen the allowlist. A resource that cannot take a `PAYMENT-SIGNATURE` proof is blocked in public and is not a raw Payment. `complete` is set only after that proof returns HTTP 200 and the payload validates. One item per tick. Default interval 60 seconds, floor 15 seconds.

A submit takes an exclusive ledger claim first. A second process gets `NO_RETRY`. If the process dies after the claim is handed to the signer, the hold stays uncertain and is not submitted again. The dedicated signer rejects a loopback request that does not match that reserved claim, even with the bearer token. EVM gas stays unauthorized.

Automatic publishing needs `FOUNDRY_MISSION_GITHUB_TOKEN` in `/workspace/foundry-ops/missions-runtime/tokens.env`, mode `0600`, with permission to write only `lab/missions/public-status.json`. This tree does not contain that token and does not read undocumented credential files. Until the parent adds it, a recurring website update does not run. A one-file git snapshot on main is the sanctioned stand-in. That is not a continuous live feed. When the token exists, a changed snapshot uploads at most once every 15 minutes.

`machines/missions/ensure-up.snippet.sh` is not installed. The parent may paste it into `/workspace/foundry-ops/ensure-up.sh`. It sources `tokens.env` only when that file is mode `0600`, keeps the seed in `account.json`, and restarts the worker and the dedicated signer as separate processes if their pids are dead. It does not signal `8787`, `8792`, or `8793`, and it does not add a cron.

## Swap a release

Stop only the dedicated pids. The ledger, arm file, and account file stay in `/workspace/foundry-ops/missions-runtime`, so pending and uncertain holds are kept.

```bash
OLD=/workspace/foundry-ops/releases/9e11391ed52d78261a7188881803ce0bad3b2bd0
NEW=/workspace/foundry-ops/releases/<newsha>
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime "$OLD/bin/stop"
install -d "$NEW"
tar -xf foundry-missions-<newsha>.tar -C "$NEW"
cd "$NEW"
npm ci --omit=dev
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime "$NEW/bin/start"
```

Do this on the box when you choose. A cloud run must not replace the directory that is already armed.
