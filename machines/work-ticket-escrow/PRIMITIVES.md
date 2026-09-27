# PRIMITIVES — Work-Ticket Escrow v0

## EscrowCreate

| Field | v0 usage |
|-------|----------|
| Account | BUYER (payer) |
| Destination | W4 ESCROW |
| Amount | XRP drops (e.g. 10 XRP work ticket) |
| FinishAfter | Ripple Epoch; earliest finish |
| CancelAfter | Ripple Epoch; must be **> FinishAfter** if both set |
| Condition | **omitted** (time locks only) |

Ripple Epoch: `ripple = unix_seconds - 946684800`.

## EscrowFinish

| Field | v0 usage |
|-------|----------|
| Account | W4 (destination) or any account after FinishAfter (unconditional) |
| Owner | BUYER (escrow creator) |
| OfferSequence | Sequence of the EscrowCreate tx |

Fails with `tecNO_PERMISSION` if ledger close time < FinishAfter.

## EscrowCancel

| Field | v0 usage |
|-------|----------|
| Account | any (typically BUYER) |
| Owner | BUYER |
| OfferSequence | EscrowCreate sequence |

Allowed only after CancelAfter. Returns XRP to Owner.

## NFTokenMint

| Field | v0 usage |
|-------|----------|
| Account | W2 ATELIER |
| NFTokenTaxon | `20260927` |
| Flags | `tfTransferable` (8) |
| TransferFee | `1000` (= 1%) |
| URI | hex of machine README raw GitHub URL |

## NFTokenCreateOffer / NFTokenAcceptOffer

- Sell offer: W2, `tfSellNFToken`, Amount = 1 XRP (trial).
- Accept: BUYER sets `NFTokenSellOffer` to offer index.

## Payment

Not submitted as a standalone Payment in v0 happy path; value moves via EscrowFinish (XRP → Destination) and NFT Amount on accept.
