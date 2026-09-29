# F3 — TokenEscrow work ticket

**Status:** dry-run. Finish and cancel hashes stay null until the Foundry box submits.  
**Network:** XRPL Testnet, network id **1** only.  
**Payer:** W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw`  
**Destination:** W4 `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN`  
**Lock:** 1 `AETH-LABOR`, issuance `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED` (F2 create `1DDA337DD81833BEE768DED7E54889A4F92D5DC5958F75760417801909C02BCB`). 1 AETH issued by W0 only if that metrics id is absent.  
**Holder:** W2 already opted in, then W5 authorized (`MPToken` Flags `2`).  
**Time lock:** Ripple Epoch only.

Labor no longer waits on a native XRP `EscrowCreate`. The lock is a TokenEscrow. The deliverable is an NFT. If the oracle quote rises between create and finish, W6 offers a Check for the drift.

```mermaid
sequenceDiagram
  participant Box as Foundry box
  participant L as XRPL Testnet
  participant W4 as W4 escrow desk

  Box->>L: feature TokenEscrow must be enabled
  Box->>L: EscrowCreate 1 MPT or 1 AETH, Ripple Epoch times
  Note over Box: NFTokenMint URI is printed, not submitted
  W4->>L: EscrowFinish after FinishAfter
  Note over L: Check from W6 only if the oracle quote rose
  Box->>L: EscrowCancel after CancelAfter, separate create
```

## Commands

```bash
npm run frontier:token-escrow-create
npm run frontier:token-escrow-finish -- --offer-sequence <create sequence>
npm run frontier:token-escrow-cancel -- --offer-sequence <create sequence>
```

All three default to dry-run. `--live` is Foundry-box only (`FOUNDRY_DAEMON_LIVE=yes`). CI refuses it. See RUNBOOK.

## Which asset

`mpt_issuance_id` is read from `--issuance-id` or from `lab/metrics.json`. The committed field is `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED`, so a dry-run locks that MPT: `Amount` is `{ "mpt_issuance_id", "value": "1" }`. A null field selects the AETH IOU (`currency` the 40-hex `AETH`, `issuer` W0, `value` `"1"`). A 64-hex ledger index is refused. The dry-run does not invent an id, and it does not write one.

## Non-goals

- No XRP `Amount` string. That is the old work-ticket lock, and the Unix scar.
- No `Condition` / `Fulfillment`. That is a later pack.
- No Credentials, PermissionedDomain, or Batch.
- No sequential stand-in when `TokenEscrow` is disabled. The JSON is `tx: null`.
- The desk does not submit. `W0` does not sign.
