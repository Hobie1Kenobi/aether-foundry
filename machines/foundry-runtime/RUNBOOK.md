# RUNBOOK — Foundry Box daemon

Testnet only. The desk does not sign. Seeds stay outside the repo.

## Policy

```bash
npm run runtime:policy
```

This is `node --test src/runtime/policy.test.js`. It must refuse CI, mainnet, W3→W3, labeled grants, remint while open, amounts at or above 50 XRP, stale director state, and secret key names.

## Dry-run

```bash
npm run runtime:dry
```

Equivalent to `node src/runtime/daemon.js --dry-run --once`. Exit `0` when `lab/director-state.json` is inside 36 hours and wake is quiet. Exit `2` when wake alerts (including a stale file). Exit `1` on a fatal schema or RPC error.

The print is one JSON document. `mode` is `dry-run`, `signed` is false, `key_loaded` is false. A due heartbeat includes an unsigned `Payment`. An open Walk-In includes `walk_in_remint.code` `OFFER_OPEN` and `tx` null. No seed file is opened.

Do not remint from this command. Do not copy a refused plan into a signer.

## Live (Foundry box)

Set `FOUNDRY_DAEMON_LIVE` to `yes`. Provide RegularKey seeds by env name only:

- `W2_REGULAR_SEED`
- `W3_REGULAR_SEED`
- `W5_REGULAR_SEED`
- `W6_REGULAR_SEED`

```bash
npm run runtime:live
npm run runtime:watch
```

`runtime:live` is one pass. `runtime:watch` loops every 60 seconds and subscribes to W2, W3, W5, and W6 on the Testnet websocket. Both throw `CI` under Actions. Both refuse to start unless `FOUNDRY_DAEMON_LIVE=yes`.

Live remint still polls W2. If a sell offer exists, it does not mint. Live snapshot, when the state file is older than 36 hours, is the existing `director:snapshot` writer. It must keep the three `next_actions`.

Ledger lines are appended only when the result is `tesSUCCESS` and the hash is 64 hex characters. Do not type a hash into `RESULTS.md`.

## If the state file is stale

Dry-run will alert and will not invent `validated_ledger_index`. On the Foundry box, refresh with the read-only snapshot before a live pass:

```bash
npm run director:snapshot
npm run director:wake -- --check
```

Those two commands do not sign.

## Director clock

GitHub Actions `.github/workflows/director-clock.yml` runs the same snapshot, then `director:wake --check`. A wake exit 2 fails that job. It does not remint and it does not run `runtime:live`.

Optional crontab on the Foundry box (path is the checkout; no seed is required):

```bash
*/30 * * * * cd /path/aether-foundry && npm run director:snapshot && npm run director:wake -- --check --routine morning-health
```

## Heartbeat

W5 pays W3 one drop. SourceTag `202609280`. Memos are `purpose=aether-heartbeat`, `experiment=foundry-runtime`, and `ledger` set to the validated index already in `lab/director-state.json`. Destination may be W6. The cap is 4 heartbeats on a UTC day, with the rolling 24h backstop still in force, and at least 6 hours between them.

```bash
npm run heartbeat:dry
```

That is `node src/runtime/actions/heartbeat.js --dry-run`. It prints one unsigned `Payment` and does not open `W5_REGULAR_SEED`. Exit `0` when the plan is due. Exit `2` when the rate limit or a stale director file refuses it. There is no hash in that print.

Live, Foundry box only:

```bash
FOUNDRY_DAEMON_LIVE=yes npm run heartbeat:live
```

The env name is `W5_REGULAR_SEED`. GitHub Actions throws `CI` before that file is read. A `tesSUCCESS` hash is appended to `lab/ledger-log.jsonl` as `action` `heartbeat` and copied into `lab/metrics.json` `last_heartbeat`. Do not type a hash into either file. The skeleton in git has `last_heartbeat.hash` null. Counts in that skeleton are the integers already published in `market/pnl.md`.

`GET /api/status` on the desk reads that public JSON (or `market/pnl.md` if the metrics file is not on `main` yet). It does not sign. `last_heartbeat` in `lab/metrics.json` stays an object (`hash`, `ledger_index`, `ts`) because `/api/status` reads that object. `last_heartbeat_hash` repeats the same hash for the file shape.

## Daily flywheel (Foundry box crontab)

This clock is not a GitHub Actions job. Actions keeps `director-clock.yml` on snapshot and wake. It does not run `runtime:live`, `grants:pay`, or `x402:outbound`.

On the Foundry box, America/Chicago:

```bash
CRON_TZ=America/Chicago
15 10 * * * cd /path/aether-foundry && npm run grants:scan && npm run grants:pay -- --dry-run
45 10 * * * cd /path/aether-foundry && npm run x402:outbound -- --dry-run
```

