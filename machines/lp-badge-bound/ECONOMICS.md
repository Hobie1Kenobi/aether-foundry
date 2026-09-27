# ECONOMICS — LP Badge Bound

## Capital

| Item | Who pays | Notes |
|------|----------|-------|
| Faucet XRP | issuer, holder, door, stranger | Testnet faucet. Not W0–W6. |
| AETH buy | holder | Self-payment, `SendMax` 5 XRP, deliver 50 AETH through the existing AMM. |
| AMM deposit | holder | At most 40 AETH and 2 XRP. LP minted above the 1000 threshold. |
| AMM withdraw | holder | `tfWithdrawAll` returns both assets to the holder. Pool share comes back. |
| Door payment | holder | 0.1 XRP (`100000` drops) on the PASS. Stays on the door. |
| Failed payments | stranger, holder | `tecNO_PERMISSION` moves no Amount. Fees only. |

W1's 500000 LP is not deposited or withdrawn. The Foundry pool's seeded inventory stays put aside from this small round trip.

## Reserves

| Object | Owner after the trial |
|--------|------------------------|
| AETH trust line | holder, if the line remains |
| LP trust line | removed by a full withdraw when the balance hits zero |
| Credential | deleted. Reserve returns to the subject. |
| DepositPreauth | door, one owner reserve, left in place |
| DepositAuth | door flag, left in place |

## What it does not earn

The door is a gate, not a fee switch. The 0.1 XRP PASS is a proof payment, not a product price. AMM trading fee on the small buy/deposit/withdraw is the only pool skim, and it is the pool's existing fee.
