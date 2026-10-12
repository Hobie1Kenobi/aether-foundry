# THREAT — Batch Heartbeat (Adversary sign-off)

## Gate (Adversary)

**Adversary claim:** a generic `Batch`, a mainnet `Batch`, or three separate transactions can stand in for this machine.

**Check:** 2026-10-12 XRPL Labs, network id 1, rippled 3.4.1: `BatchV1_1` and `fixBatchV1_2` are enabled. `TicketBatch` is also enabled and is not the gate. The signer re-reads `feature` and refuses a network id other than 1. The daemon still refuses `TransactionType` `Batch`. The agent signer accepts `Batch` only as intent `batch_heartbeat`, all-or-nothing, three named inners, amount caps, one per UTC day. A sequential accept, deposit, and DID is not this machine. Outer `tesSUCCESS` is not enough: the script requires `tesSUCCESS` on every inner hash.

## Inner-tx account mismatch

W0 does not appear as an inner account and does not appear in `BatchSigners`. The DID account is W1, which the signer already holds. Loading `W0_SEED` or a board seed to build a `BatchSigner` is refused.

## DID document spoof

DID URI can point anywhere. Mitigation: URI stays on `raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/...`; heartbeat fragment must match ledger index in RESULTS.

## Probe grief

The director probe does not submit. `batch_enabled` holds the wake only when the gate is on and `src/batch/heartbeat.js` is missing. The heartbeat command refuses CI. A failed inner is not papered over by an outer `tesSUCCESS`.

## Seed exposure

Seeds only in secrets `.env`. Never print or commit.
