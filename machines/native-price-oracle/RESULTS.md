# RESULTS — Native Price Oracle

**Status:** live `OracleSet` on XRPL Testnet (`tesSUCCESS`).  
**Network:** XRPL Testnet, id 1, rippled 3.4.1.  
**Amendment:** `PriceOracle` enabled (hash `96FD2F293A519AE1DB6F8BED23E4AD9119342DA7CB6BAFD00953D16C54205D8B`).  
**Merge:** F1 squash `e4ff4fd77b95da7201bdce9328e776f8a63d1dd7` (PR #23).

## On the ledger

| Field | Value |
|-------|--------|
| OracleSet hash | `B11B0B87A7C40AFA98540D2F40FF234384466729F90E259E60162714DC4DDE85` |
| `oracle_id` (`ledger_entry` index) | `7CD1AB908C3A8D2E3C426E0D3083F4DD9A8A3A753AA60EB73682AA11A06DFA4E` |
| Ledger index | `21129718` |
| `quote_xrp_per_aeth` | `0.01022008` |
| `labor_drops` (1 unit) | `10220` |
| W5 | `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| `OracleDocumentID` | `1` |
| Wire `BaseAsset` | `4145544800000000000000000000000000000000` (AETH hex; 4-char ASCII is not codec-safe) |

## Archive row

```json
{
  "ts": "2026-09-28T23:45:58.839Z",
  "action": "oracle_set",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  "oracle_document_id": 1,
  "quote_xrp_per_aeth": "0.01022008",
  "hash": "B11B0B87A7C40AFA98540D2F40FF234384466729F90E259E60162714DC4DDE85",
  "oracle_id": "7CD1AB908C3A8D2E3C426E0D3083F4DD9A8A3A753AA60EB73682AA11A06DFA4E",
  "ledger_index": 21129718,
  "result": "tesSUCCESS"
}
```

Also written by the live keeper into `lab/ledger-log.jsonl` and `lab/metrics.json` (`oracle_id` / `last_oracle`).

## Stranger reproduction

```bash
curl -sS https://s.altnet.rippletest.net:51234 \
  -H 'content-type: application/json' \
  -d '{"method":"ledger_entry","params":[{"oracle":{"account":"rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ","oracle_document_id":1},"ledger_index":"validated"}]}'
```

1. `quote = AssetPrice / 10^Scale` → `0.01022008`.
2. `labor_drops = round(quote × 1e6)` → `10220` for one labor unit.
3. That integer is the ticket escrow `Amount`.

Verified: `npm run frontier:oracle-ticket` dry-run reads the same `oracle_id` via `ledger_entry` and prints `labor_drops` / escrow `Amount` `10220`. Live ticket mint was not run in this handoff.

## Operator notes (box)

1. CLI `npm run frontier:oracle-set -- --live` currently refuses with `STALE: refusing --live without director state` because the entrypoint does not load `lab/director-state.json` into `options.state` (tests inject it). Workaround: pass `state` from disk when calling `run()`.
2. Unsigned dry-run JSON uses `BaseAsset: "AETH"`; `ripple-binary-codec` / `xrpl` 5.3.0 rejects 4-char ASCII. Live submit must use AETH hex `4145544800000000000000000000000000000000` (matches IOU currency elsewhere). Follow-up should fix `buildOracleSet` + CLI state load.

## Commands that do not submit

```bash
npm run frontier:oracle-set
npm run frontier:oracle-ticket
```
