# RUNBOOK — Native Price Oracle

**Default:** dry-run. **Network:** XRPL Testnet id 1. **Signer:** Foundry box, W5 regular key. Never W0. Never a Vercel env.

## 1. Probe

```bash
npm run director:snapshot
npm run frontier:probe
```

Read `lab/frontier/amendments.json`. `PriceOracle` must be `enabled: true` and `network_id` must be `1`. If it is disabled, stop. Do not submit `OracleSet`. Do not fake it with a memo.

The keeper also calls `feature` itself and refuses when that live row is disabled.

## 2. Dry-run the keeper

```bash
npm run frontier:oracle-set
```

Expect JSON with `"mode": "dry-run"`, `"signed": false`, `"key_loaded": false`, `"network_id": 1`, and an unsigned `OracleSet`:

- `Account` = W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`
- `OracleDocumentID` = `1`
- `PriceDataSeries[0].PriceData` base `AETH`, quote `XRP`, `Scale` 8
- `LastUpdateTime` = current UNIX seconds

`key_env` is the name `W5_REGULAR_SEED`. The process must not print a seed. Exit 0 when the amendment is on. Exit 2 with `"tx": null` when `PriceOracle` is off.

## 3. Publish (Foundry box only)

On the box, with the regular-key env loaded outside git:

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:oracle-set -- --live
```

This refuses `CI` and `GITHUB_ACTIONS`. It signs with `W5_REGULAR_SEED` and checks the address against W5's `regular_key` in `lab/director-state.json`. It does not go through MCP `sign_tx`.

Intent name for a future allowlist row: `oracle_set`. That row is not in `src/runtime/allowlist.json` yet. Leave it off the agent signer until an operator adds `OracleSet` to `tx_types` and `AGENT_TX_TYPES` on purpose.

Suggested clock: every 20 ledgers. One-shot is enough for the first object. `LastUpdateTime` must move forward and stay within 300 seconds of the ledger close, so do not replay a stale dry-run JSON.

## 4. Stranger check

```bash
curl -sS https://s.altnet.rippletest.net:51234 \
  -H 'content-type: application/json' \
  -d '{"method":"ledger_entry","params":[{"oracle":{"account":"rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ","oracle_document_id":1},"ledger_index":"validated"}]}'
```

Decode `AssetPrice` (hex or decimal integer) and `Scale`:

```
quote_xrp_per_aeth = AssetPrice / 10^Scale
labor_drops = round(quote_xrp_per_aeth × labor_units × 1_000_000)
```

`labor_units` defaults to 1. The response field `index` is `oracle_id`.

Then:

```bash
npm run frontier:oracle-ticket
```

The printed `ticket.labor_drops` and `ticket.escrow.Amount` must equal that `labor_drops`. The script's only price RPC is `ledger_entry`. `FinishAfter` is Ripple Epoch (well below 1e9). The purchaser signs `EscrowCreate`; the dry-run leaves `Account` off that object.

## 5. Optional mint

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:oracle-ticket -- --live
```

Submits the W2 `NFTokenMint` only (`W2_REGULAR_SEED`). The sell offer and the escrow stay in the JSON for the purchaser. Do not run this from Actions.

## 6. Archive after `tesSUCCESS`

Paste the real hash into RESULTS. Shape:

```json
{"ts":"","action":"oracle_set","network":"XRPL Testnet","network_id":1,"account":"rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ","oracle_document_id":1,"quote_xrp_per_aeth":"","hash":"","oracle_id":"","ledger_index":0,"result":"tesSUCCESS"}
```

`npm run frontier:oracle-set -- --live` appends that row to `lab/ledger-log.jsonl` and sets `lab/metrics.json` `oracle_id` / `last_oracle` from the same hash. `/api/status` prefers the live `ledger_entry` and uses those lab fields only when the object is not on the validated ledger yet.

Do not invent the hash in git before the box has one.
