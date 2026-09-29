# Primitives — Devnet confidential MPT

| Item | Value |
|------|--------|
| Amendments | `DynamicMPT`, `ConfidentialTransfer`, `MPTokensV1` |
| Network | XRPL Devnet id 2 |
| Issuance | `MPTokenIssuanceCreate`, `TransferFee` 0, `tfMPTCanHoldConfidentialBalance`, `tifMPTCanHoldConfidentialBalance` |
| Keys | `IssuerEncryptionKey` only |
| Public funding | `Payment` of 100 to the sender and 1 to D3 |
| Register | `ConfidentialMPTConvert` of 1 by D3 (plaintext) |
| Pay | `ConfidentialMPTSend` to D3, amount not plaintext |
| Clawback | `ConfidentialMPTClawback` after `tfMPTLock` |
| Proof | `xrpl.prepareConfidential*`. No invented `ZKProof` |
| Refused | issuer as holder, sender equal to D3, Testnet labels, AETH-LABOR id, network id other than 2 |
