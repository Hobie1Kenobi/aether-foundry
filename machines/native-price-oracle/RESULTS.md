# RESULTS — Native Price Oracle

**Status:** dry-run shipped. No `OracleSet` submitted in this session.  
**Network:** XRPL Testnet, id 1, rippled 3.4.1.  
**Amendment:** `PriceOracle` enabled in `lab/frontier/amendments.json` (hash `96FD2F293A519AE1DB6F8BED23E4AD9119342DA7CB6BAFD00953D16C54205D8B`). That file is a probe, not a receipt.

## Not yet on the ledger

| Field | Value |
|-------|--------|
| OracleSet hash | — |
| `oracle_id` (`ledger_entry` index) | — |
| Ledger index | — |
| `quote_xrp_per_aeth` | — |
| W5 | `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| `OracleDocumentID` | `1` |

`lab/metrics.json` `oracle_id` and `last_oracle.hash` stay null until a `tesSUCCESS` row exists. This file does not contain a stand-in hash.

## Archive row (fill after the box run)

```json
{
  "action": "oracle_set",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  "oracle_document_id": 1,
  "quote_xrp_per_aeth": "",
  "hash": "",
  "oracle_id": "",
  "ledger_index": 0,
  "result": "tesSUCCESS"
}
```

Stranger reproduction, once `hash` is a real 64-hex id from the ledger:

1. `ledger_entry` the oracle (see RUNBOOK).
2. `quote = AssetPrice / 10^Scale`.
3. `labor_drops = round(quote × 1e6)` for one labor unit.
4. That integer is the ticket escrow `Amount`.

## Commands that do not submit

```bash
npm run frontier:oracle-set
npm run frontier:oracle-ticket
```
