# RESULTS — Devnet confidential MPT

**Status:** unsigned.  
**Network:** XRPL Devnet, id 2.  
**Issuance id / payment hash / clawback hash:** none.

The public ledger, once this runs, will show the issuance flags, the issuer encryption key, the public payment amounts, the plaintext convert amounts, the send's accounts, and the clawback's plaintext `MPTAmount`. It will not show the confidential send amount or the holder ciphertext balances. A grant can still be proved with the issuer or D3 ElGamal key. No auditor ciphertext is registered. A self-payment is not a counterparty.

| Step | Result | Hash |
|------|--------|------|
| MPTokenIssuanceCreate | — | — |
| MPTokenIssuanceSet keys | — | — |
| ConfidentialMPTSend to D3 | — | — |
| ConfidentialMPTClawback | — | — |
