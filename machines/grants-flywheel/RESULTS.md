# Machine: grants-flywheel — RESULTS

**Network:** XRPL Testnet  
**Payer:** W6 `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf`  
**Status:** operational. No live grant hash yet.

`npm run grants:scan` and `npm run grants:pay -- --dry-run` are the trial until the Foundry box signs. This file stays free of invented hashes. `npm run grants:pay -- --record` appends a table here only after a real `tesSUCCESS`.

| Field | Value |
|-------|--------|
| Default drops | `1000000` |
| Experiment | `grants-flywheel` |
| Purpose | `aether-grant` |
| Grant hash | none |

No seeds in this file.

## Metrics

`npm run grants:pay -- --record` refreshes `lab/metrics.json` after the public append. `last_grant_hash` is the hash in the Grant section below, read back from `lab/ledger-log.jsonl`. This note does not add a second hash.

## Grant 2026-09-27T22:36:35.521Z

W6 paid a non-labeled counterparty. Recorded only after `tesSUCCESS`.

| Field | Value |
|-------|-------|
| Destination | `rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN` |
| Reason | `walk_in_acceptor` |
| Drops | `1000000` |
| Hash | `FEBC8E121880DC3A931233A69667235BC070AE77EE2B93E8AD50952E0EC7C2A2` |
| Signer | `regular` |
| Experiment | `grants-flywheel` |
