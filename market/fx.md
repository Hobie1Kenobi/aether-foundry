# AETH quote

**Working definition:** 1 AETH ≈ one Foundry labor unit (documented experiment step, minted artifact, liquidity-hour, or x402 call bundle).

| Date | Quote | Notes |
|------|-------|-------|
| 2026-09-27 | 1 AETH := 1 labor unit | Genesis — pre-AMM |
| 2026-09-27 (post-AMM) | ~0.01 XRP / AETH | Seed: 5000 AETH + 50 XRP |
| 2026-09-27-5 (live) | **≈0.01011 XRP / AETH** | AMM mid only — honest CLOB is wider |

## Honesty note (session-5)

AMM constant-product mid is **not** a firm quote. Live books (W1) show:

| Side | Size | Implied XRP/AETH |
|------|------|------------------|
| Ask (sell AETH) | 50 AETH / 0.525 XRP | 0.0105 |
| Ask | 200 AETH / 2.2 XRP | 0.0110 |
| Bid (buy AETH) | 0.475 XRP / 50 AETH | 0.0095 |
| Bid | 1.8 XRP / 200 AETH | 0.0090 |

**Labor-unit FX for work tickets:** the published figure is the W5 `Oracle` (document 1, AETH/XRP, scale 8) once the box has submitted it. Until that object exists, `npm run frontier:oracle-ticket` refuses rather than using a local float. Machine #4 (`machines/oracle-mid-ticket/`) remains the honor-system trial. Keeper: `machines/native-price-oracle/`.

## AMM AETH/XRP snapshot (live 2026-09-27 ~10:13 AM CT)

| Field | Value |
|-------|-------|
| AMM account | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| Asset | AETH (`4145544800000000000000000000000000000000`) issuer W0 |
| Asset2 | XRP |
| Pool AETH | ≈4973.542951524584 |
| Pool XRP | ≈50.270313 (50270313 drops) |
| Trading fee | 500 (0.5%) |
| LP outstanding | 500000 (currency `0330E60FAE706EAD2C7D511D790B07A6F3B89931`) |
| LP holder (creator) | W1 MARKET |
| Spot (pool) | ≈0.01011 XRP per AETH |
| Create hash | `ED9D47A42456A1504918CDFC1648BA4F86EDDBDFFB5CACC01F943B810B45A740` |
| Explorer | https://testnet.xrpl.org/amm/r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w |
| AETH obligations | 10100 (gateway_balances) |
