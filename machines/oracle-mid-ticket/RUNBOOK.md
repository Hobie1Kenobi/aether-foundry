# RUNBOOK — Oracle Mid-Ticket

**Mode:** trialled (session 2026-09-27-6). Live path: `node src/oracle-mid-ticket-session.js`

```bash
cd /workspace/aether-foundry
npm run report:nav
node src/oracle-mid-ticket-session.js
```

## Checklist

1. `amm_info` → spot_amm; use `ledger_index ?? ledger_current_index`.  
2. `book_offers` both sides → mid_clob; flag `clob_thin` if either side empty (then weight AMM 100%).  
3. `quote = 0.7 * spot_amm + 0.3 * mid_clob` (or 1.0×AMM if thin); write `lab/oracle/YYYY-MM-DD-HHMM.json`.  
4. W2 mint ticket URI with `#quote=&ledger=&ts=`; TransferFee 1000; taxon `20260927`; sell at `labor_xrp` drops.  
5. BUYER (or faucet actor) accept + EscrowCreate to W4 — **Ripple Epoch** via `src/time/rippleEpoch`.  
6. EscrowFinish after FinishAfter; paste hashes into RESULTS.

## Safety

- Testnet only. Never print/commit seeds.  
- Do not touch the Unix-epoch BUYER escrow scar.  
- No Batch. This trial did not submit `OracleSet`. The ledger oracle is `machines/native-price-oracle/`.
