# Machine — Oracle Mid-Ticket (Foundry Night B)

**Status:** spec only — no trial this session (2026-09-27-5)  
**Network:** XRPL Testnet only (`wss://s.altnet.rippletest.net:51233`)  
**Thesis:** A *price oracle* built from **AMM mid + CLOB mid**, frozen into a work-ticket quote (XRP or AETH labor units) so Atelier can sell tickets at an honest, reproducible FX without a third-party feed.

```mermaid
sequenceDiagram
  participant Or as W5 R&D (oracle operator)
  participant AMM as amm_info
  participant Book as book_offers
  participant W2 as W2 ATELIER
  participant Buy as BUYER/STRANGER
  participant L as XRPL Testnet

  Or->>AMM: amm_info(AETH,XRP) → spot_amm
  Or->>Book: book_offers both sides → mid_clob
  Or->>Or: quote = f(spot_amm, mid_clob, fee)
  Or->>L: optional: NFTokenMint quote-receipt OR memo on EscrowCreate
  W2->>L: NFTokenMint work-ticket @ quoted XRP
  Buy->>L: AcceptOffer + EscrowCreate (labor bond)
  Note over Or,L: v0: oracle is operator-signed off-chain;<br/>ledger stores quote text, not proof
```

## Primitive composition (≥3)

1. **amm_info** — constant-product mid from pool `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`.
2. **book_offers** (CLOB) — W1 passive wings; compute bid/ask mid.
3. **NFTokenMint + EscrowCreate** — work-ticket artifact priced in XRP derived from the composite mid (reuses Machine #1 pattern).
4. *(Optional)* **CheckCreate** — pre-position treasury rebate if quote drifts >ε before accept.

## Oracle formula (v0 proposal)

```
spot_amm = pool_xrp / pool_aeth
mid_clob = (best_bid_px + best_ask_px) / 2   # XRP per AETH
quote   = 0.7 * spot_amm + 0.3 * mid_clob   # AMM-heavy while book thin
labor_xrp = quote * labor_units_aeth        # e.g. 1 labor unit → ~0.01 XRP
```

Session-5 live: spot_amm ≈ **0.01011**; CLOB mid ≈ **0.0100** → quote ≈ **0.01008** XRP/AETH.

## Success metrics (when trialled)

| Metric | Target |
|--------|--------|
| Quote receipt in RESULTS with ledger index | yes |
| Ticket sell price = f(quote) within 5% | yes |
| Third-party oracle dependency | none |
| Amendment-gated? | **no** for read path; attestation still honor-system |

## Non-goals

- No Chainlink-style external feed.  
- No product txs this session.  
- Not a perpetual price stream — one-shot quote per ticket.
