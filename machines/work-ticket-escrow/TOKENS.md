# TOKENS — AETH TokenEscrow (v0.1)

**Status:** probed live on XRPL Testnet — session **2026-09-27-3**.

## Determination

**TokenEscrow = ENABLED** (`feature` amendment `138B968F…`, name `TokenEscrow`, `enabled: true`).

## Preconditions (satisfied)

1. BUYER TrustSet AETH to W0 — done  
2. BUYER funded 100 AETH from W0 — done  
3. W0 `asfAllowTrustLineLocking` (17) — done  
4. Destination W4 received AETH on EscrowFinish (trust auto-created / DefaultRipple path)

## Live trials

See RESULTS.md TokenEscrow section: cancel path + finish path, 50 AETH each.

## Rules

- IOU `Amount` on `EscrowCreate` requires TokenEscrow + issuer locking flag  
- **CancelAfter is mandatory** for token escrows  
- **Never** pass Unix timestamps as FinishAfter/CancelAfter — use Ripple Epoch (`src/time/rippleEpoch.js`)
