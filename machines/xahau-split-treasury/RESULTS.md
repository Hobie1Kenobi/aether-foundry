# Xahau split treasury — RESULTS

**Network:** Xahau Testnet, network ID 21338, `wss://xahau-test.net`  
**Server:** `2026.6.21-release+3350`  
**Date:** 2026-09-27  
**Status:** SetHook and the split payment are **live** on Xahau Testnet. This is not Foundry-box gated.

Explorer base: https://xahau-testnet.xrpl.org

## Wasm

| Field | Value |
|-------|--------|
| Source | `hooks/w7-split/w7-split.c` |
| Bytes | 9164 after `wasm-strip` |
| sha256 | `9d214b465e05660a95dc18e3bb51cd1f8972bd597e97840863cb9330fb24812a` |
| HookHash | `B9B6A6D5DDCF4212CC046217500AB3D90D54C7E63684F98E7991F4EBA9BC6C09` |
| HookDefinition | `475AB271798F2FBB257AF3A57A7494742CFF42C9130790CD9925AF9F5EE07E5F` |
| Hook ledger index | `C3ABA1460EF3339BFBC4CE25E963ABCF016DD16F71153263FB7989105666B629` |
| Namespace | `CA4D1C551EC4F1BE9EF9A726DF401F71B2FE22A5B17BD5E76A9FA33996057F79` |
| Guard check | hook worst-case 3282 instructions, cbak 11. No custom sections. |

An earlier 9,450-byte wasm still had `name`, `producers`, and `target_features` sections. SetHook returned `temMALFORMED` and did not consume the sequence. `wasm-strip` removed those sections. The retry validated.

## SetHook

| Field | Value |
|-------|--------|
| Account | `r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h` |
| Hash | `7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447` |
| Ledger | 12693992 |
| Result | tesSUCCESS |
| Fee | 4,582,231 drops |
| Sequence | 843855710 |

https://xahau-testnet.xrpl.org/transactions/7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447

## Split trial

Payer `rKteu2WyN5nm7i8txzw1VCgN14DDGxztC9` sent 1,000,000 drops to W7, SourceTag 7707.

| Field | Value |
|-------|--------|
| Hash | `E6142FB0B82375A01D7E07A3AF0046B6030F4CC34BCB9C3B0A2148E3ED9EEBD6` |
| Ledger | 12693999 |
| Result | tesSUCCESS |
| Fee (payer) | 3,292 drops |

https://xahau-testnet.xrpl.org/transactions/E6142FB0B82375A01D7E07A3AF0046B6030F4CC34BCB9C3B0A2148E3ED9EEBD6

| Share | Drops | Destination | SourceTag | Emit hash |
|-------|------:|-------------|----------:|-----------|
| MARKET | 400,000 | `rUV6zDW72xLRWtECfAivjfQ67EXUE5cq38` | 740 | `B4143EF0880DF1A89D74F970167325E1E9E98DB8A42BA7F3C26C78B0A44F6456` |
| ATELIER | 250,000 | `rU98zDxthCRjoQLURzhrPJoo2t851gvExk` | 725 | `1743820303947431AF841B28E9A2DD4C704AE563277F40BCCB7042C826F76AAA` |
| RESEARCH | 200,000 | `rB5jFnmc7BdBAJdquSMwhkTKjJaJGfnB8m` | 720 | `8456E24A8D676E0EF0E7674C879D105721A8939371D2A4A9D4D28A0AB2D632B3` |
| GRANTS | 100,000 | `rHjzEwwBAB7BRwfjFMVGsmGduEahSCPkBh` | 710 | `D01AC7E5443E5AB1FFE2C8595AAE305FC86448C9724685951656B2E4DFA28227` |
| SINK | 50,000 | `rLwvjUEuSBe8PByEnpwWxUryG4KRCXqt6K` | 705 | `B931446F20BDDC640D37F9B080613CDDD93AFB74AD6A5A51E62875B200BC2A29` |

Each destination’s validated balance rose by exactly that share. Each emit fee was 61 drops, paid from W7 (305 drops total). W7’s balance change across SetHook plus the trial was `-4,582,536` drops. The incoming 1,000,000 drops did not stay on W7.

After the trial, W7 Balance was 995,417,464 drops, OwnerCount 1, Sequence 843855711.

`lab/ledger-log.jsonl` has `xahau_faucet` lines for the seven accounts, plus `xahau_set_hook` and `xahau_split_trial`.
