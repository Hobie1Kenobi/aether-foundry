# RUNBOOK — LP Badge (dry)

**Mode:** dry / spec only this session. Do not submit product txs until Director opens a trial.

## Prerequisites

```bash
cd /workspace/aether-foundry
npm run report:nav   # confirm W1 LP balance + AMM
```

WS: `wss://s.altnet.rippletest.net:51233`

## Dry checklist (trial day)

1. `amm_info` AETH/XRP → record pool + LP outstanding.  
2. `account_lines` W1 → LP balance ≥ threshold.  
3. W2 `NFTokenMint` badge URI → this README.  
4. W2 `NFTokenCreateOffer` Destination=W1 Amount=0 or 1 XRP.  
5. W1 `NFTokenAcceptOffer`.  
6. Verifier script: fail if LP < threshold **or** NFT missing (still honor-system between checks).  
7. Copy hashes into RESULTS; mark **honor-system**.

## Explicit non-actions

- No `AMMDeposit` / `AMMWithdraw` for the badge itself.  
- No Batch wrapper.  
- Do not touch Unix-scar escrow on BUYER.
