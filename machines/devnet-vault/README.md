# F9 — Single-asset vault and one loan

**Status:** unsigned. No vault id until `VaultCreate` returns `tesSUCCESS`.  
**Network:** XRPL Devnet, network id **2** only.  
**Amendments:** `SingleAssetVault`, `LendingProtocol`, `LendingProtocolV1_1`.  
**Asset:** XRP. Not the Testnet `AETH-LABOR` issuance.  
**Owner:** D0. **Depositor and borrower:** D1. **First-loss:** D0 Devnet XRP, not Testnet W6.

`LendingProtocolV1_1` is on, so this vault is cash-basis. The pack does not choose accrual. The vault is closed-ended (`VaultKind` 1) because a loan under that amendment originates only in the investment window.

```bash
npm run frontier:devnet-vault
```

Steps: `create`, `deposit`, `broker`, `cover`, `loan`, then `repay` or `default`. See [`lab/frontier/DEVNET.md`](../../lab/frontier/DEVNET.md).
