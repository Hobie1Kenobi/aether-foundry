# Hooks

Xahau Testnet Hooks. Not XRPL Testnet and not Xahau mainnet.

| Hook | Source | Wasm |
|------|--------|------|
| W7 treasury split | `hooks/w7-split/w7-split.c` | `hooks/w7-split/w7-split.wasm` |

Compile with `npm run xahau:compile`. That runs `clang --target=wasm32 -Os` against `hooks/vendor/xahau` and then `wasm-strip`. The strip step is required: Xahau’s guard checker rejects custom sections, and SetHook returns `temMALFORMED` if they remain.

Headers are copied from Xahau/xahaud `a7f9c683` (`hook/`) under the ISC license in `hooks/vendor/xahau/LICENSE.md`, because this tree’s `prepare` import matches HooksUpdate2 on Testnet. The public buildbox at `https://hook-buildbox.xrpl.org` still rejects `prepare`. Do not use it for this hook.

Install and trial live on the Foundry box: `machines/xahau-split-treasury/RUNBOOK.md`.
