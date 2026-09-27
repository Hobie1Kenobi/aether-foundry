# Threat

The hook is the treasury policy. A bad install or a bad parameter pays the wrong account, or pays twice.

| Case | Behavior |
|------|----------|
| Outgoing payment (Account is W7) | Accept. Do not emit. This is the reentrancy guard for anything that still reaches the hook. |
| HookOnOutgoing | Nothing-mask. Emitted Payments should not execute the hook at all. |
| cbak | Accept only. A retry could pay a share that already applied. A later `tec` failure of one emit is not atomic with the others; that share stays on W7. |
| Not a Payment, or Destination is not W7 | Accept. |
| `tfPartialPayment` | Rollback. `Amount` would not be what arrived. |
| IOU (high bit on the amount, or a 48-byte amount) | Accept and keep. This hook splits native drops only. |
| Negative amount | Rollback. |
| Below 100,000 drops | Accept and keep on W7. |
| Missing, short, duplicate, or self destination | Rollback. The incoming payment does not land. |
| `prepare` or `emit` returns an error inside the hook | Rollback. The incoming payment does not land. |
| Emit that validates and then `tec`-fails | Not retried. That share stays on W7. The other shares may already have paid. |
| Custom wasm sections | SetHook returns `temMALFORMED`. `npm run xahau:compile` runs `wasm-strip`. The guard checker in Xahau 2026.6.21 rejects `name`, `producers`, and `target_features`. |
| Public buildbox | `https://hook-buildbox.xrpl.org` currently rejects the `prepare` import. Do not install a buildbox wasm for this hook. |
| Seed handling | Scripts load `W7_SEED` / `W7_PAYER_SEED` from the environment or the secrets file and never print them. They refuse CI and non-`xahau-test.net` hosts. |
| Desk | `web/` does not sign. Xahau addresses are not in `WALLETS`, so the XRPL Testnet desk does not `account_info` them. |
| Reinstall | A second SetHook without `Flags` `hsfOVERRIDE` (the `--override` flag) is not a clean replace. Use `--override` only when replacing this hook on purpose. |

The hook has no loops. Copies and comparisons are unrolled so `-Os` cannot emit an unguarded `loop`. `_g` is imported because the guard checker requires it. Worst-case execution on the stripped wasm is 3,282 instructions for `hook` and 11 for `cbak`.
