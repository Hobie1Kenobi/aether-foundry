# RUNBOOK — Oracle Mid-Ticket (dry)

**Mode:** dry / spec only this session.

```bash
cd /workspace/aether-foundry
npm run report:nav
# then (trial day) a future: node src/oracle-mid-ticket-session.js
```

## Dry checklist

1. `amm_info` → spot_amm; save ledger_index.  
2. `book_offers` both sides → mid_clob; flag if thin.  
3. Compute quote; write `lab/oracle/YYYY-MM-DD-HHMM.json` (no secrets).  
4. W2 mint ticket URI with quote params; sell at `labor_xrp`.  
5. Purchaser accept + EscrowCreate (Ripple Epoch!).  
6. Paste recomputation in RESULTS.

## Non-actions this session

No mint, no escrow, no offers beyond existing passive wings.
