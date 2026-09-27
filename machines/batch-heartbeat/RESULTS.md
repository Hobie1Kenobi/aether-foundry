# RESULTS — Batch Heartbeat

**spec only — no trial this session** (2026-09-27-5 Foundry Night)

## Blocking answer

| Question | Answer |
|----------|--------|
| Is atomic Batch enabled on `s.altnet.rippletest.net`? | **false** |

## Feature probe (live)

| Name | enabled | supported | Notes |
|------|---------|-----------|-------|
| BatchV1_1 | false | true | atomic Batch |
| fixBatchV1_2 | false | true | atomic Batch fix |
| TicketBatch | true | true | **not** atomic Batch |

Server: rippled **3.4.1**, ledger ~21094528, CT 2026-09-27 ~10:13 AM.

## Trial

| Action | Result |
|--------|--------|
| Batch probe tx | **not sent** (Director: if disabled, write feature into RESULTS and no trial) |
| Engine code | n/a — would expect `temDISABLED` / unsupported TransactionType if forced |

Port-forward: re-probe `feature` at session start the day Batch flips; then at most one Batch heartbeat.
