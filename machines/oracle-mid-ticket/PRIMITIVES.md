# PRIMITIVES — Oracle Mid-Ticket v0

## amm_info

| Field | v0 usage |
|-------|----------|
| asset | `{ currency: AETH_HEX, issuer: W0 }` |
| asset2 | `{ currency: "XRP" }` |
| Derived | `spot_amm = dropsToXrp(amount2) / Number(amount.value)` |

## book_offers

| Side | taker_gets | taker_pays |
|------|------------|------------|
| Asks (sell AETH) | AETH/W0 | XRP |
| Bids (buy AETH) | XRP | AETH/W0 |

Derive best ask/bid prices as XRP per AETH; `mid_clob = (bid+ask)/2`. If either side empty → weight AMM 100% and flag `clob_thin`.

## NFTokenMint (quote-ticket)

Same pattern as work-ticket-escrow: W2, taxon `20260927`, URI → machine README + `#quote=<xrp_per_aeth>&ledger=<n>&ts=<iso>`.

## EscrowCreate (labor bond)

| Field | v0 usage |
|-------|----------|
| Account | purchaser |
| Destination | W4 ESCROW |
| Amount | `labor_xrp` drops from oracle formula |
| FinishAfter | Ripple Epoch via `src/time/rippleEpoch.js` — **never Unix** |

## Optional CheckCreate

W0 → purchaser SendMax = drift rebate; cash if accept delayed and mid moved >ε.
