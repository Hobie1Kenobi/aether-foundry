# RESULTS — Credential domain shop

**Network:** XRPL Testnet  
**Enforcement:** Credentials + PermissionedDomain + PermissionedDEX  
**domain_id:** null  
**Live:** no

Hashes below stay empty until `--live` returns them. A dry-run prediction is not a result.

## Amendment probe

The script reads `feature` on the same HTTP URL it would submit to. Committed map: `lab/frontier/amendments.json` (rippled 3.4.1, network id 1). That file does not authorize a submit by itself.

| Amendment | Enabled on the committed probe | Hash |
|-----------|--------------------------------|------|
| `Credentials` | yes | `1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF` |
| `PermissionedDomains` | yes | `A730EB18A9D4BB52502C898589558B4CCEB4BE10044500EE5581137A2E80E849` |
| `PermissionedDEX` | yes | `677E401A423E3708363A36BA8B3A7D019D21AC5ABD00387BDBEA6BDE4C91247E` |

## Ledger objects

| Step | Engine | Ledger | Hash |
|------|--------|--------|------|
| CredentialCreate `aether-agent` | | | |
| CredentialAccept | | | |
| PermissionedDomainSet | | | |
| Domain OfferCreate | | | |
| Uncredentialed OfferCreate | `tecNO_PERMISSION` expected | | |
| Credentialed take | | | |

`domain_id` in `lab/metrics.json` is null. `/api/status` returns null.

## Adversary — uncredentialed path

Documented for live verification. Not hashed in this pack.

An account that has not accepted `aether-agent` from W5 submits `OfferCreate` with this domain's `DomainID` and without `tfHybrid`. The expected engine result is `tecNO_PERMISSION`. The offer must not fill. A hash written here before that transaction is on the ledger would be invented.

The domain owner is not a valid stand-in for this case. W5 may place the shop offer without holding the credential.

## Open Walk-In

W2's public NFT sell offer is not modified. It has no `DomainID`. Buyers do not present `aether-agent`.
