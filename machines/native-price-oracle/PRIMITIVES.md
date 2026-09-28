# PRIMITIVES — Native Price Oracle

Three ledger objects, plus the two reads that feed the keeper.

## 1. Oracle (created by `OracleSet`)

| Field | v0 |
|-------|----|
| Account / Owner | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| `OracleDocumentID` | `1` |
| `Provider` | ASCII hex of `aether-foundry` |
| `AssetClass` | ASCII hex of `currency` |
| `URI` | hex of this pack's README on `main` |
| `LastUpdateTime` | **UNIX seconds**. The PriceOracle amendment requires it, within 300 seconds of the ledger close. This is not an Escrow time lock. |
| `BaseAsset` / `QuoteAsset` | `AETH` / `XRP` |
| `Scale` | `8` |
| `AssetPrice` | hex integer, `quote = AssetPrice / 10^8` |

A stranger fetches it with:

```json
{
  "method": "ledger_entry",
  "params": [{
    "oracle": {
      "account": "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
      "oracle_document_id": 1
    },
    "ledger_index": "validated"
  }]
}
```

The response `index` is `oracle_id`.

## 2. AMM pool (`amm_info`)

Pool `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`. Asset AETH issued by W0, asset2 XRP. `spot_amm = XRP / AETH`. Validated ledger only.

## 3. CLOB (`book_offers`)

| Side | taker_gets | taker_pays |
|------|------------|------------|
| Asks | AETH/W0 | XRP |
| Bids | XRP | AETH/W0 |

Best ask is the minimum XRP-per-AETH. Best bid is the maximum. Empty side → AMM weight 1.

## 4. Work-ticket priced from the oracle

| Object | Who signs | Amount |
|--------|-----------|--------|
| `NFTokenMint` | W2, taxon `20260927`, TransferFee `1000` | URI carries `oracle`, `quote`, `ledger`, `doc` |
| `NFTokenCreateOffer` | W2 sell, no Destination | `Amount` = labor drops from the oracle |
| `EscrowCreate` | the purchaser, not the keeper | Destination W4, `Amount` the same drops, `FinishAfter` / `CancelAfter` in **Ripple Epoch** |

The ticket script does not call `amm_info`. If `ledger_entry` returns `entryNotFound`, it exits and does not invent a price.
