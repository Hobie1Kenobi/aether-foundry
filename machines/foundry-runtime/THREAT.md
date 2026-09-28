# THREAT — Foundry Box daemon

Adversary checks from the runtime activation list. This pack is Workstream 1. Later workstreams are named where the check is not implemented here.

## Seed in a test fixture, workflow log, or `/api/status`

**Claim:** a test, an Actions log, or the public desk JSON contains a family seed or a `seed` / `private_key` field.

**Check:** `src/runtime/policy.test.js` rejects object keys that match the director secret-key rule, including `seed`, `private_key`, and `W2_REGULAR_SEED`. A seed-shaped value is rejected by the same schema helper the director uses. The dry-run spawn env does not carry a seed, and the test fails if the printer emits an `sEd…` string. No fixture in `src/runtime/` holds a seed. This PR does not add `web/app/api/status`. The desk still has no `Wallet.sign`. `.github/workflows/walk-in-remint-watch.yml` does not print env and does not call `runtime:live`.

## Actions job that runs `runtime:live`

**Claim:** GitHub Actions starts the signer.

**Check:** `runtime:live` is `node src/runtime/daemon.js --live --once`. `runtime:watch` is `node src/runtime/daemon.js --live`. Both call `assertLiveGate`, which throws code `CI` when `CI=true`, `CI=1`, or `GITHUB_ACTIONS=true`, before a seed file is opened. The Walk-In workflow file does not contain `runtime:live` or `runtime:watch`. It is still detect-only. This PR does not add a director-clock workflow.

## Daemon treating STRANGER as inbound

**Claim:** STRANGER (`rh4c6qMMyafccZrPFCPCN742BNMXfjKYss`) is paid as a grant counterparty or treated as foreign demand.

**Check:** grant destinations go through `web/lib/xrpl-public.ts` `WALLETS` via `foundryIndex`. STRANGER is in that object. `assertGrant` throws `LABELED`. The same map blocks BUYER, AMM, and W0–W6. A labeled address is not an inbound counterparty.

## Daemon reminting while `offer_count` ≥ 1

**Claim:** the box mints a second Walk-In while a sell offer is still open.

**Check:** `assertRemint` throws `OFFER_OPEN` unless `status` is `sold_out` and `offer_count` is `0`. Status `open` is refused. `sold_out` with `offer_count` ≥ 1 is refused. Live `execute` polls `account_objects` and refuses when any sell offer is returned. The committed director state at this session has `status` `open` and `offer_count` `1`. Dry-run leaves `tx` null for remint. No remint hash is written.

## Outbound paying W3

**Claim:** W3 pays itself, or pays any Foundry anchor.

**Check:** `assertOutbound` throws `CIRCULAR` when `payTo` is W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`. Other `WALLETS` addresses throw through `assertForeignPayTo`. The cap is `500000` drops. A missing 402 throws `MISSING_402` before a seed read. Mainnet `xrpl:0` throws `MAINNET`.

## Heartbeat unbounded loop draining W5

**Claim:** `runtime:watch` emits a 1-drop payment every minute until W5 is empty.

**Check:** default amount is `1` drop and the hard max is `1000`. A fifth heartbeat inside 24 hours throws `RATE`. A second heartbeat inside 6 hours throws `RATE`. Destination must be W3 or W6. Amounts at or above 50 XRP throw `FIFTY_XRP`. The watch loop still runs the same plan function on every tick. Dry-run never signs, so a tight loop cannot spend.

## Snapshot overwriting `next_actions`

**Claim:** a refresh replaces the continuation card.

**Check:** `director_snapshot` has `signs: false`, `key_env: null`, and `tx: null`. Dry-run sets `write: false` and does not call `snapshot.run`. The live writer is `src/director/snapshot.js`, which merges the previous `next_actions`, `blockers`, and `last_session_id`. `actions/snapshot.js` reads the file back and throws `PRESERVE` if those three fields changed. This session edited the card in git by hand. It did not run a snapshot, and it did not change `validated_ledger_index`.

## MCP accepting `seed` in JSON-RPC params

**Claim:** an agent posts a seed into a tool call and the runtime stores it.

**Check:** this PR does not start the MCP server. The allowlist schema already refuses a `seed` key and a seed-shaped value, so a later tool cannot park a secret inside `allowlist.json` without failing `loadAllowlist`. No MCP response fixture is added here.

## Batch because the clock ran on a Monday

**Claim:** a Monday cron submits `Batch` while `atomic_enabled` is false.

**Check:** `Batch` is not an allowlisted action. `assertSigningTx` throws `BATCH` for `TransactionType` `Batch` whether or not the weekday is Monday, including when `watched.batch.atomic_enabled` is false. `EscrowFinish` and `EscrowCancel` throw `BANNED`. The daemon does not read the Unix-epoch BUYER escrow.
