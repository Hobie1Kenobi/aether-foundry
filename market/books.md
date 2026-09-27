# Order books & AMM books (Testnet)

**Snapshot (CT):** 2026-09-27 ~09:50 AM  
**Ledger:** ~21094096

## AMM AETH/XRP (primary liquidity)

| Field | Value |
|-------|-------|
| AMM | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| Pair | AETH / XRP |
| Reserves (post session-2) | ≈5023.54 AETH / ≈49.767 XRP |
| Spot (approx) | ~0.0099 XRP per AETH (~101 AETH/XRP) |
| Fee | 0.5% (`trading_fee` 500) |
| Create hash | `ED9D47A42456A1504918CDFC1648BA4F86EDDBDFFB5CACC01F943B810B45A740` |

Note: slight drift from seed 5000/50 after early CLOB self-cross experiments touched balances; LP token supply unchanged at 500000 on W1.

## Classic DEX — four tfPassive offers (W1 MARKET)

Housekeeping only (Director: no grid). Size tiers 50 / 200 AETH.  
Director's first numeric labels (ask@101/105 & bid@99/95 AETH/XRP) **self-cross** under XRPL quality; live book uses non-crossing wings around mid in **XRP per AETH**:

| Side | Size | Price (XRP/AETH) | ≈AETH/XRP | Seq | OfferCreate hash |
|------|------|------------------|-----------|-----|------------------|
| ASK sell AETH | 50 | 0.0105 | ≈95.24 | 21093737 | `6038AC31F50B98EB8F2838ED8DA99AA923B774FAA78DE91462753EC763F6A76B` |
| ASK sell AETH | 200 | 0.0110 | ≈90.91 | 21093738 | `614D82BADB3ECF3862B20C04BCC3ABC6E83BF56305AD920E55BDC159CC41140F` |
| BID buy AETH | 50 | 0.0095 | ≈105.26 | 21093739 | `B0F679494C65AFA21E8C352A9DDAAAAFB775FD562C762B460AEE9671C615DDAB` |
| BID buy AETH | 200 | 0.0090 | ≈111.11 | 21093740 | `69F18E0A14B5735567BE4D3EC71A104E664F734D5B212C1CE61BFCA003C36AE5` |

Flags: `tfPassive` (65536). Account: `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS`.

### Orientation

- **Ask:** TakerGets=AETH, TakerPays=XRP  
- **Bid:** TakerGets=XRP, TakerPays=AETH  

**STOP** — no further CLOB/grid this session.
