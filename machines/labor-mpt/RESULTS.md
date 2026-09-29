# RESULTS — Labor MPT

**Status:** template. No `MPTokenIssuanceCreate` hash yet.  
**Network:** XRPL Testnet, id 1. The create script refuses any other id.  
**Amendment:** `MPTokensV1` must be `enabled: true` on the live `feature` call. The Day-1 map said it was enabled (hash `950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38`). Re-probe before `--live`. Do not copy that sentence into a success row.

## Not on the ledger yet

| Field | Value |
|-------|--------|
| `MPTokenIssuanceCreate` hash | null |
| `mpt_issuance_id` | null |
| Issuer | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| Holder | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Symbol | `AETH-LABOR` |
| Cap | `1000000` |
| `MPTokenAuthorize` hash | null |
| Holder opt-in hash | null |

`lab/metrics.json` `mpt_issuance_id` is null. `/api/status` reads that field and does not invent one.

## Archive row (fill only after `tesSUCCESS`)

```json
{
  "ts": "",
  "action": "mpt_labor_create",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  "symbol": "AETH-LABOR",
  "ticker": "LABOR",
  "maximum_amount": "1000000",
  "hash": "",
  "mpt_issuance_id": "",
  "ledger_index": 0,
  "result": "tesSUCCESS"
}
```

The live create command appends that row to `lab/ledger-log.jsonl` and sets `mpt_issuance_id` from transaction metadata. Leave the blanks blank until then.

## Commands that do not submit

```bash
npm run frontier:mpt-labor-create
npm run frontier:mpt-labor-authorize -- --issuance-id <48 hex>
```

TokenEscrow finish and cancel are F3. Credentials are F4. Neither has a hash here.
