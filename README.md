<img src="docs/assets/mark.svg" width="96" height="96" alt="Aether Foundry mark: three ingots, a crucible, a ring">

# Aether Foundry

[![XRPL Testnet only](https://img.shields.io/badge/XRPL-Testnet%20%2F%20altnets%20only-5b21b6)](https://testnet.xrpl.org)
[![Desk read-only](https://img.shields.io/badge/desk-read--only-0f766e)](https://aether-foundry-desk.vercel.app)
[![Seeds never in git](https://img.shields.io/badge/seeds-never%20in%20git-9a3412)](./corp/wallets.md)
[![License ISC](https://img.shields.io/badge/license-ISC-374151)](./package.json)
[![Package private](https://img.shields.io/badge/package-private-4b5563)](./package.json)

A testnet laboratory that smelts XRPL primitives into named machines and writes down whether they earned. The product is **composition**: three or more ledger objects that, together, produce a measurable surplus. Payments, escrows, channels, NFT offers, an AMM, a credential door, an HTTP 402, a Xahau hook. Faucet money. Real reserves.

The repo is the corporate archive. The ledger is the economy. Founder: [Hobie1Kenobi](https://github.com/Hobie1Kenobi). Constitution: [`MASTER_PROMPT.md`](./MASTER_PROMPT.md). This page is the front door.

> **Never mainnet.** XRPL Testnet, Devnet, Xahau Testnet, XRPL EVM Testnet. Network id `0` and Xahau mainnet `21337` stay refused. The founder is the only one who may ever move this work to mainnet. This tree will not help with that.

<a id="thirty"></a>

### Thirty seconds, no Director

Walk-In is a standing **10 XRP** NFT sell offer on W2. The OfferID in the pack goes stale the moment someone buys. Read the live one, then accept it.

```bash
git clone https://github.com/Hobie1Kenobi/aether-foundry.git
cd aether-foundry
npm install
npm run buy:walk-in -- --dry-run
npm run buy:walk-in -- --faucet
npm run mcp
```

[`npm run mcp`](./machines/inbound-mcp/RUNBOOK.md) speaks stdio JSON-RPC. `MCP_SIGN` defaults to `off`. `walk_in_buy` returns `npm run buy:walk-in -- --dry-run` and does not sign. On the Foundry box, `npm run signer` binds `127.0.0.1:8787` and can RegularKey-sign allowlisted altnet transactions. The desk and GitHub Actions do not call it.

No checkout required. The desk does not sign:

```bash
curl -sS https://aether-foundry-desk.vercel.app/api/inbound/walk-in
curl -sS -D - -o /dev/null https://aether-foundry-desk.vercel.app/api/x402/reserve-audit
```

The second call is the x402 meter. Unpaid, it answers **402**. Pay W3 on Testnet, then retry. Full steps: [Interact without us](#interact).

## Contents

1. [⬡ What this is](#what)
2. [🚪 Enter the desk](#enter)
3. [⚖ Hard laws](#laws)
4. [🏛 Corporate anatomy](#anatomy)
5. [🧭 Boot → today](#boot)
6. [⚙ Machine gallery](#machines)
7. [🪙 Interact without us](#interact)
8. [↻ Ops loop](#ops)
9. [🗺 Layout](#layout)
10. [→ What is still open](#next)

<a id="what"></a>

## ⬡ What this is

Aether Foundry is an autonomous XRPL **Testnet** corporation. A machine ships when it attracts inbound test-value, leaves a recipe another agent can run, or teaches a protocol fact that got measured. `machine-spec` answers a grid-bot prompt with an observatory stub and stops. Composition is the identity.

Surplus here is testnet physics. Reserves eat float. Pathfinding moves. Ripple Epoch starts in the year 2000. The scar from handing an escrow a Unix timestamp is still on the ledger, on purpose.

Session opener, if you are the operator: `Aether Foundry: boot sequence.` The first-boot checklist in [`MASTER_PROMPT.md`](./MASTER_PROMPT.md) (§9) already ran. Resume from [`lab/director-state.json`](./lab/director-state.json).

<a id="enter"></a>

## 🚪 Enter the desk

| Door | Where |
|------|--------|
| Desk (read-only) | https://aether-foundry-desk.vercel.app |
| Wall of Change | https://aether-foundry-desk.vercel.app/wall |
| Wall RSS | https://aether-foundry-desk.vercel.app/api/wall/rss.xml |
| Walk-In live offer | https://aether-foundry-desk.vercel.app/api/inbound/walk-in |
| x402 catalog (free) | https://aether-foundry-desk.vercel.app/api/x402 |
| `xrp-ledger.toml` | https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml |
| Toml in git | [`public/xrp-ledger.toml`](./public/xrp-ledger.toml) |
| W0 Treasury | [`rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs`](https://testnet.xrpl.org/accounts/rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs) |
| Walk-In buyer page | [`machines/walk-in-window/INBOUND.md`](./machines/walk-in-window/INBOUND.md) |
| x402 buyer page | [`machines/x402-desk/INBOUND.md`](./machines/x402-desk/INBOUND.md) |
| Charter (W0 DID target) | [`corp/charter.md`](./corp/charter.md) |
| GitHub | https://github.com/Hobie1Kenobi/aether-foundry |

W0's Domain is `aether-foundry-desk.vercel.app`. A `*.v0.build` preview is a picture of the desk, not the host. RPC for humans and scripts: `https://s.altnet.rippletest.net:51234` (network id **1**). Socket: `wss://s.altnet.rippletest.net:51233`. Explorer: https://testnet.xrpl.org.
