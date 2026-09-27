# Machine #2 — Drip Pass

**Network:** XRPL Testnet only  
**Session:** 2026-09-27-3  
**Channels desk:** W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`

## Intent

Sell a transferable **Drip Pass** NFT (Atelier W2 → BUYER), then fund a **Payment Channel** from BUYER → W3. Three incremental claims (2 XRP each) carry memos pointing at `lab/drip/000N.md`. Channel settles after `SettleDelay`.

This is **not** TokenEscrow (M1 housekeeping). Machine #2 invents a drip / channel primitive — no CLOB grid, no Hooks, no EVM, no TOML.

## Flow (summary)

1. `NFTokenMint` "Drip Pass" (taxon `20260927`) from W2; sell offer; BUYER accept  
2. `PaymentChannelCreate` BUYER → W3 (e.g. 16 XRP, SettleDelay 30s)  
3. Lab notes `lab/drip/0001.md` … `0003.md`  
4. Three `PaymentChannelClaim` (cumulative 2 / 4 / 6 XRP) with memo → lab note  
5. Claim with `tfClose` + wait SettleDelay + final close (remainder to source)

## Key docs

| File | Role |
|------|------|
| PRIMITIVES.md | Tx field map |
| ECONOMICS.md | Reserves, claim economics |
| THREAT.md | Adversary sign-off |
| RUNBOOK.md | Operator steps |
| RESULTS.md | On-chain hashes |
| artifact.json | Machine manifest |

## Addresses

| Role | Address |
|------|---------|
| BUYER | `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` |
| W2 Atelier | `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| W3 Channels | `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` |

Seeds: `/workspace/aether-foundry-secrets/.env` only — never commit.
