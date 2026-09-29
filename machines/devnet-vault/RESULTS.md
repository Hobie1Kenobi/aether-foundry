# RESULTS — Devnet vault and loan

**Status:** live on XRPL Devnet id 2. One loan originated and repaid.  
**Network:** XRPL Devnet, id 2.  
**Accounting:** **cash-basis** (`LendingProtocolV1_1` enabled; ledger `LEVersion` 1). Accrual is not booked; interest is recognized when a payment delivers it.  
**Asset:** XRP (closed-ended vault, `VaultKind` 1).  
**First-loss:** D0 `LoanBrokerCoverDeposit` 0.2 XRP — **not** Testnet W6.  
**Box merge:** `e0224883f0de4e7e82ba78986bca7ad7434ca853` (PR #31).  
**Session:** 2026-09-28 ~21:57–22:01 CDT.

| Id | Value |
|----|-------|
| Vault id | `B5B7DD0567486B7D93CDE961B86B4B4107FE674E7F4EAE7CFF09BA13D8189992` |
| Broker id | `948E5B2D0662EA714E0D65AFE431DD4B8943D6D31307D75F45CADEFB90246D35` |
| Loan id | `4D6442A307F3D8B01E0A690CE9ADF3BBA5AF5E6B2EBD728379DC52F06C5678C1` |

Waited until `SubscriptionDate` (ripple epoch `843966048`) before `loan`. Closed by **repay** (`LoanPay`), not default.

| Step | Result | Ledger | Hash |
|------|--------|--------|------|
| VaultCreate | `tesSUCCESS` | `5694565` | `6C74EF78C4471CD473221402B6DB89F8F6CCFA7C2BE20EBA3E9C208DF12E5307` |
| VaultDeposit (D1, 5 XRP) | `tesSUCCESS` | `5694567` | `82CF1E27FFC82A4C201E0969641B01924A2B557B8B70BAFB6655FC42FB8DD1BD` |
| LoanBrokerSet | `tesSUCCESS` | `5694570` | `CA9441DEE6D811D9307B2B3E57DBBBA6AAF3D41FA52376A49137ED2B82CD6C26` |
| LoanBrokerCoverDeposit (D0) | `tesSUCCESS` | `5694572` | `BAC2633FB38BB045695A7F42DEE54FFFA4B6363D73437205BF80AC01067851E9` |
| LoanSet (principal 1 XRP) | `tesSUCCESS` | `5694624` | `E20352A8025E818770F7299891A7C7DFD478C07EAFB49AE50341E5D5EAD7B58B` |
| LoanPay (repay) | `tesSUCCESS` | `5694627` | `44DF969BC51E490A75CF443D3DD8829E1100C16447383568D3E794C49465A32B` |

Archive rows in `lab/frontier/devnet-ledger.jsonl`. Do not copy into Testnet desk NAV.
