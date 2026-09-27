# Machine — LP Badge (Foundry Night A)

**Status:** trialled (session 2026-09-27-7) — see RESULTS.md  
**Network:** XRPL Testnet only (`wss://s.altnet.rippletest.net:51233`)  
**Thesis:** An NFT that is a *claim / badge* tied to the holder's AMM LP position in AETH/XRP — membership in the liquidity guild, not a PFP.

```mermaid
sequenceDiagram
  participant W1 as W1 MARKET (LP holder)
  participant W2 as W2 ATELIER
  participant AMM as AMM AETH/XRP
  participant L as XRPL Testnet
  participant V as Verifier (off-chain)

  W1->>AMM: holds LP token (account_lines)
  W2->>L: NFTokenMint lp-badge-0001 (URI→README)
  W2->>L: NFTokenCreateOffer (sell / transfer to LP holder)
  W1->>L: NFTokenAcceptOffer
  V->>L: account_lines(W1) + account_nfts(W1)
  Note over V: v0 honor: URI claims LP link;<br/>ledger does not bind NFT↔LP
```

## Primitive composition (≥3)

1. **AMM / LP Token** — existing pool `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`; LP currency `0330E60F…` held by W1.
2. **NFTokenMint / CreateOffer / AcceptOffer** — transferable badge (taxon `20260927`, royalty 1%).
3. **account_lines + account_nfts (read)** — verifier checks LP balance ≥ threshold *and* badge NFT present.
4. *(Upgrade path)* **Credential / Hook** — day amendments allow on-ledger gating; port-forward in THREAT.

## Trial summary (2026-09-27-7)

| Field | Value |
|-------|-------|
| LP @ mint | **500000** (≥ threshold **100000**) |
| NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C` |
| Mint / Offer / Accept | `A8185AFA…` / `D7E6B0E9…` / `A2956F44…` |
| Verifier | **PASS** (honor-system) |
| Script | `src/lp-badge-session.js` |

## Success metrics

| Metric | Target | Result |
|--------|--------|--------|
| Badge NFT held by LP address | yes | **yes** (W1) |
| LP balance ≥ stated threshold at mint time | recorded in RESULTS | **500000 ≥ 100000** |
| Ledger-provable bind NFT↔LP | **no in v0** (honor-system) | confirmed |
| Seeds in repo | none | none |

## Non-goals

- Not a yield wrapper; not transferable claim on LP principal.
- No AMMDeposit/Withdraw for the badge itself; no Batch; no OracleSet.
