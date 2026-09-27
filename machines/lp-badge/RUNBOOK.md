# RUNBOOK — LP Badge

**Mode:** trialled (session 2026-09-27-7). Re-run via operator script for additional badges.

## Prerequisites

```bash
cd /workspace/aether-foundry
npm run report:nav   # confirm W1 LP balance + AMM
# secrets: /workspace/aether-foundry-secrets/.env (never cat / commit)
node src/lp-badge-session.js
```

WS: `wss://s.altnet.rippletest.net:51233`

## Live checklist (completed 2026-09-27-7)

1. `amm_info` AETH/XRP → pool + LP outstanding **500000**.  
2. `account_lines` W1 → LP **500000** ≥ threshold **100000**.  
3. W2 `NFTokenMint` badge URI → README + `#lp-threshold=100000&lp=500000&holder=W1`.  
4. W2 `NFTokenCreateOffer` Destination=W1 Amount=0 (attestation).  
5. W1 `NFTokenAcceptOffer`.  
6. Verifier: LP ≥ threshold **and** badge present → **PASS** (honor-system).  
7. Hashes → RESULTS + `lab/sessions/2026-09-27-7-raw.json`.

## Explicit non-actions

- No `AMMDeposit` / `AMMWithdraw` for the badge itself.  
- No Batch wrapper.  
- Do not touch Unix-scar escrow on BUYER.  
- Never print or commit seeds.
