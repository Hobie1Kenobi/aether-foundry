# Ripple Epoch — FinishAfter / CancelAfter

**Rule:** Never pass Unix timestamps into `FinishAfter` or `CancelAfter`.

XRPL time fields use **Ripple Epoch** (seconds since 2000-01-01T00:00:00Z):

```
ripple = unix_seconds - 946684800
```

Helpers: `src/time/rippleEpoch.ts` / `.js` — `unixToRipple`, `rippleToUnix`, `rippleNow`.  
Tests: `npm test`.

## Scar (observed 2026-09-27)

Passing Unix as FinishAfter locked 10 XRP on BUYER until ~2056. Documented in `machines/work-ticket-escrow/THREAT.md`. Do not attempt recovery; faucet-top instead.

Payment channel `SettleDelay` is ordinary seconds — not Ripple Epoch.
