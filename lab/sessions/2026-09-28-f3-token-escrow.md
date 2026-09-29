# Session — F3 TokenEscrow labor live trial

**When:** 2026-09-28 ~19:32–19:36 CDT (America/Chicago)  
**Merge:** `e60206f14210d0b81471f2f2ad1eddb871ae5c13` (PR #26)  
**Network:** XRPL Testnet id 1. Amendment `TokenEscrow` enabled.

## Done

1. Dry-run create: `network_id` 1, MPT amount 1 of `0141DD60…19504ED`, Ripple Epoch locks.
2. Funded W2 with 10 labor from W5 (`E460F70F…E252EE`) — Outstanding was 0 after F2.
3. W4 opt-in then issuer authorize (`24DC0A62…`, `EF53EA93…`).
4. Trial A create `BA9C9471…` seq `21093737` → finish `7536CB47…` after `FinishAfter`.
5. Trial B create `64893022…` seq `21093738` → cancel `FC7CB7C6…` after `CancelAfter`.
6. Rebate not submitted (`NO_DRIFT`).

No seeds printed. No W0. No Credentials/Batch. No Unix FinishAfter.
