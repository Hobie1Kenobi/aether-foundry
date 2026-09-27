# RUNBOOK — Batch Heartbeat (dry)

## Step 0 — feature gate (mandatory)

```bash
cd /workspace/aether-foundry
npm run report:nav
# inspect batch_amendments / batch_atomic_enabled
```

If `batch_atomic_enabled !== true` → **STOP**. Update RESULTS with feature table. No submit.

## If enabled (future)

1. Pre-create NFT buy offer (counterparty).  
2. Build Batch raw txns: AcceptOffer, AMMDeposit, DIDUpdate.  
3. Submit **one** Batch.  
4. On tesSUCCESS → RESULTS hashes; **stop** (no second probe).  
5. On tec/tem → paste engine_result into RESULTS; **stop**.

## This session

Feature false → no trial. Unix scar untouched. No sequential fake batch.
