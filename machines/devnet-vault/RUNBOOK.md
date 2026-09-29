# RUNBOOK — Devnet vault and loan

**Default:** dry-run. **Network:** XRPL Devnet id 2. **Signers:** `D0_SEED` and `D1_SEED` on the Foundry box.

## 1. Probe

```bash
npm run frontier:probe-devnet
```

Stop unless `SingleAssetVault`, `LendingProtocol`, and `LendingProtocolV1_1` are enabled and `network_id` is 2.

## 2. Dry-run

```bash
npm run frontier:devnet-vault
```

Expect `"accounting": "cash-basis"`, an XRP `VaultCreate` with `VaultKind` 1, and later steps `ready: false` until you pass a real id. `cover_source` names D0, not W6.

## 3. Live

Wait until `SubscriptionDate` before `--step loan`. Pass ids from the previous engine result.

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step create
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step deposit --vault-id <64 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step broker --vault-id <64 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step cover --broker-id <64 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step loan --broker-id <64 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step repay --loan-id <64 hex>
```

`repay` reads `Loan.PeriodicPayment` and rounds up. `--step default` is the other success line. It fails with `tecTOO_SOON` until grace has passed. Record one of the two, not a made-up hash.
