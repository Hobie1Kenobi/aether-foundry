# RESULTS — Labor MPT

**Status:** live on XRPL Testnet id 1.  
**Network:** XRPL Testnet, id 1.  
**Amendment:** `MPTokensV1` enabled (hash `950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38`). Re-probed before `--live`.  
**Box merge:** `610c961095f84ab006a0f7057f12071e73aa3c1c` (PR #25 squash).  
**Session:** 2026-09-28 ~19:06 CDT. Signer: W5 RegularKey (create + issuer authorize). Holder opt-in: W2 RegularKey. Never W0.

## On the ledger

| Field | Value |
|-------|--------|
| `MPTokenIssuanceCreate` hash | `1DDA337DD81833BEE768DED7E54889A4F92D5DC5958F75760417801909C02BCB` |
| `mpt_issuance_id` | `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED` |
| Create ledger index | `21130079` |
| Issuer | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| Holder | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| Symbol | `AETH-LABOR` |
| Cap | `1000000` |
| Flags | `108` (RequireAuth \| CanEscrow \| CanTransfer \| CanClawback) |
| Holder opt-in hash | `B46088B6AF5E5F7457718F9733D47E9D12A23B195EF1180A80664F20C8368452` |
| Issuer `MPTokenAuthorize` hash | `79BFF663AB029843FCE293C3049E516D28A5AE7FA756F5E44EB57A801EEBA8FF` |

`lab/metrics.json` `mpt_issuance_id` is the 48-hex id above. Stranger check: `ledger_entry` `mpt_issuance` → `MPTokenIssuance`, metadata `n`=`AETH-LABOR`, `MaximumAmount`=`1000000`. W2 `account_objects` type `mptoken` shows one `MPToken` for that issuance (authorized after issuer approve).

**Order note:** issuer authorize before holder opt-in returns `tecOBJECT_NOT_FOUND` (`2EF521755BCF81A4320BE57EF05B3AE73E2AA3C4B77788CD20F6739DA4260BA9`). Protocol requires holder opt-in first, then issuer authorize when `tfMPTRequireAuth` is set.

## Archive row (create)

```json
{
  "ts": "2026-09-29T00:06:16.433Z",
  "action": "mpt_labor_create",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  "symbol": "AETH-LABOR",
  "ticker": "LABOR",
  "maximum_amount": "1000000",
  "hash": "1DDA337DD81833BEE768DED7E54889A4F92D5DC5958F75760417801909C02BCB",
  "mpt_issuance_id": "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED",
  "ledger_index": 21130079,
  "result": "tesSUCCESS"
}
```

Also in `lab/ledger-log.jsonl`: opt-in `B46088B6…368452` (ledger `21130095`) and issuer authorize `79BFF663…EBA8FF` (ledger `21130097`).

## Ops fix used on box

`src/runtime/daemon.js` did not export `loadState`; F2 `--live` paths call `daemon.loadState`. Exported `loadState` so create/authorize can load director state.

## Not this pack

TokenEscrow finish and cancel are [`machines/token-escrow-labor/`](../token-escrow-labor/). Credentials are F4. Neither has a hash here.
