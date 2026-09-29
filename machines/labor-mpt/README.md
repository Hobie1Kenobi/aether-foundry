# F2 — Labor MPT (`MPTokenIssuanceCreate`)

**Status:** dry-run issuance. `mpt_issuance_id` stays null until the Foundry box submits.  
**Network:** XRPL Testnet, network id **1** only.  
**Issuer:** W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`  
**First holder:** W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw`  
**Symbol:** `AETH-LABOR` (XLS-89 name). Ticker `LABOR` (the ticker field is A–Z and digits, six characters).  
**Cap:** `1000000` whole units. Scale `0`.

AETH issued by W0 stays the AMM pair. Labor is a separate MPT so transfer, escrow, clawback, and holder auth are issuance flags. This pack creates the issuance and authorizes one holder. It does not finish or cancel a TokenEscrow. That is F3.

```mermaid
sequenceDiagram
  participant Box as Foundry box (W5 RegularKey)
  participant L as XRPL Testnet
  participant W2 as W2 holder

  Box->>L: feature MPTokensV1 must be enabled
  Box->>L: MPTokenIssuanceCreate AETH-LABOR (dry-run unless --live)
  Box->>L: MPTokenAuthorize Holder W2
  W2->>L: MPTokenAuthorize opt-in
  Note over L: TokenEscrow of the MPT is F3
  Note over W2: NFT receipt is documented, not submitted
```

## Commands

```bash
npm run frontier:mpt-labor-create
npm run frontier:mpt-labor-authorize -- --issuance-id <48 hex>
```

Both default to dry-run. `--live` is Foundry-box only (`FOUNDRY_DAEMON_LIVE=yes`). CI refuses it. See RUNBOOK.

## What the id is

`mpt_issuance_id` is the 192-bit `MPTokenIssuanceID`: eight hex characters of the create transaction's sequence, then the issuer's 20-byte account id. It is not the 64-hex ledger index. The desk field stays null until `lab/metrics.json` has one from `tesSUCCESS`. A dry-run may print `predicted_mpt_issuance_id` from the current account sequence. That prediction is not archived.

## Non-goals

- No TokenEscrow finish or cancel (F3).
- No Credentials or PermissionedDomain (F4).
- No `ImmutableFlags` (`DynamicMPT` is disabled).
- No confidential balance (`ConfidentialTransfer` is disabled).
- No DEX/AMM flag. AETH stays the pool.
- The desk does not submit. `W0` does not sign.
