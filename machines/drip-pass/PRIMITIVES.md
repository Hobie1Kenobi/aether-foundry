# PRIMITIVES — Drip Pass

## NFTokenMint / Offer / Accept

Same pattern as Artifact #1 (work-ticket-escrow):

| Field | Usage |
|-------|-------|
| Account | W2 ATELIER |
| NFTokenTaxon | `20260927` |
| Flags | `tfTransferable` |
| TransferFee | `1000` (1%) |
| URI | hex of this machine README raw URL |
| Sell | W2 `NFTokenCreateOffer` + `tfSellNFToken`, Amount 1 XRP |
| Accept | BUYER `NFTokenAcceptOffer` |

## PaymentChannelCreate

| Field | Usage |
|-------|-------|
| Account | BUYER (source / funder) |
| Destination | W3 CHANNELS |
| Amount | XRP drops (e.g. 16 XRP) |
| SettleDelay | seconds (e.g. 30) before forced close refunds remainder |
| PublicKey | BUYER public key (claim signature verifier) |

Creates a `PayChannel` ledger object; channel ID = LedgerIndex.

## PaymentChannelClaim (drip)

| Field | Usage |
|-------|-------|
| Account | W3 (destination claims) |
| Channel | channel ID |
| Balance | cumulative claimed drops (on-ledger delivered total) |
| Amount | authorized cumulative drops (must match signed claim) |
| Signature | `xrpl.signPaymentChannelClaim(channel, xrpAmount, privateKey)` from BUYER |
| PublicKey | BUYER public key |
| Memos | UTF-8 → hex; references `lab/drip/000N.md` + content hash prefix |

Claims are **cumulative**: 2, then 4, then 6 XRP authorized.

## PaymentChannelClaim (close / settle)

| Step | Who | Flags |
|------|-----|-------|
| Request close | W3 or BUYER | `tfClose` (0x00020000) |
| After SettleDelay | BUYER (source) | `tfClose` again → destroy channel, refund unclaimed XRP |

Do not confuse with Escrow FinishAfter — channel times are SettleDelay seconds from close request, not Ripple Epoch fields (channel create has no FinishAfter).
