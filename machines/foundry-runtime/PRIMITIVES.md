# PRIMITIVES — Foundry Box daemon

**Network:** XRPL Testnet. Network id 1. Signing RPCs must be `*.rippletest.net`.

The daemon does not invent a transaction type. Each action wraps a primitive the repo already uses.

| Action | Primitive | Account | Notes |
|---|---|---|---|
| `walk_in_remint` | `NFTokenMint`, then `NFTokenCreateOffer` | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` | Taxon `20260927`, transferable, transfer fee `1000`, sell amount `10000000` drops, flag `tfSellNFToken`, no `Destination`. Built from `src/walk-in-public.js`. Live re-polls `account_objects` before it signs. |
| `grant_pay` | `Payment` | W6 `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf` | `src/grants/policy.js` `buildGrantPayment`. SourceTag `202609276`. Memos from the grants flywheel. One candidate from `grants:scan`. |
| `heartbeat` | `Payment` | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` | Amount default `1` drop. Destination W3 or W6. SourceTag `202609280`. |
| `x402_outbound` | `Payment` | W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` | `src/x402-outbound-guard.js` `buildPaymentTx` after an x402 v2 `xrpl:1` accept. |
| `director_snapshot` | HTTPS JSON-RPC only | none | `src/director/snapshot.js`. Preserves `next_actions`, `blockers`, `last_session_id`. |

## Not used

- `Batch`. `watched.batch.atomic_enabled` is false. The daemon refuses `TransactionType` `Batch` on every weekday.
- `EscrowFinish` and `EscrowCancel`. The Unix-epoch BUYER escrow stays untouched.
- `SetHook`. W7 is not redeployed from this process.
- W0 master key. No daemon transaction uses the treasury account.
- Master seeds `W2_SEED`, `W3_SEED`, `W6_SEED`. The allowlist names RegularKey env vars only.

## Loop

`npm run runtime:dry` is one pass. `npm run runtime:watch` is the live loop: 60 seconds, plus a Testnet `subscribe` on W2, W3, W5, and W6 when the socket connects. A failed socket does not skip the policy checks. Exit `0` when wake is quiet, `2` when it alerts, `1` on a fatal error.
