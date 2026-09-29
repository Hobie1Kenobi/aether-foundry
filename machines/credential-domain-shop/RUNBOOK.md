# RUNBOOK — Credential domain shop

Foundry box. Secrets in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`, mode 600. Never print them. Never run `--live` in GitHub Actions.

## Probe only

```bash
npm run frontier:credential-domain-shop
```

Connects to XRPL Testnet HTTP, prints network id `1`, and prints whether `Credentials`, `PermissionedDomains`, and `PermissionedDEX` are enabled. Exit 0 prints unsigned transactions. Exit 2 means an amendment is missing or disabled: `steps` is null and nothing is signed.

`domain_id` in that JSON is null. `predicted_domain_id` is the keylet of W5's current sequence when `account_info` returned one. Do not paste it into `lab/metrics.json`.

Shape accounts (`accounts_are_shape: true`) are classic addresses derived from fixed public bytes so the unsigned JSON has subjects. They are not funded. `--live` faucets replacements.

The adversary object is the uncredentialed `OfferCreate`. `expected_engine` is `tecNO_PERMISSION`. `live_verified` is false. `hash` is null.

## Live

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:credential-domain-shop -- --live
```

Refuses `CI` and `GITHUB_ACTIONS`. Refuses network id other than 1. Loads `W5_REGULAR_SEED` for W5. Faucets the agent, the stranger, and the mint on first run, writes those seeds only to the secrets file, and writes public addresses to `addresses.json`.

Sequence:

1. TrustSet `AGT` from W5, the agent, and the stranger, limit `100`.
2. Mint pays `5` `AGT` to each of those three so a missing balance is not the refusal.
3. `CredentialCreate` (`aether-agent`) and `CredentialAccept`.
4. `PermissionedDomainSet` with that one accepted credential.
5. W5 `OfferCreate` with `DomainID`, no `tfHybrid`: sell `1` `AGT` for `20000` drops.
6. Stranger `OfferCreate` on the same domain. Expect `tecNO_PERMISSION`.
7. Agent `OfferCreate` crossing the shop offer. Expect `tesSUCCESS`.

On success the script sets `lab/metrics.json` `domain_id` from the `PermissionedDomain` metadata index, and only when that index equals the keylet. It does not write the dry-run prediction. It does not touch the W2 Walk-In offer.

## What the script refuses

- `CI=true` or `GITHUB_ACTIONS=true` before a seed read
- `--live` without `FOUNDRY_DAEMON_LIVE=yes`
- Hosts other than XRPL Testnet, and network id other than `1`
- Any of the three amendments disabled, omitted, or under a different hash
- `W0_SEED`, `TREASURY_SEED`, and any transaction whose `Account` is W0
- `aether-lp-ok`, `tfHybrid`, `NFTokenCreateOffer`, Batch, Sponsor, and Vault types
- Archiving a domain id that does not match the keylet
- Treating a `tesSUCCESS` uncredentialed offer as a pass
