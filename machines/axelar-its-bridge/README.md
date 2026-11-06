# Axelar ITS bridge (testnet only)

**Status:** unsigned planning and offline status classification. Signing and submission are disabled.  
**Route:** native XRP, XRPL Testnet (network id 1) ↔ XRPL EVM Testnet (chain id `1449000`, Axelar name `xrpl-evm`).  
**Asset:** XRP only.  
**Wallets:** two isolated bridge test addresses. Never W0–W7.  
**This pack is AI-assisted integration.** It is not an audit, a mainnet integration, or a permission to move funds.

The desk does not plan, sign, or submit this route. The loopback signer does not gain an Axelar action. A Payment to the Axelar gateway, or a memo of type `interchain_transfer`, is refused on the existing agent signer, on x402 outbound, and on W6 grants.

## What is pinned

Verified on 2026-11-06 from the Axelar testnet static config and the XRPL ITS docs:

| Field | Value |
| --- | --- |
| XRPL Axelar chain | `xrpl` |
| XRPL gateway and ITS account | `rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2` |
| XRPL EVM Axelar chain | `xrpl-evm` |
| EVM chain id | `1449000` |
| InterchainTokenService | `0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C` |
| XRP token id | `0xba5a21ca88ef6bba2bfff5088994f90e1077e2a1cc3dcc38bd261f00fce2824f` |
| XRPL RPC used here | `https://testnet.xrpl-labs.com` |
| XRPL EVM RPC | `https://rpc.testnet.xrplevm.org` |
| GMP status API | `https://testnet.api.axelarscan.io` |

Axelar's published XRPL RPC is `https://s.altnet.rippletest.net:51234`. This pack records that URL and does not use it. Reads stay on the existing XRPL Labs testnet host.

The mainnet gateway `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw` is a denylist entry. It is never a destination.

## Commands

```bash
npm run bridge:axelar -- help
npm run bridge:axelar -- stellar
npm run bridge:axelar -- plan --direction xrpl-to-evm --client-id round-trip-01 --amount-drops 1000000 --gas-drops 100000 --from <isolated-r-address> --to <isolated-0x-address> --wallets machines/axelar-its-bridge/wallets.json
npm run bridge:axelar -- review --plan-id <id> --confirm REVIEW-AXELAR-TESTNET
npm run bridge:axelar -- status --plan-id <id>
```

`plan` is a dry run. It writes an unsigned plan under `lab/bridge/` (gitignored). `review` records approval and leaves `signable: false`. `sign` and `submit` exit `SIGNING_DISABLED`. `status --fetch` is refused; pass local JSON files instead.

## Return leg

XRPL → XRPL EVM builds the four ITS memos from the published payment format. XRPL EVM → XRPL builds calldata for ITS v2.1.1 `interchainTransfer(bytes32,string,bytes,uint256,bytes,uint256)` and then blocks the plan. The published XRPL EVM XRP row uses the native sentinel and `mintBurn`. This pack does not guess `msg.value`. The return leg is not reviewable.

## Stellar

Stellar / XLM is **unsupported**. The Axelar testnet config currently lists a dated chain id `stellar-2026-q1-2`. That name is not an approved route. No Stellar memo, address, or transaction is encoded. `npm run bridge:axelar -- stellar` prints that refusal.

## Non-goals

- No mainnet, network id 0, or chain id other than `1449000`.
- No faucet, no automatic funding, no live transfer test.
- No seed, `.env`, or `aether-foundry-secrets` read or write.
- No IOU, no GMP payload, no Add Gas transaction.
- No promised destination amount. ITS hub decimal scaling is not applied.
