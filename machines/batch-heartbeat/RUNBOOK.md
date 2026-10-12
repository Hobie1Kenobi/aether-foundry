# RUNBOOK — Batch Heartbeat

## Step 0 — feature gate

The signer re-reads `feature` on XRPL Testnet (network id 1) before it signs. `BatchV1_1` and `fixBatchV1_2` must both be enabled. `TicketBatch` alone is not the gate. A network id other than 1 is a refuse. CI is a refuse.

## Dry-run (default)

```bash
npm run batch:heartbeat
```

Autofill and print. No submit. No seed. If the ledger has no open heartbeat offer, the printed accept leg uses a placeholder offer id. Do not submit that placeholder.

## Live (Foundry box only)

The signer listens on `127.0.0.1:8787` with `FOUNDRY_AGENT_SIGN=yes` and `FOUNDRY_SIGNER_TOKEN`.

```bash
npm run batch:heartbeat -- --live
```

1. W2 mints taxon `20261012` if needed, then lists a sell to W1 at the offer cap (default `10000` drops, max `100000`).
2. W1 signs one `tfAllOrNothing` Batch: `NFTokenAcceptOffer`, single-asset `AMMDeposit` (default `1000000` drops, max `2000000`), `DIDSet` on W1.
3. The script looks up the outer hash and each inner hash. Every result must be `tesSUCCESS`.

One `batch_heartbeat` per UTC day. W0 does not sign.

## Stop

On `tec` or `tem`, paste the engine result into RESULTS and stop. Do not send a second Batch the same UTC day. Do not split the three legs into separate transactions.
