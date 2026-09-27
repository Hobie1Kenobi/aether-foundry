# THREAT — Batch Heartbeat (Adversary sign-off)

## Why v0 is amendment-gated (Adversary)

**Adversary claim:** On this server, submitting `TransactionType: Batch` will not produce the atomic heartbeat. Observed state:

- `BatchV1_1.enabled === false`
- `fixBatchV1_2.enabled === false`
- `TicketBatch.enabled === true` (unrelated: ticket sequence batching)

Any “heartbeat” executed as three separate transactions is **not** this machine — it is a marketing lie. Operator could DIDUpdate after a failed AMMDeposit and claim success.

**Therefore v0 is amendment-gated:** RESULTS must show `feature` probe. Until `BatchV1_*` (or successor name) flips `enabled:true`, the only honest output is **tec/feature blocked — no trial**.

## Inner-tx account mismatch

Batch multi-account rules (when live) may reject mixed W0/W1/W2 inners. Mitigation: design fee-payer + Ticket pre-auth; re-read amendment docs on enable day.

## DID document spoof

DID URI can point anywhere. Mitigation: URI stays on `raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/...`; heartbeat fragment must match ledger index in RESULTS.

## Probe grief

Director allows **at most one** Batch probe if enabled. We did **zero** probes because disabled — avoids burning fees on `temDISABLED` / unknown tx.

## Seed exposure

Seeds only in secrets `.env`. Never print or commit.
