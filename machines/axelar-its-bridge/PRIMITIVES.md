# PRIMITIVES — Axelar ITS testnet bridge

| Piece | Where | What it does |
| --- | --- | --- |
| Pin | `src/bridge/axelar/config.js` | Testnet gateway, chain names, chain id 1449000, ITS address, token id, Labs RPC. No fetch. |
| Policy | `src/bridge/axelar/policy.js` | Network, host, asset, wallet isolation, caps, replay inputs. |
| Plan | `src/bridge/axelar/plan.js` | Unsigned XRPL Payment, or a blocked EVM calldata plan. |
| Status | `src/bridge/axelar/status.js` | Maps local state, XRPL results, and GMP JSON to pending / uncertain / recovery / error / final. |
| Store | `src/bridge/axelar/store.js` | Local plan and review records. The CLI file is gitignored. |
| CLI | `src/bridge/axelar/cli.js` | `plan`, `review`, `status`, `stellar`. `sign` and `submit` always refuse. |
| Signer gate | `src/runtime/policy.js` | Existing agent signer refuses gateway payments and ITS memos. |
| Grant gate | `src/grants/policy.js` | W6 XRP and AETH grants refuse both gateway addresses. |

Not on the agent allowlist. Not a desk route. Not a director machine row.

XRPL memo bytes follow the Axelar ITS payment example: `MemoType` and `MemoData` are hex of UTF-8, except that this pack never attaches `payload`. The EVM destination address is the 40-character lowercase hex, then hex-encoded into `MemoData`.

The return-leg destination address is the ASCII bytes of the classic XRPL address, which is what `encodeITSDestination` does for chain type `xrpl` in `axelar-contract-deployments` `common/utils.js`. The function selector is keccak256 of `interchainTransfer(bytes32,string,bytes,uint256,bytes,uint256)`, the v2.1.1 signature. Call value is omitted.
