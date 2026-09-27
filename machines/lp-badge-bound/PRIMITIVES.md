# PRIMITIVES — LP Badge Bound

## Feature gate

| Field | Value |
|-------|-------|
| Server | XRPL Testnet rippled (probed live; see RESULTS) |
| Credentials amendment | `1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF` |
| DepositAuth | `asfDepositAuth` = 9, ledger bit `lsfDepositAuth` = `0x01000000` |
| DepositPreauth field | `AuthorizeCredentials[].Credential.{Issuer,CredentialType}` |
| Payment field | `CredentialIDs` (the credential object index) |
| Hooks | not present as an enabled amendment. Not compiled. Not SetHook'd. |

The credential index is rippled's keylet: SHA-512 half of `uint16('D')` ‖ subject AccountID ‖ issuer AccountID ‖ raw credential-type bytes.

## AMM LP (existing pool)

| Field | Usage |
|-------|-------|
| AMM account | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| Asset | AETH `4145544800000000000000000000000000000000` issuer W0 |
| Asset2 | XRP |
| LP currency | `0330E60FAE706EAD2C7D511D790B07A6F3B89931` |
| Threshold | **1000** LP units |
| Deposit | `AMMDeposit` `tfTwoAsset`, max 40 AETH and max 2 XRP |
| Withdraw | `AMMWithdraw` `tfWithdrawAll` on the trial holder only |

1000 is the v1 door threshold. v0's 100000 figure described W1's seeded position. This trial does not move that position.

## Credential

| Field | Value |
|-------|-------|
| Type | ASCII `aether-lp-ok` → `6165746865722D6C702D6F6B` |
| URI | hex of the machine README URL plus `#lp-threshold=1000` |
| Accepted flag | `lsfAccepted` = `0x00010000` |
| Create | issuer, only when `account_lines` LP ≥ threshold |
| Delete | issuer, only when LP is below threshold |
| Accept | subject (the LP holder) |

## Door

`AccountSet` SetFlag 9, then `DepositPreauth` with exactly `AuthorizeCredentials` (no account `Authorize`). A payment to the door succeeds only when `CredentialIDs` names an accepted credential of that type. Omitting the id is `tecNO_PERMISSION`. After `CredentialDelete`, the same id is `tecBAD_CREDENTIALS`.

## What is not used

- No Hook, no `SetHook`, no wasm.
- No mainnet.
- No `Wallet.sign` in `web/`.
- W1's v0 NFToken is not burned, transferred, or treated as the gate.
