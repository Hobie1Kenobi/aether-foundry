# RESULTS — Credential domain shop

**Status:** live on XRPL Testnet id 1. Physics proved (credentialed take + uncredentialed `tecNO_PERMISSION`).  
**Network:** XRPL Testnet, id 1.  
**Enforcement:** Credentials + PermissionedDomain + PermissionedDEX  
**domain_id:** `6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4`  
**Live:** yes  
**Box merge:** `0def77633ae4e267c4d6d226af65900c1fca57b5` (PR #27 squash).  
**Session:** 2026-09-28 ~19:53 CDT. Issuer/domain/offer: W5 RegularKey. Agent/stranger/mint: faucet CDS accounts. Never W0.

## Amendment probe

Re-probed on the same HTTP URL before `--live`. Committed map: `lab/frontier/amendments.json` (rippled 3.4.1, network id 1).

| Amendment | Enabled | Hash |
|-----------|---------|------|
| `Credentials` | yes | `1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF` |
| `PermissionedDomains` | yes | `A730EB18A9D4BB52502C898589558B4CCEB4BE10044500EE5581137A2E80E849` |
| `PermissionedDEX` | yes | `677E401A423E3708363A36BA8B3A7D019D21AC5ABD00387BDBEA6BDE4C91247E` |

## Ledger objects

| Step | Engine | Ledger | Hash |
|------|--------|--------|------|
| CredentialCreate `aether-agent` | `tesSUCCESS` | `21130912` | `4857E2042EC5F9048B937FFF3A1B3A9FFB48A3868F6346648DFF74425E567644` |
| CredentialAccept | `tesSUCCESS` | `21130914` | `12358142E4C10E4466E2BCE864E3AD2C5ED1D400BEE7400452AB73120B152080` |
| PermissionedDomainSet | `tesSUCCESS` | `21130915` | `2E04E95DEAFCC6625BEAE4DFC744157B8E3D265FAC821FA449611FBB716C3C45` |
| Domain OfferCreate | `tesSUCCESS` | `21130917` | `EBFF74223586033C80E0069CC2BE7885AE6DC6CB5DF90CD7AC3388FE2A550B77` |
| Uncredentialed OfferCreate | `tecNO_PERMISSION` | `21130918` | `A1046BD20845D29E782FB9A83C82434CF87071707F9263DE06D908082E0B4A8E` |
| Credentialed take | `tesSUCCESS` | `21130920` | `A3A60DF94E038617547764742E130A63347139CD1FBC23E03AD91A2C76054EEE` |

`lab/metrics.json` `domain_id` is the 64-hex keylet above (matches PermissionedDomain metadata index). `/api/status` publishes that value. Dry-run `predicted_domain_id` was not written.

## Accounts (public)

| Role | Address |
|------|---------|
| Issuer (W5) | `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| Agent (credentialed) | `rDUj1USBUYVkfsP3zQPth5dRiSjMYmofwi` |
| Stranger (uncredentialed) | `rG91X9ECAZcr869v4Xw6kWY27m7UrcLqQp` |
| Mint (AGT faucet) | `rBtvREuwPH5qhrDkZknAZ9yTqqqUr5zPdG` |

Public book: `machines/credential-domain-shop/addresses.json`. Seeds stay in the secrets file only.

## Adversary — uncredentialed path

Live verified. Stranger `rG91X9ECAZcr869v4Xw6kWY27m7UrcLqQp` submitted `OfferCreate` with this domain's `DomainID` and without `tfHybrid`. Engine result `tecNO_PERMISSION`. The offer did not fill. Hash `A1046BD20845D29E782FB9A83C82434CF87071707F9263DE06D908082E0B4A8E` (ledger `21130918`).

The domain owner is not a stand-in for this case. W5 placed the shop offer without holding the credential.

## Credentialed take

Agent `rDUj1USBUYVkfsP3zQPth5dRiSjMYmofwi` (accepted `aether-agent` from W5) crossed the domain offer: sell `20000` drops for `1` AGT on DomainID `6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4`. Engine `tesSUCCESS`. Hash `A3A60DF94E038617547764742E130A63347139CD1FBC23E03AD91A2C76054EEE` (ledger `21130920`).

## Archive rows

```json
{
  "ts": "2026-09-29T00:52:04.464Z",
  "action": "credential_domain_shop",
  "step": "permissioned_domain_set",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  "hash": "2E04E95DEAFCC6625BEAE4DFC744157B8E3D265FAC821FA449611FBB716C3C45",
  "result": "tesSUCCESS",
  "ledger_index": 21130915,
  "domain_id": "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4",
  "credential_type": "aether-agent"
}
```

```json
{
  "ts": "2026-09-29T00:52:04.464Z",
  "action": "credential_domain_shop",
  "step": "uncredentialed_offer",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rG91X9ECAZcr869v4Xw6kWY27m7UrcLqQp",
  "hash": "A1046BD20845D29E782FB9A83C82434CF87071707F9263DE06D908082E0B4A8E",
  "result": "tecNO_PERMISSION",
  "ledger_index": 21130918,
  "domain_id": "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4",
  "credential_type": "aether-agent"
}
```

```json
{
  "ts": "2026-09-29T00:52:04.464Z",
  "action": "credential_domain_shop",
  "step": "credentialed_take",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rDUj1USBUYVkfsP3zQPth5dRiSjMYmofwi",
  "hash": "A3A60DF94E038617547764742E130A63347139CD1FBC23E03AD91A2C76054EEE",
  "result": "tesSUCCESS",
  "ledger_index": 21130920,
  "domain_id": "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4",
  "credential_type": "aether-agent"
}
```

Also in `lab/ledger-log.jsonl`: trust/fund steps plus CredentialCreate `4857E2042EC5F9048B937FFF3A1B3A9FFB48A3868F6346648DFF74425E567644` and CredentialAccept `12358142E4C10E4466E2BCE864E3AD2C5ED1D400BEE7400452AB73120B152080`.

## Open Walk-In

W2's public NFT sell offer was not modified. OfferID `CEAC38D14EBB2B544E59D78084ECAE1D52486BA29C53D248717CD42DB159654F` remains OPEN with no `DomainID`. Buyers do not present `aether-agent`.
