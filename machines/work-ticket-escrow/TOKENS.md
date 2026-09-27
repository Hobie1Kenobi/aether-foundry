# TOKENS — AETH TokenEscrow (v0.1 spec only)

**Status:** specification stub — **not implemented** in session 2026-09-27-2.

## Intent

Replace or complement XRP EscrowCreate with Token Escrow of AETH IOU (`4145544800000000000000000000000000000000`, issuer W0) so work tickets settle in Foundry units.

## Preconditions (future)

1. BUYER TrustSet AETH to W0 with adequate limit.
2. BUYER holds AETH (AMM swap or Payment from W0/W1).
3. Confirm TokenEscrow amendment / API live on the connected altnet.
4. Destination W4 (or Atelier) ready to receive IOU (trust line).

## Sketch

- EscrowCreate-equivalent for IOU with FinishAfter / CancelAfter.
- Failure: unfunded trust, frozen line, clawback policy, reserve for trust line + escrow object.

## Non-goal this session

No TokenEscrow transactions, no AETH escrow objects.
