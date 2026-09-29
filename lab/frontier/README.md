# Frontier amendment probe

Protocol runs this before any new transaction type. `amendments.json` is the last `feature` map read from XRPL Testnet (network id **1**). It is a measurement, not a switch. A row with `"enabled": false` is off. Do not submit that transaction type, and do not sequential-fake it.

```bash
npm run director:snapshot
npm run director:wake -- --check
npm run frontier:probe
```

`npm run frontier:probe` (same entry as `npm run director:probe-amendments`) calls `server_info` and `feature` on `FOUNDRY_XRPL_HTTP`, then `XRPL_HTTP`, then `XRPL_RPC_URL`, then `https://s.altnet.rippletest.net:51234`. It refuses a network id other than `1` and refuses mainnet hosts. The `rpc` field stored in the file is that public URL with no userinfo, query, or secret.

If RPC fails, or a watched name is missing from `feature`, the process exits non-zero and does not replace `amendments.json`. A missing name is not written as `enabled: false`. Hashes are the feature-map keys the server returned.

Day-1 map, probed 2026-09-28 on rippled **3.4.1**:

| Band | State |
|------|--------|
| A | Enabled: Credentials, PermissionedDomains, PermissionedDEX, TokenEscrow, MPTokensV1, PriceOracle, DynamicNFT, DID, Clawback, DeepFreeze, DepositAuth |
| B | `BatchV1_1`, `fixBatchV1_2`, and `PermissionDelegationV1_1` are disabled. `TicketBatch: true` is not atomic Batch. `machines/batch-heartbeat/` stays spec-only. |
| C | Disabled: SingleAssetVault, LendingProtocol, LendingProtocolV1_1, Sponsor, ConfidentialTransfer, DynamicMPT, XChainBridge |

Until a later probe says otherwise, do not submit Batch, and do not stand in for TokenEscrow or vaults with a sequence of other transactions.

F1 keeper: `npm run frontier:oracle-set` reads this map's live twin via `feature` and refuses `OracleSet` unless `PriceOracle` is enabled on network id 1. Default is dry-run. The ticket command is `npm run frontier:oracle-ticket`. Pack: `machines/native-price-oracle/`.

F2 labor MPT: `npm run frontier:mpt-labor-create` and `npm run frontier:mpt-labor-authorize` call `feature` and refuse unless `MPTokensV1` is enabled on network id 1. Default is dry-run. Pack: `machines/labor-mpt/`. That pack does not submit TokenEscrow.

F3 labor TokenEscrow: `npm run frontier:token-escrow-create`, `npm run frontier:token-escrow-finish`, and `npm run frontier:token-escrow-cancel` call `feature` and refuse unless `TokenEscrow` is enabled on network id 1. Default is dry-run. The lock is 1 `AETH-LABOR` when `lab/metrics.json` has `mpt_issuance_id`, otherwise 1 AETH. Pack: `machines/token-escrow-labor/`. A disabled row is not a Payment or an XRP escrow.
