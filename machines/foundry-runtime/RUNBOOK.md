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

## What not to run

- `npm run runtime:live` in GitHub Actions.
- `npm run remint:walk-in` while `watched.walk_in_offer.status` is `open`.
- Any `Batch` transaction while `watched.batch.atomic_enabled` is false.
- Escrow finish or cancel on the Unix-epoch BUYER escrow.
- A grant to STRANGER, BUYER, AMM, or W0–W6.