Both lines are dry-run. They exit 0 without a secrets file. `x402:outbound --dry-run` with no `--url` prints an unsigned plan and does not fetch a 402. A live pay still needs a foreign URL.

Live signing stays on the daemon, with `FOUNDRY_DAEMON_LIVE=yes`:

- one `grant_paid` per UTC day, from W6, at most `1000000` drops
- one `x402_outbound` per UTC day, from W3, at most `500000` drops (0.5 XRP)
- `payTo` is not W3 and is not an address in `WALLETS`
- `npm run grants:pay` without `--dry-run` refuses CI and a second grant on the same UTC day before it reads `W6_REGULAR_SEED`
- `npm run x402:outbound` without `--dry-run` refuses CI, a `payTo` of W3, an amount above `500000` drops, and a second outbound on the same UTC day

`npm run grants:pay -- --record` and `npm run x402:outbound -- --record` append the public ledger only after `tesSUCCESS`, bump `market/pnl.md`, and refresh `lab/metrics.json` from that ledger. Hashes in the metrics file are copied from `lab/ledger-log.jsonl`. A missing heartbeat row leaves `last_heartbeat.hash` null.

## Agent signer

The Foundry box may run a localhost signer so agents can POST allowlisted transactions. GitHub Actions, the desk, and Vercel do not call it. It binds `127.0.0.1` only (override with `FOUNDRY_SIGNER_BIND`, which must stay loopback). Default port is `8787` (`FOUNDRY_SIGNER_PORT`).

```bash
npm run signer:dry
FOUNDRY_AGENT_SIGN=yes FOUNDRY_SIGNER_TOKEN='long-random' npm run signer
```

`signer:dry` is `node src/runtime/signer.js --self-test-dry`. It prints an unsigned autofill and does not read a key. `npm run signer` refuses `CI`, `CI=1`, and `GITHUB_ACTIONS`, and it refuses to start unless `FOUNDRY_AGENT_SIGN=yes` and `FOUNDRY_SIGNER_TOKEN` is set. The token is not a seed. There is no `W0_SEED` in this process.

`POST /sign` and `POST /dry-run` require `Authorization: Bearer $FOUNDRY_SIGNER_TOKEN`. `GET /health` returns `{ network_id, wallets_ready, signing }` and does not return key material. Every submit checks the RPC network id (`1` on XRPL Testnet, `21338` on Xahau Testnet for W7). W0 is refused. `Batch` is refused while `watched.batch.atomic_enabled` is false. `EscrowFinish` and `EscrowCancel` of the Unix-epoch BUYER escrow are refused. A `tesSUCCESS` hash is appended to `lab/ledger-log.jsonl`. Do not invent one.

RegularKey env names are `W1_REGULAR_SEED` through `W6_REGULAR_SEED`. W7 uses `W7_SEED` and only on Xahau Testnet. Confirm each classic address against `machines/governance-board/activated.json` before the first live POST. The signer does that check itself and refuses a mismatch.

Leave Walk-In alone while a sell offer is open. A W2 mint of taxon `20260927` or a 10 XRP sell offer is refused unless `watched.walk_in_offer` is `sold_out` with `offer_count` 0.

### Restart on reboot

`machines/foundry-runtime/foundry-signer.service` and `foundry-daemon.service` are unit stubs. Edit `WorkingDirectory`, `ExecStart` (the box `npm`), and `EnvironmentFile` before installing. `Restart=always` and `WantedBy=multi-user.target` bring both processes back after a reboot.

```bash
sudo cp machines/foundry-runtime/foundry-signer.service /etc/systemd/system/
sudo cp machines/foundry-runtime/foundry-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now foundry-signer.service foundry-daemon.service
systemctl is-enabled foundry-signer.service foundry-daemon.service
curl -sS http://127.0.0.1:8787/health
```

`foundry-daemon.service` runs `npm run runtime:watch`, which still requires `FOUNDRY_DAEMON_LIVE=yes` in the secrets file. If `/health` is down, agents are spectators again.

MCP on the box may POST `/sign` only when `MCP_SIGN=on`, `FOUNDRY_AGENT_SIGN=yes`, and `/health` is HTTP 200 with `signing: true`. That MCP process is not deployed on Vercel. `web/app/api/mcp/route.ts` does not gain `sign_tx`.

## What not to run

- `npm run runtime:live` in GitHub Actions.
- `npm run remint:walk-in` while `watched.walk_in_offer.status` is `open`.
- Any `Batch` transaction while `watched.batch.atomic_enabled` is false.
- Escrow finish or cancel on the Unix-epoch BUYER escrow.
- A grant to STRANGER, BUYER, AMM, or W0–W6.
- A second grant or a second outbound on the same UTC day.
- An outbound `payTo` of W3, or an outbound above `500000` drops.
- `npm run runtime:live` or `npm run grants:pay` from GitHub Actions.
