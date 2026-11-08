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

A submit takes an exclusive ledger claim first. A second process gets `NO_RETRY`. If the process dies after the claim is handed to the signer, the hold stays uncertain and is not submitted again. A signer HTTP refusal that returns no blob, and leaves no presign hash, releases that claim. The mission stays blocked and is not retried. An unknown result after a blob exists stays uncertain. The dedicated signer rejects a loopback request that does not match that reserved claim, even with the bearer token. EVM gas stays unauthorized.

Automatic publishing needs `FOUNDRY_MISSION_GITHUB_TOKEN` in `/workspace/foundry-ops/missions-runtime/tokens.env`, mode `0600`. GitHub does not normally restrict a token to one file. This process refuses every path except `lab/missions/public-status.json`; that is an application check, not a token permission. This tree does not contain that token and does not read undocumented credential files. Until the parent adds it, a recurring website update does not run. A one-file git snapshot on main is the sanctioned stand-in. That is not a continuous live feed. When the token exists, a changed snapshot uploads at most once every 15 minutes.

`machines/missions/ensure-up.snippet.sh` is in this release at that path. It is not installed until the parent pastes it into `/workspace/foundry-ops/ensure-up.sh`. It sources `tokens.env` only when that file is mode `0600`, keeps the seed in `account.json`, and restarts the worker and the dedicated signer as separate processes if their pids are dead. `./bin/stop` waits up to 10 seconds for those pids to exit and for `8794` and `8788` to accept a new bind. If some other process still holds the port, stop fails and does not kill it. The snippet does not signal `8787`, `8792`, or `8793`, and it does not add a cron.

## Allowlist

The installed allowlist is the reviewed resource object for `rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs`. This release does not add payees and does not turn that entry into a string that matches every URL. A discovered `payTo` outside that object stays `payee_not_allowlisted`. The worker never writes this file. Class activation already covers the 1 XRP and 5 XRP caps. One reviewed address is not permission for any other seller.

The reserve is the XRPL Labs `open_ledger_fee` plus 1000 drops of headroom, and never above 10000 drops. That ceiling is inside the same 1 XRP and 5 XRP caps. Before a signature the worker quotes the same field again. If the fresh number is above the ceiling, the hold is released with `FEE_CAP` and nothing is signed. If it is within the ceiling, the unused headroom is released and the transaction fee is that fresh number. `median_fee` is not the quote.

A pre-sign `FEE`, `FEE_CAP`, or `FEE_STALE` block can be reopened only by naming that one candidate key, with `FOUNDRY_MISSION_CONFIRM=RETRY-PRE-SIGN-FEE-BLOCK` and the mission token:

```bash
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime \
FOUNDRY_MISSION_LEDGER=/workspace/foundry-ops/missions-runtime/ledger \
FOUNDRY_MISSION_TOKEN=... \
FOUNDRY_MISSION_CONFIRM=RETRY-PRE-SIGN-FEE-BLOCK \
FOUNDRY_MISSION_RETRY_KEY=cand-17-51ec932c8e \
node src/missions/retry-fee.js
```

That command writes one audit line and does not sign. It does not clear any other consumed key. The next tick opens `cand-17-51ec932c8e-fee-retry-2` because `fee-retry-1` already exists. Do not mint a new discovery id. A grant written by the earlier command that named every fee key does not open another successor. A successor that is empty or already signed blocks another grant for that parent. Claims with a hash, signer acceptance, or an uncertain hold are not retried. Do not run that retry while `msn5b5c3223e5e88526` is open. `./bin/start` stays asleep even if `arm.json` is present. `./bin/wake` refuses to spend. `./bin/account` records a new isolated account without releasing the hold. `./bin/execute` is the one-shot purchase and is not part of `ensure-up`. After that generation is used, `./bin/authorize-once` appends one new unused generation. It requires `FOUNDRY_MISSION_AUTHORIZE_TOKEN` from mode-0600 `tokens.env`, the phrase `AUTHORIZE-ONE-MORE-PURCHASE`, and `FOUNDRY_MISSION_AUTHORIZE_NOTE`. The token is not the execute or reconcile token. The worker must already be asleep. `msn5b5c3223e5e88526` stays an uncertain 1747-drop hold and does not block the grant, and it still counts in the 5 XRP day. Any other signed or submitted claim that is not reconciled does block it. A grant is refused while an earlier generation is unused, or when the remaining day or the 1 XRP mission cap cannot cover the 10000-drop maximum fee reserve. The command appends `lease-history.jsonl` and does not rewrite earlier lines, `execute.json`, or the mission ledger. `./bin/execute` then consumes only that generation, still requires a fresh unpaid 402, and refuses an invoice id that was already used. `./bin/publish` refreshes a health snapshot while execute is off. The box supervisor is one flocked `ensure-up` hook from bashrc on a new shell. Paste the mission block before that script's final `exit 0`. A block after `exit 0` does not run. Cron, pm2, and supervisord are absent, and systemd is not usable. That hook is not a five-minute boot service. The 1747-drop hold stays in the cap. The same account sequence is held until the parent chooses a different isolated account. Override does not release it. The retained invoice `1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45` is not a replay. A later purchase needs a new live 402 for `https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96` and payTo `rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs`. Automatic snapshots go to the desk ingest with `FOUNDRY_MISSION_INGEST_SECRET`. No GitHub token is required. No new seller is added. See `machines/missions/ACCEPTANCE.md`.

