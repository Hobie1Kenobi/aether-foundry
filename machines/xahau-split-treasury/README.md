# Xahau split treasury — W7

**Network:** Xahau Testnet only. Network ID `21338`.  
**WebSocket:** `wss://xahau-test.net`  
**RPC:** `https://xahau-test.net`  
**Treasury:** W7 `r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h`

Incoming native XAH paid to W7 is split on-ledger by a Hook. This is not an XRPL Testnet hook and not a mainnet hook. XRPL Testnet classic addresses are twins in the address book only. Emit destinations are separate Xahau accounts.

| Share | Role | Xahau destination | XRPL Testnet twin |
|------:|------|-------------------|-------------------|
| 40% | MARKET | `rUV6zDW72xLRWtECfAivjfQ67EXUE5cq38` | W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` |
| 25% | ATELIER | `rU98zDxthCRjoQLURzhrPJoo2t851gvExk` | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| 20% | R&D | `rB5jFnmc7BdBAJdquSMwhkTKjJaJGfnB8m` | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| 10% | GRANTS | `rHjzEwwBAB7BRwfjFMVGsmGduEahSCPkBh` | W6 `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf` |
| remainder | SINK | `rLwvjUEuSBe8PByEnpwWxUryG4KRCXqt6K` | none |

The remainder is the 5% share plus any integer-division dust, so the five emits sum to the incoming drops.

## Pieces

| Piece | Where |
|-------|--------|
| Hook C | `hooks/w7-split/w7-split.c` |
| Stripped wasm | `hooks/w7-split/w7-split.wasm` |
| Compile | `npm run xahau:compile` |
| Faucet (once) | `npm run xahau:provision` |
| SetHook | `npm run xahau:sethook` |
| Trial payment | `npm run xahau:trial` |
| Public book | `machines/xahau-split-treasury/addresses.json` |

Seeds stay in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`. The scripts refuse `CI` / `GITHUB_ACTIONS` and refuse any host that is not `xahau-test.net`.

## Status

SetHook and a 1 XAH split payment are live on Xahau Testnet. Hashes are in `RESULTS.md`. Reinstall uses `--override`.
