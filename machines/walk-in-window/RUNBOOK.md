# RUNBOOK — Walk-In Window

**Network:** XRPL Testnet `wss://s.altnet.rippletest.net:51233`  
**Script:** `node src/walk-in-window-session.js`

## Preconditions

1. Secrets `.env` has W0–W3 seeds (mode 600), outside git.
2. AMM AETH/XRP live at `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`.
3. Do **not** use BUYER as purchaser.

## Steps

1. `client.fundWallet()` → append `STRANGER_SEED` / `STRANGER_ADDRESS` to secrets; address → `corp/wallets.md`.
2. STRANGER `TrustSet` AETH (issuer W0).
3. `ripple_path_find` then `Payment` Amount=50 AETH, SendMax XRP, Paths set.
4. W2 `NFTokenMint` (taxon 20260927, TransferFee 1000, URI = this machine README raw URL).
5. W2 `NFTokenCreateOffer` sell (~10 XRP).
6. **STRANGER** `NFTokenAcceptOffer`.
7. Optional: W0 `CheckCreate` 2 XRP → STRANGER; STRANGER `CheckCash`.
8. Publish `public/xrp-ledger.toml`; verify W0 DID URI still → charter.
9. Archive session note + ledger-log; commit; push.

## Verify

- `account_nfts` on STRANGER shows walk-in NFTokenID.
- `account_lines` shows ~50 AETH.
- Explorer: https://testnet.xrpl.org