## Open presign

`msn5b5c3223e5e88526` has presign hash `6022D12A2FBA5C4321FB7A1CED1E10FFC91B75C521F402A725B0518B101A8FEC`. Do not retry it and do not release the 1747-drop hold. `expires_at` `2026-11-06T19:42:16.314Z` is not a release. The mission Payment was signed without `Sequence` or `LastLedgerSequence`. A generated-wallet decode shows an omitted Sequence is not stored as 0. That does not prove why the seller refused, and it does not release this claim. Future signatures require the validated account sequence and a LastLedgerSequence at most 20 ledgers ahead. A clock time does not release a signed claim. A public `tx` read on 2026-11-06 returned `txnNotFound`. That is not a release either. The published snapshot does not contain the seller HTTP status or body. If a local worker log still has that response, keep only the status number and whether the body was a JSON object. Do not send the signed blob again to find out.

`txnNotFound` on a pruned server is not a release. `./bin/reconcile` with no `FOUNDRY_MISSION_RECONCILE_MISSION` exits `PLAN` and releases nothing. That variable is the claim selector.

Report only, no audit phrase and no release:

```bash
FOUNDRY_MISSION_RECONCILE_MISSION=<mission id> \
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime \
./bin/reconcile
```

The JSON fields `release_allowed`, `released`, `reason`, `creation_ledger`, `complete_ledgers`, and `history_covers` are the report. `released` stays false. The command does not write the ledger and does not store a guessed earliest ledger.

Apply the release only when that report has `release_allowed` true. The token stays in the environment. It is not printed and it is not the execute token.

```bash
FOUNDRY_MISSION_RECONCILE_MISSION=<mission id> \
FOUNDRY_MISSION_RECONCILE_PHRASE=AUDIT-RELEASE-PASSED-WINDOW \
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime \
./bin/reconcile
```

`FOUNDRY_MISSION_RECONCILE_TOKEN` must already be set and be at least 32 characters. A release also requires network id 1, a validated head past `LastLedgerSequence`, `txnNotFound` for the signed hash, a validated `CreatedNode` of this account's `AccountRoot`, `actNotFound` on the previous ledger, one account transaction from the covered history start through `LastLedgerSequence` with no pagination marker, and `complete_ledgers` continuous from that creation ledger through `LastLedgerSequence`. A testnet history that starts at ledger 32570 can cover a later creation. Ledger 1 is not required. Sequence and the clock are not a lower bound. `msn5b5c3223e5e88526` has no `LastLedgerSequence` and stays held. Any other gap, recreation, or ledger mismatch stays held.

## Swap a release

Stop only the dedicated pids. The ledger, arm file, and account file stay in `/workspace/foundry-ops/missions-runtime`, so pending and uncertain holds are kept.

```bash
OLD=/workspace/foundry-ops/releases/42b66aabb9055a8bb691889a77119f2310fe2cb7
NEW=/workspace/foundry-ops/releases/<newsha>
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime "$OLD/bin/stop"
install -d "$NEW"
tar -xf foundry-missions-<newsha>.tar -C "$NEW"
cd "$NEW"
npm ci --omit=dev
FOUNDRY_MISSION_HOME=/workspace/foundry-ops/missions-runtime "$NEW/bin/start"
```

Do this on the box when you choose. A cloud run must not replace the directory that is already armed.
