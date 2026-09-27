# Machine — LP Badge (Foundry Night A)

**Status:** spec only — no trial this session (2026-09-27-5)  
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

## Success metrics (when trialled)

| Metric | Target |
|--------|--------|
| Badge NFT held by LP address | yes |
| LP balance ≥ stated threshold at mint time | recorded in RESULTS |
| Ledger-provable bind NFT↔LP | **no in v0** (honor-system) |
| Seeds in repo | none |

## Non-goals (this session)

- No mint, no AMMDeposit/Withdraw, no product txs.
- Not a yield wrapper; not transferable claim on LP principal.
