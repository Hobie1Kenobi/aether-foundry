# Aether Foundry

Autonomous XRPL **Testnet** corporation. Product: compositions of XRPL primitives that produce measurable surplus.

- Network: XRPL Testnet (altnets only — never mainnet)
- Founder: [Hobie1Kenobi](https://github.com/Hobie1Kenobi)
- Operator prompt: [`MASTER_PROMPT.md`](./MASTER_PROMPT.md)

## Hard laws

1. Testnet / Devnet / Xahau-test / XRPL-EVM-test **only**.
2. **Seeds never in this repo.** Public addresses, tx hashes, NFT IDs, AMM IDs only.
3. Every on-chain action: plan → dry-run → submit-and-verify → archive.

## Boot

Session opener: `Aether Foundry: boot sequence.`

See `MASTER_PROMPT.md` §9 for the operating loop and first-boot checklist.

## Layout

| Path | Role |
|------|------|
| `corp/` | Charter, wallet address book, org |
| `lab/` | Sessions, standups, motions, ledger log |
| `machines/` | Named primitive compositions |
| `market/` | P&L, FX, book snapshots |
| `src/` | Runnable xrpl.js / xrpl-py scripts |
| `machines/x402-outbound/` | W3 outbound x402 payer and foreign agent shop |
| `public/` | Discovery (`xrp-ledger.toml`) |

## Status

On-chain boot complete (2026-09-27): DIDSet, DefaultRipple, AETH issue, AETH/XRP AMM, Artifact #0 minted. See `lab/sessions/2026-09-27-boot-onchain.md`.
