# ECONOMICS — Work-Ticket Escrow v0

## Who pays whom

| Flow | From | To | Amount | When |
|------|------|----|--------|------|
| NFT acquisition | BUYER | W2 | 1 XRP | NFTokenAcceptOffer |
| Work escrow lock | BUYER | Escrow object | 10 XRP (A) / 2 XRP (B) | EscrowCreate |
| Work release | Escrow | W4 | 10 XRP | EscrowFinish (Trial A) |
| Work refund | Escrow | BUYER | 2 XRP | EscrowCancel (Trial B) |
| Royalty (secondary) | buyer→seller path | W2 issuer | 1% TransferFee | future secondary sale |

## Fees (testnet)

- Each tx: base fee (~10 drops; open ledger may be higher).
- Negligible vs ticket size on testnet.

## Reserves

| Object | Owner reserve (verified 2026-09-27) |
|--------|-------------------------------------|
| Base account | 1 XRP |
| Per owner object | 0.2 XRP |
| Escrow object | +0.2 XRP on Owner (BUYER) while open |
| NFToken page | +0.2 XRP on holder |
| Offer | +0.2 XRP on offerer |

W4 as Destination does **not** need extra reserve to *receive* finished XRP; W4 needs reserve headroom only if it *creates* escrow objects. Session-2 W4 spendable ≫ 1 XRP — OK.

## Failure modes (economic)

| Failure | Capital effect |
|---------|----------------|
| Unix timestamp used as FinishAfter | Funds locked until Ripple-interpreted far future (~2056) — see THREAT / stuck escrow |
| Finish before FinishAfter | `tecNO_PERMISSION`; funds stay locked |
| Cancel before CancelAfter | fails; wait |
| W4 / BUYER unfunded for fee | finish/cancel cannot submit |
| NFT sell not accepted | ticket NFT remains with W2; escrow can still settle independently in v0 |

## AETH TokenEscrow — v0.1 SPEC ONLY (do not implement this session)

See `TOKENS.md`. Future: escrow AETH IOU (issuer W0) instead of XRP when TokenEscrow is available/desired on the connected network.
