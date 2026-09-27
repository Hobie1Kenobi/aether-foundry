# THREAT — LP Badge Bound (Adversary sign-off)

## Shipped path is not honor-system

**Adversary claim against v0:** an NFTokenID is not coupled to an LP trust line. Withdraw LP, keep waving the badge, and any verifier that only calls `account_nfts` says PASS.

**v1 answer:** the privilege is a payment into the guild door. The ledger evaluates it.

- Stranger, no credential: `tecNO_PERMISSION`.
- Holder, credential accepted, `CredentialIDs` present, LP ≥ 1000: `tesSUCCESS`.
- Holder, same id, after `AMMWithdraw` and issuer `CredentialDelete`: `tecBAD_CREDENTIALS` (the object is gone). A payment that simply omits `CredentialIDs` is `tecNO_PERMISSION`.

A script that only holds the v0 NFT, or that replays the deleted credential id, does not get through the door. No off-chain "LP ≥ N and NFT present" check is the gate. `DepositPreauth` is.

The v0 NFT on W1 (`000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C`) is still unbound. It is a souvenir. Do not point a discount at it.

## Residual issuer window

`CredentialDelete` is a transaction the issuer signs after reading `account_lines`. rippled does not read the LP balance inside `DepositPreauth`. Between `AMMWithdraw` and `CredentialDelete`, a still-accepted credential would pass.

That window is the XLS-70 issuer-trust assumption (the issuer must actually delete). It is not the v0 model, where nothing on the ledger can fail the wave. The trial deletes in the same session, immediately after the withdraw, and records both hashes.

A same-execution LP read would be a Hook on a ledger that has the LP. XRPL Testnet's `feature` map has no enabled Hooks amendment. This cut does not pretend otherwise and does not move the AMM to Xahau.

## Wrong credential id

`CredentialIDs` must be this subject's accepted object. Omitting it fails with `tecNO_PERMISSION` even while the credential exists. Presenting the id after `CredentialDelete` fails with `tecBAD_CREDENTIALS`. Both are in RESULTS.

## DepositAuth stuck-account exception

A payment to an account whose balance is at or below the reserve can bypass DepositAuth when no credentials are attached. The door is faucet-funded far above reserve, and the PASS leaves it further above. Do not drain the door to the reserve.

## Threshold

v1 uses 1000 LP units so the proof does not withdraw W1 or move ~20% of the pool. The comparison is decimal, not `Number`, and a missing line is `0`.

## Seeds

Seeds only in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`, mode 600. The trial refuses `CI` and `GITHUB_ACTIONS`. Public records reject seed-shaped strings.
