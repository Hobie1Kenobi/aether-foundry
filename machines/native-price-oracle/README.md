# F1 — Native Price Oracle (`OracleSet`)

**Status:** dry-run keeper. No Oracle object hash until the Foundry box submits.  
**Network:** XRPL Testnet, network id **1** only.  
**Account:** W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`  
**Document:** `OracleDocumentID` **1**  
**Pair:** base `AETH`, quote `XRP` (XRP per AETH), scale **8**

Machine #4 (`oracle-mid-ticket`) froze a composite mid into an NFT URI. That attestation was honor-system: the ledger stored the operator's text. This pack replaces that attestation with a native `Oracle` object. The keeper still reads `amm_info` and `book_offers`. The work-ticket reads `ledger_entry` and prices from that object.

```mermaid
sequenceDiagram
  participant Box as Foundry box (W5 RegularKey)
  participant AMM as amm_info
  participant Book as book_offers
  participant L as XRPL Testnet
  participant Stranger

  Box->>L: feature PriceOracle must be enabled
  Box->>AMM: AETH/XRP spot
  Box->>Book: best bid and best ask
  Box->>L: OracleSet document 1 (dry-run unless --live)
  Stranger->>L: ledger_entry oracle account+document
  Stranger->>Stranger: quote = AssetPrice / 10^Scale
  Stranger->>Stranger: labor drops = round(quote × units × 1e6)
```

## Commands

```bash
npm run frontier:oracle-set
npm run frontier:oracle-ticket
```

Both default to dry-run. `--live` is Foundry-box only (`FOUNDRY_DAEMON_LIVE=yes`). CI refuses it. See RUNBOOK.

## Quote

```
spot_amm = pool_xrp / pool_aeth
mid_clob = (best_bid + best_ask) / 2
quote    = 0.7 * spot_amm + 0.3 * mid_clob
```

If either CLOB side is empty, `quote = spot_amm` and the run flags `clob_thin`. The published figure is that quote rounded to scale 8. A stranger reproduces the ticket from the rounded oracle price, not from a second AMM read.

## Non-goals

- No Batch, TokenEscrow, or vault stand-in.
- No MPT labor unit (that is F2).
- The desk does not submit `OracleSet`.
- `W0` does not sign.
