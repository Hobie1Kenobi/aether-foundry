# Primitives

Xahau Testnet, network ID 21338. Hooks amendment family only. No XRPL Testnet `SetHook` and no mainnet.

| Primitive | Use |
|-----------|-----|
| Account | W7 holds the Hook. Five Xahau accounts receive emits. A sixth account is the trial payer. |
| Payment (native) | The trigger. `Amount` is drops. IOU amounts are accepted and left on W7. |
| SetHook | Installs `hooks/w7-split/w7-split.wasm` with HookApiVersion 0, a namespace, HookOnIncoming, HookOnOutgoing, HookCanEmit, and five HookParameters. |
| HookParameter | Name is ASCII (`MARKET`, `ATELIER`, `RESEARCH`, `GRANTS`, `SINK`). Value is the 20-byte AccountID, not the classic address string. `RESEARCH` is spelled out so an even-length hex alphabet name is not mistaken for raw hex. |
| emit / prepare | `etxn_reserve(5)` then `prepare` fills Account, Sequence, Fee, SigningPubKey, ledger range, and EmitDetails. `emit` sends a Payment. |
| SourceTag | MARKET 740, ATELIER 725, RESEARCH 720, GRANTS 710, SINK 705. The trial payer uses 7707, which is not a bucket tag. |
| HookOn | Incoming mask fires Payment only. Outgoing mask fires nothing, so the five emits do not re-enter the hook. HookCanEmit allows Payment only. |
| Namespace | sha256(`aether-foundry-w7-split`) = `CA4D1C551EC4F1BE9EF9A726DF401F71B2FE22A5B17BD5E76A9FA33996057F79` |

HookOn bytes are the xahau.js `calculateHookOn` field. After the ttHOOK_SET xor and the invert in `canHookTT`, a set bit means that transaction type runs. Payment is type 0. SetHook is type 22. The payment mask is `FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFFFFE`. The nothing mask is the same string with a final `F`.
