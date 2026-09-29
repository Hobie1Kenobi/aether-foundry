# Session — heartbeat archive wiped frontier ids

**When:** 2026-09-29  
**Wipe:** `8f856d1` (`lab: archive W5 heartbeat CE97193B (agent hands)`)  
**Ids restored on main:** `b95cbf7`. This branch does not rewrite `lab/metrics.json`.

## Root cause

The new ledger row is the agent-signer archive (`source: "agent-signer"`, `action: "heartbeat"`, hash `CE97193B6EA982225DD7EDDF09C8A36C5EA7DE35E20F8344B04BC972093BC451`, ledger `21152365`). Replaying `metrics.refresh` and `metrics.recordHeartbeat` on the parent metrics file (`f714838`) keeps `oracle_id`, `last_oracle`, `mpt_issuance_id`, and `domain_id`. The file committed in `8f856d1` matches that refresh document with those four keys omitted, not set to null.

`assertDoc` accepted a metrics object that simply lacked the keys. `writeMetrics` then serialized it, so a partial heartbeat rewrite dropped them. A later `refresh` of that file copies the gap forward as null. Desk Labor MPT and Credential Domain read only `lab/metrics.json` (no live fallback). Oracle still resolved from a live `ledger_entry`.

## Fix

`writeMetrics` copies a previously non-null frontier field from the on-disk file when the incoming document omits it or sets it empty. Clearing one requires `clear` naming that field. The signer heartbeat archive calls `recordHeartbeat` before `refresh`.
