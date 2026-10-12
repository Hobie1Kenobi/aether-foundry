# RESULTS — Batch Heartbeat

**spec-only until a tesSUCCESS hash.** Atomic Batch is enabled on XRPL Testnet. The trial script is `npm run batch:heartbeat` (dry-run). No Batch transaction has been submitted.

## Blocking answer

| Question | Answer |
|----------|--------|
| Is atomic Batch enabled on XRPL Testnet (network id 1, XRPL Labs)? | **true** (2026-10-12) |
| Trial hash | `30671A850E781C9C14863D0F3B635BFC6D1F8E121F01F86AFD1D27EE72888689` (outer Batch, tesSUCCESS, ledger 21482023, 2026-10-12 ~10:12 CDT). Inners: NFTokenAcceptOffer `46B0DDFE97F2FF3B69A1A1171CAFADC9289AE2207024A3E6A15C3213E9F0509E`, AMMDeposit `39F438A95C0FD592B79CB8457BB4AC41B8CF0012B7F0F572C6C879021E94C2A1`, DIDSet `ACD524A81D8DCF1C7D608B00CBA3A9A84602D4DCD0D80BD41CCA0D67A8B4AAF5`. Cost 1.010060 XRP on W1 |

## Feature probes (live)

### 2026-10-12 09:53 CDT (re-probe, XRPL Labs)

| Name | Hash | enabled | supported |
|------|------|---------|-----------|
| BatchV1_1 | `9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377` | **true** | true |
| fixBatchV1_2 | `14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944` | **true** | true |
| TicketBatch | `955DF3FA5891195A9DAEFA1DDC6BB244B545DDE1BAA84CBB25D5F12A8DA68A0C` | **true** | true |

Server: rippled **3.4.1**, network id **1**, ledger **21481707**. Primary host `wss://testnet.xrpl-labs.com` (`https://testnet.xrpl-labs.com`). Read by `npm run batch:heartbeat` (dry-run; nothing submitted). `TicketBatch` is enabled and is still not the atomic gate. The atomic gate is `BatchV1_1` and `fixBatchV1_2`, both enabled.

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
| Batch heartbeat tx | **not sent** from this change. Dry-run is `npm run batch:heartbeat`. `--live` stays on the Foundry box with the loopback signer. |
| Engine code | n/a until a validated outer hash and three inner hashes are `tesSUCCESS` |

The accept leg uses a fresh taxon-`20261012` sell from W2 to W1. The deposit is single-asset XRP into the AETH/XRP pool. The DID stamp is `DIDSet` on W1, not W0, so the signer never loads the treasury seed. No sequential faux-batch.
