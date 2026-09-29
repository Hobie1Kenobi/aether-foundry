# Day 7 — Band B/C

**Clock:** Chicago `2026-09-28T20:17` CDT (UTC already 2026-09-29).  
**Session:** `2026-09-28-day7-band-bc`  
**Networks read:** XRPL Testnet id 1, XRPL Devnet id 2. Both rippled **3.4.1**.  
**Not submitted:** Batch, delegate grant, Sponsor, vault, loan, confidential transfer, XChain bridge.

## Protocol

`npm run frontier:probe` rewrote `lab/frontier/amendments.json` at `2026-09-28T20:17:30-05:00`. Network id 1. Band A still enabled. Band B: `BatchV1_1` false, `fixBatchV1_2` false, `TicketBatch` true, `PermissionDelegationV1_1` false. Band C all false. Hashes match the Day-1 map. `TicketBatch` is still not atomic Batch.

`npm run frontier:probe-devnet` wrote `lab/frontier/amendments-devnet.json` at `2026-09-28T20:17:31-05:00`. RPC `https://s.devnet.rippletest.net:51234`. Network id **2**. Every watched row, including Band B and Band C, came back `enabled: true` with the same hashes. A missing name would have aborted the file. Mainnet hosts and any id other than 2 are refused before a write.

Devnet having the flags does not move Testnet machines. No Batch on either network.

## What shipped this week (Testnet)

| Pack | Ledger fact |
|------|-------------|
| F1 native price oracle | `OracleSet` `B11B0B87A7C40AFA98540D2F40FF234384466729F90E259E60162714DC4DDE85`. `oracle_id` `7CD1AB908C3A8D2E3C426E0D3083F4DD9A8A3A753AA60EB73682AA11A06DFA4E`. Ledger `21129718`. |
| F2 labor MPT | Issuance `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED`. Create `1DDA337DD81833BEE768DED7E54889A4F92D5DC5958F75760417801909C02BCB`. W2 authorized. |
| F3 TokenEscrow | Finish `7536CB47DD446BF5E09ABC1A65CB0633FC556EB83E1C261257F07644A7815DA1`. Cancel `FC7CB7C6D6CA5DA7EBCEE2C48CAECDC6599128DDD5258C167D7305BE50A58797`. Ripple Epoch locks. |
| F4 credential domain shop | `domain_id` `6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4`. Uncredentialed `tecNO_PERMISSION` `A1046BD20845D29E782FB9A83C82434CF87071707F9263DE06D908082E0B4A8E`. Credentialed take `A3A60DF94E038617547764742E130A63347139CD1FBC23E03AD91A2C76054EEE`. Walk-In untouched. |
| F11 x402 citizen | Desk accepts self-verify and, when configured, `https://xrpl-facilitator-testnet.t54.ai` (`xrpl:1` only). Mainnet facilitator host refused. `GET /supported` on the testnet host returned 200 for `xrpl:1`. No new outbound hash. `candidates.json` urls empty. No `/settle`. |

## What stayed disabled

On Testnet: atomic Batch, permission delegation, SingleAssetVault, LendingProtocol, LendingProtocolV1_1, Sponsor, ConfidentialTransfer, DynamicMPT, XChainBridge.

`machines/batch-heartbeat/` stays spec-only. Delegation stays spec-only. F8, F9, and F10 are `lab/frontier/port-forward.md` only. `D0`–`D3` are blank lines in `corp/wallets.md`. The Devnet faucet host was not POSTed.

## next_actions

1. Testnet re-probe 2026-09-28T20:17:30-05:00 (rippled 3.4.1, id 1): BatchV1_1, fixBatchV1_2, and PermissionDelegationV1_1 are still disabled. batch-heartbeat and delegation stay spec-only. Do not submit Batch.
2. Devnet map lab/frontier/amendments-devnet.json is id 2, same build, Band C enabled. D0-D3 in corp/wallets.md are blank. Fund only from the Devnet faucet on the Foundry box. No Vault, Loan, Sponsor, or ConfidentialTransfer transaction until then.
3. F8/F9/F10 notes are lab/frontier/port-forward.md. Do not mix Devnet into Testnet NAV. Heartbeat live stays on the box. Walk-In remint only after sold_out.

Director continuation card matches those three strings. `last_session_id` is `2026-09-28-day7-band-bc`. Ledger indexes, balances, and `updated_at` in `lab/director-state.json` were not rewritten: this session did not snapshot.
