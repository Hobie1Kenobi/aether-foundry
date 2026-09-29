# Frontier amendment probe

Protocol runs this before any new transaction type. `amendments.json` is the last `feature` map read from XRPL Testnet (network id **1**). It is a measurement, not a switch. A row with `"enabled": false` is off. Do not submit that transaction type, and do not sequential-fake it.

```bash
npm run director:snapshot
npm run director:wake -- --check
npm run frontier:probe
npm run frontier:probe-devnet
```

`npm run frontier:probe` (same entry as `npm run director:probe-amendments`) calls `server_info` and `feature` on `FOUNDRY_XRPL_HTTP`, then `XRPL_HTTP`, then `XRPL_RPC_URL`, then `https://s.altnet.rippletest.net:51234`. It refuses a network id other than `1` and refuses mainnet hosts. The `rpc` field stored in the file is that public URL with no userinfo, query, or secret.

If RPC fails, or a watched name is missing from `feature`, the process exits non-zero and does not replace `amendments.json`. A missing name is not written as `enabled: false`. Hashes are the feature-map keys the server returned.

Day-1 map, probed 2026-09-28 on rippled **3.4.1**:

| Band | State |
|------|--------|
| A | Enabled: Credentials, PermissionedDomains, PermissionedDEX, TokenEscrow, MPTokensV1, PriceOracle, DynamicNFT, DID, Clawback, DeepFreeze, DepositAuth |
| B | `BatchV1_1`, `fixBatchV1_2`, and `PermissionDelegationV1_1` are disabled. `TicketBatch: true` is not atomic Batch. `machines/batch-heartbeat/` stays spec-only. |
| C | Disabled: SingleAssetVault, LendingProtocol, LendingProtocolV1_1, Sponsor, ConfidentialTransfer, DynamicMPT, XChainBridge |

Day 7 re-probe, Chicago `2026-09-28T20:17:30-05:00`, same rippled **3.4.1**, network id **1**. Flags did not flip.

| Band | State |
|------|--------|
| A | Still enabled. |
| B | `BatchV1_1`, `fixBatchV1_2`, and `PermissionDelegationV1_1` still disabled. `TicketBatch` still true, and still not atomic Batch. `machines/batch-heartbeat/` stays spec-only. Permission delegation stays spec-only. Do not submit `Batch`. Do not grant a delegate. |
| C | Still disabled on Testnet: SingleAssetVault, LendingProtocol, LendingProtocolV1_1, Sponsor, ConfidentialTransfer, DynamicMPT, XChainBridge. |

Devnet is a different measurement. `npm run frontier:probe-devnet` writes [`amendments-devnet.json`](./amendments-devnet.json) from `server_info` and `feature` on `FOUNDRY_XRPL_DEVNET_HTTP`, then `XRPL_DEVNET_HTTP`, then `https://s.devnet.rippletest.net:51234`. It does not read `FOUNDRY_XRPL_HTTP`. It refuses a network id other than **2**, and it refuses mainnet hosts (`ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, `xahau.network`, `xrpl.org`) before the fetch. A missing feature name is not written as disabled. RPC failure leaves the file untouched.

Day 7 Devnet map, Chicago `2026-09-28T20:17:31-05:00`, rippled **3.4.1**, network id **2**: every watched row was `enabled: true`, including Band B and Band C. That does not authorize a Testnet Batch, and this session did not submit Batch, Vault, Loan, Sponsor, or ConfidentialTransfer on Devnet either. Blank Devnet lines are `D0`–`D3` in `corp/wallets.md`. Sequences that are still notes: [`port-forward.md`](./port-forward.md). Letter: [`DAY7.md`](./DAY7.md).

Until a later Testnet probe says otherwise, do not submit Batch on Testnet, and do not stand in for a disabled Testnet amendment with a sequence of other transactions.

F1 keeper: `npm run frontier:oracle-set` reads this map's live twin via `feature` and refuses `OracleSet` unless `PriceOracle` is enabled on network id 1. Default is dry-run. The ticket command is `npm run frontier:oracle-ticket`. Pack: `machines/native-price-oracle/`.

F2 labor MPT: `npm run frontier:mpt-labor-create` and `npm run frontier:mpt-labor-authorize` call `feature` and refuse unless `MPTokensV1` is enabled on network id 1. Default is dry-run. Pack: `machines/labor-mpt/`. That pack does not submit TokenEscrow.

F3 labor TokenEscrow: `npm run frontier:token-escrow-create`, `npm run frontier:token-escrow-finish`, and `npm run frontier:token-escrow-cancel` call `feature` and refuse unless `TokenEscrow` is enabled on network id 1. Default is dry-run. The lock is 1 `AETH-LABOR` (`0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED` in `lab/metrics.json`). 1 AETH is used only when that field is absent. Pack: `machines/token-escrow-labor/`. A disabled row is not a Payment or an XRP escrow.
