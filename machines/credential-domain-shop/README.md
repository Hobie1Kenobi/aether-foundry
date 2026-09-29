# F4 — Credential domain shop

**Status:** dry-run. `domain_id` is null until `PermissionedDomainSet` returns a domain object.  
**Network:** XRPL Testnet, network id **1** only.  
**Issuer / domain owner:** W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`, signed with `W5_REGULAR_SEED`.  
**Credential type:** `aether-agent`.  
**Open Walk-In:** unchanged. W2's public NFT sell offer is not this counter.

LP-badge-bound was the door: an accepted `aether-lp-ok` credential, checked against AMM LP, then a DepositPreauth payment. This shop is the next room. W5 issues `aether-agent`, the subject accepts it, and a permissioned domain lists that credential. Offers inside the domain are `OfferCreate` with `DomainID`. They are not hybrid, so the open DEX cannot take them. A credentialed stranger can cross the offer. An uncredentialed account is refused by the ledger.

```mermaid
sequenceDiagram
  participant Box as Foundry box (W5 RegularKey)
  participant Agent as Credentialed stranger
  participant Bare as Uncredentialed account
  participant L as XRPL Testnet

  Box->>L: feature Credentials, PermissionedDomains, PermissionedDEX
  Box->>Agent: CredentialCreate aether-agent
  Agent->>L: CredentialAccept
  Box->>L: PermissionedDomainSet requiring that credential
  Box->>L: OfferCreate DomainID (no tfHybrid)
  Bare->>L: OfferCreate DomainID → tecNO_PERMISSION
  Agent->>L: OfferCreate DomainID → tesSUCCESS
  Note over L: W2 Walk-In NFT sell offer stays public
```

## Commands

```bash
npm run frontier:credential-domain-shop
FOUNDRY_DAEMON_LIVE=yes npm run frontier:credential-domain-shop -- --live
```

Dry-run is the default. It does not read a seed. `--live` is the Foundry box. CI refuses it. See RUNBOOK.

## What the id is

`domain_id` is the 64-hex keylet of the `PermissionedDomain`: SHA-512 half of `uint16('m')` (`0x006D`), the owner AccountID, and the sequence of the create transaction. A dry-run may print `predicted_domain_id` from W5's current sequence. That prediction is not archived. `/api/status` reads `lab/metrics.json` and returns null until a live create writes the metadata index.

## Non-goals

- No change to the public Walk-In NFT offer.
- No `aether-lp-ok` on this domain. That type is the LP door and this shop does not read LP.
- No `tfHybrid`. The offer must not rest on the open book.
- No Batch, Sponsor, Vault, or T54 facilitator.
- W0 does not sign. The desk does not sign.
