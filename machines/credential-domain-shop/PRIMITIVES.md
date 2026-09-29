# PRIMITIVES — Credential domain shop

Three ledger objects, plus the offer that uses the third.

## 1. Credential `aether-agent`

| Field | Value |
|-------|-------|
| Amendment | `Credentials` `1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF` |
| Create | `CredentialCreate` from W5 |
| Accept | `CredentialAccept` from the subject |
| Type | ASCII `aether-agent` → `6165746865722D6167656E74` |
| URI | hex of this machine's README URL |
| Subject | a faucet account that is not in `WALLETS` |
| Not used | `aether-lp-ok` (`6165746865722D6C702D6F6B`). That type belongs to `machines/lp-badge-bound/` and is issued only while LP ≥ 1000. |

The credential index is the same keylet as the LP door: SHA-512 half of `uint16('D')` ‖ subject ‖ issuer ‖ raw type bytes. `lsfAccepted` (`0x00010000`) is set by `CredentialAccept`. A created credential that the subject has not accepted does not admit them to the domain.

## 2. PermissionedDomain

| Field | Value |
|-------|-------|
| Amendment | `PermissionedDomains` `A730EB18A9D4BB52502C898589558B4CCEB4BE10044500EE5581137A2E80E849` |
| Transaction | `PermissionedDomainSet` from W5, `DomainID` omitted on create |
| AcceptedCredentials | one entry: Issuer W5, CredentialType `aether-agent` |
| ID | SHA-512 half of `uint16('m')` = `0x006D`, owner AccountID, uint32 sequence of the create |

`0x0082` is the ledger-entry type code, not the keylet prefix. The script checks metadata `CreatedNode` `PermissionedDomain` `LedgerIndex` against that keylet. A mismatch is not archived.

## 3. PermissionedDEX offer

| Field | Value |
|-------|-------|
| Amendment | `PermissionedDEX` `677E401A423E3708363A36BA8B3A7D019D21AC5ABD00387BDBEA6BDE4C91247E` |
| Transaction | `OfferCreate` with `DomainID` |
| Flag refused | `tfHybrid` `0x00100000` |
| Shop offer | W5 sells `1` `AGT` (issuer = the faucet mint) for `20000` drops |
| Take | the other side, same `DomainID` |
| Book asset | `AGT` issued by the mint account, not AETH and not the Walk-In NFT |

The domain owner may place the offer without holding the credential. Everyone else must hold an accepted credential that the domain lists. `CredentialIDs` is not a field on this `OfferCreate`. The ledger reads the account's accepted credentials.

## What is not used

- No `NFTokenCreateOffer` and no edit to the W2 Walk-In sell offer.
- No Batch, Sponsor, or Vault transaction.
- No W0 master key.
- No mainnet host and no network id other than `1`.
