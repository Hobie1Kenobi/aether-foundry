# Machine: foundry-runtime — RESULTS

**Network:** XRPL Testnet  
**Session:** `2026-09-28-runtime`  
**Status:** spec. No daemon hash.

`npm run runtime:dry` prints unsigned JSON. It is not a submission. This file records the allowlist as a specification. Null is not a ledger hash. Do not add one until a Foundry box sees `tesSUCCESS`.

Director state used for the dry-run plan was `lab/director-state.json` `updated_at` `2026-09-27T17:36:45-05:00`, source `director:snapshot`, XRPL validated ledger `21102567`, Xahau validated ledger `12696465`. Those indexes were already in the file. This session did not snapshot and did not replace them. The continuation card was rewritten in git. `next_actions` is three strings. `last_session_id` is `2026-09-28-runtime`.

Walk-In at that snapshot: `status` `open`, `offer_count` `1`, offer `CEAC38D14EBB2B544E59D78084ECAE1D52486BA29C53D248717CD42DB159654F`. Remint is refused. No remint hash.

On 2026-09-28, `npm run runtime:dry` exited 0 with no secrets file. The JSON said `signed` false and `key_loaded` false. It included an unsigned heartbeat `Payment` of `1` drop from W5 to W3, and an unsigned grant `Payment` of `1000000` drops from W6 to `rLDbAi71mciJwCDKyTn6dohD3ypDsMLRwm` (`aeth_counterparty`, the existing scan, not a new counterparty). Neither was submitted. Outbound was `NOT_NAMED`. Snapshot was `FRESH` and did not write.

## Allowlist (SPEC)

| Action | Account | Address | Key env | Max | Signs |
|---|---|---|---|---|---|
| `walk_in_remint` | W2 | `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` | `W2_REGULAR_SEED` | offer `10000000` drops | only when `sold_out` and not CI |
| `grant_pay` | W6 | `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf` | `W6_REGULAR_SEED` | `1000000` drops | only for a non-labeled candidate |
| `heartbeat` | W5 | `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` | `W5_REGULAR_SEED` | default `1`, max `1000` drops | W3 or W6 only |
| `x402_outbound` | W3 | `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` | `W3_REGULAR_SEED` | `500000` drops | foreign `payTo`, 402 required |
| `director_snapshot` | none | none | none | `0` | no |

Refused network ids: `0`, `21337`. Refused hosts: `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, `xahau.network`.

## Refusals exercised here

| Check | Result |
|---|---|
| CI / `GITHUB_ACTIONS` / `CI=1` on `--live` | throw `CI` |
| Mainnet id and host | throw `MAINNET` |
| W3→W3 | throw `CIRCULAR` |
| STRANGER grant | throw `LABELED` |
| Remint while open | throw `OFFER_OPEN` |
| ≥ 50 XRP | throw `FIFTY_XRP` |
| Stale state | throw `STALE`, dry-run exit 2 |
| Secret key name | throw `SCHEMA` |

## Hashes

| Field | Value |
|---|---|
| Remint hash | none |
| Grant hash | none from this daemon |
| Heartbeat hash | none |
| Outbound hash | none from this daemon |
| Snapshot hash | none (snapshot does not sign) |

The grants flywheel already has its own `tesSUCCESS` in `machines/grants-flywheel/RESULTS.md`. That hash is not a product of this daemon. It is not copied here as a runtime result.

No seeds in this file.

## Card

`next_actions` after this session:

1. Runtime dry-run is the gate: `npm run runtime:dry` with no secrets. Remint stays refused while `watched.walk_in_offer.status` is open.
2. Next unsigned work is the director clock: `npm run director:snapshot` then `npm run director:wake -- --check`. Actions must not run `runtime:live`.
3. Live RegularKey signing stays on the Foundry box with `FOUNDRY_DAEMON_LIVE=yes`. Caps remain grant `1000000` drops, heartbeat `1` drop, outbound `500000` drops. No Batch while `watched.batch.atomic_enabled` is false.

The company is still session-operated.

## Director clock

Session `2026-09-28-director-clock`. No new snapshot. XRPL validated ledger stays `21102567`. Xahau validated ledger stays `12696465`. No signing hash. The unattended path is `.github/workflows/director-clock.yml`: `director:snapshot`, then `director:wake --check`. Wake exit 2 fails the job. The job does not remint.

## Desk status and heartbeat

Session `2026-09-28-desk-status`. No new snapshot and no submitted heartbeat. `lab/metrics.json` keeps `last_heartbeat.hash` null. `npm run heartbeat:dry` prints an unsigned W5→W3 `Payment` of 1 drop. That print is not a hash. `GET /api/status` is seedless. Live `heartbeat:live` stays on the Foundry box.

## Daily flywheel

Session `2026-09-28-flywheel`. No new snapshot. No new payment. `lab/metrics.json` `last_grant_hash` and `last_outbound_hash` are copied from `grant_paid` and `x402_outbound` rows already in `lab/ledger-log.jsonl`. `last_heartbeat_hash` stays null because that file has no heartbeat row. `inbound_counterparties` counts classic buyers and grant destinations outside `WALLETS`. The Foundry-box crontab is dry-run only (10:15 grants, 10:45 outbound, America/Chicago). Actions does not run it.
