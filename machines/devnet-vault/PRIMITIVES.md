# Primitives — Devnet vault and loan

| Item | Value |
|------|--------|
| Amendments | `SingleAssetVault`, `LendingProtocol`, `LendingProtocolV1_1` |
| Network | XRPL Devnet id 2 |
| Asset | `{ "currency": "XRP" }` |
| Vault | `VaultCreate`, `VaultKind` 1, no `Scale` |
| Accounting | cash-basis (`LEVersion` 1) because V1_1 is enabled |
| Deposit | `VaultDeposit` 5000000 drops from D1 |
| Broker | `LoanBrokerSet`, `CoverRateMinimum` 10000 |
| First-loss | `LoanBrokerCoverDeposit` 200000 drops from D0 |
| Loan | `LoanSet`, principal 1000000 drops, D1 counter-signs |
| Repay | `LoanPay`, amount from `PeriodicPayment` |
| Default | `LoanManage`, `tfLoanDefault` |
| Refused | Testnet id 1, mainnet, AETH-LABOR issuance id |
