# F10 — Confidential MPT

**Status:** unsigned. No issuance id, payment hash, or clawback hash.  
**Network:** XRPL Devnet, network id **2** only.  
**Amendments:** `DynamicMPT`, `ConfidentialTransfer`, `MPTokensV1`.  
**Issuer:** D0. **Payee:** D3. **Sender:** a Devnet holder that is not D0 or D3.

The issuance can hold a confidential balance, and that flag is immutable. `TransferFee` is 0. The public payment that funds the sender, and the 1-unit convert that registers D3's key, show their amounts. The confidential payment does not. The clawback publishes the plaintext total it burns.

A public observer cannot read the send amount. The issuer can still prove the mirror with `D0_ELGAMAL_SEED`, and D3 can prove a receipt with `D3_ELGAMAL_SEED`. No auditor key is registered.

```bash
npm run frontier:devnet-confidential
```

See [`lab/frontier/DEVNET.md`](../../lab/frontier/DEVNET.md).
