# RESULTS — TokenEscrow labor

**Status:** template. No `EscrowCreate` hash yet.  
**Network:** XRPL Testnet, id 1. The scripts refuse any other id.  
**Amendment:** `TokenEscrow` must be `enabled: true` on the live `feature` call. The Day-1 map said it was enabled (hash `138B968F25822EFBF54C00F97031221C47B1EAB8321D93C7C2AEAF85F04EC5DF`). Re-probe before `--live`. Do not copy that sentence into a success row.

## Not on the ledger yet

| Field | Value |
|-------|--------|
| Asset | AETH until `mpt_issuance_id` is 48 hex, then `AETH-LABOR` |
| `mpt_issuance_id` | null in `lab/metrics.json` |
| Trial A create hash | null |
| Trial A `offer_sequence` | null |
| Trial A escrow index | null |
| Trial A `EscrowFinish` hash | null |
| Trial A Check hash | null |
| Trial B create hash | null |
| Trial B `EscrowCancel` hash | null |
| NFT mint hash | null. The deliverable is unsigned |

Times on any live row are Ripple Epoch. A `FinishAfter` above `1000000000` is a failed run, not a result.

## Trial A — finish (fill only after `tesSUCCESS`)

```json
{
  "ts": "",
  "action": "token_escrow_labor_create",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "destination": "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  "asset": "",
  "mpt_issuance_id": null,
  "hash": "",
  "offer_sequence": 0,
  "escrow_index": "",
  "finish_after": 0,
  "cancel_after": 0,
  "ledger_index": 0,
  "result": "tesSUCCESS"
}
```

```json
{
  "ts": "",
  "action": "token_escrow_labor_finish",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  "owner": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "hash": "",
  "offer_sequence": 0,
  "ledger_index": 0,
  "result": "tesSUCCESS"
}
```

```json
{
  "ts": "",
  "action": "token_escrow_labor_rebate",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
  "destination": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "drops": "",
  "hash": "",
  "ledger_index": 0,
  "result": "tesSUCCESS"
}
```

Leave the Check row blank when `rebate.tx` was null.

## Trial B — cancel (a second create)

```json
{
  "ts": "",
  "action": "token_escrow_labor_cancel",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "owner": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "hash": "",
  "offer_sequence": 0,
  "ledger_index": 0,
  "result": "tesSUCCESS"
}
```

The live commands append the same rows to `lab/ledger-log.jsonl`. Do not type a hash in here first.

## Commands that do not submit

```bash
npm run frontier:token-escrow-create
npm run frontier:token-escrow-finish -- --offer-sequence <n> --quoted <decimal>
npm run frontier:token-escrow-cancel -- --offer-sequence <n>
```

Credentials and Batch have no hash here.
