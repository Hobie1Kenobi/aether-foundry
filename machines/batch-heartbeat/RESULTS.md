# RESULTS — Batch Heartbeat

**spec only — no product trial** (atomic Batch still disabled)

## Blocking answer

| Question | Answer |
|----------|--------|
| Is atomic Batch enabled on `s.altnet.rippletest.net`? | **false** |

## Feature probes (live)

### 2026-09-27 ~10:13 AM CT (session-5)

| Name | enabled | supported | Notes |
|------|---------|-----------|-------|
| BatchV1_1 | false | true | atomic Batch |
| fixBatchV1_2 | false | true | atomic Batch fix |
| TicketBatch | true | true | **not** atomic Batch |

Server: rippled **3.4.1**, ledger ~21094528.

### 2026-09-27 ~11:52 AM CT (re-probe after LP Badge)

| Name | Hash (abbrev) | enabled | supported |
|------|---------------|---------|-----------|
| BatchV1_1 | 9F287AED… | **false** | true |
| fixBatchV1_2 | 14A2B45E… | **false** | true |
| TicketBatch | 955DF3FA… | true | true |

Server: rippled **3.4.1**, `server_state=full`, ledger **21096312**, HTTP JSON-RPC `https://s.altnet.rippletest.net:51234`.


### 2026-09-28 ~1:08 PM CT (Foundry Batch probe routine — first scheduled)

| Name | Hash (abbrev) | enabled | supported |
|------|---------------|---------|-----------|
| BatchV1_1 | 9F287AED… | **false** | true |
| fixBatchV1_2 | 14A2B45E… | **false** | true |
| TicketBatch | 955DF3FA… | true | true |

Server: rippled **3.4.1**, `server_state=full`, ledger **21123617**, HTTP JSON-RPC `https://s.altnet.rippletest.net:51234`. Atomic Batch still gated (TicketBatch alone does not count).

### 2026-09-28 20:17 CDT (Day 7 `npm run frontier:probe`)

| Name | enabled | supported |
|------|---------|-----------|
| BatchV1_1 | **false** | true |
| fixBatchV1_2 | **false** | true |
| TicketBatch | true | true |
| PermissionDelegationV1_1 | **false** | true |

Server: rippled **3.4.1**, network id **1**, HTTP `https://s.altnet.rippletest.net:51234`. Map: `lab/frontier/amendments.json` `probed_at` `2026-09-28T20:17:30-05:00`. Hashes unchanged from the Day-1 map.

The same minute, Devnet network id **2** (`lab/frontier/amendments-devnet.json`, `probed_at` `2026-09-28T20:17:31-05:00`) reported `BatchV1_1`, `fixBatchV1_2`, and `PermissionDelegationV1_1` **enabled**. This pack does not move there. No `Batch` transaction was submitted on either network. Permission delegation stays spec-only: no delegate grant.

## Trial

| Action | Result |
|--------|--------|
| Batch heartbeat tx | **not sent** (RUNBOOK Step 0: stop when `enabled:false`) |
| Engine code | n/a |

Port-forward: re-probe `feature` each session until `BatchV1_1` / `fixBatchV1_2` flip; then at most one Batch heartbeat (AcceptOffer + AMMDeposit + DIDUpdate). No sequential faux-batch.
