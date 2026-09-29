# RUNBOOK — Devnet Sponsor

**Default:** dry-run. **Network:** XRPL Devnet id 2. **Signers:** D0 and D2 master seeds on the Foundry box. Not the Testnet agent allowlist. Not W0.

## 1. Probe

```bash
npm run frontier:probe-devnet
```

`Sponsor` must be `enabled: true` and `network_id` must be 2. The sponsor command checks again and exits if either is wrong.

## 2. Dry-run

Set `D0_ADDRESS` and `D2_ADDRESS`, or pass `--d0` and `--d2`. D2 is a new key that has never been funded.

```bash
npm run frontier:devnet-sponsor
```

Expect `"mode": "dry-run"`, `"network": "XRPL Devnet"`, `"network_id": 2`, `"key_loaded": false`, a `Payment` with `Amount` `"1"` and `Flags` `524288`, and a `DepositPreauth` with `SponsorFlags` `3`.

## 3. Live, one step

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step create
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step object
```

Archive the printed hash only when `result` is `tesSUCCESS`. The file is `lab/frontier/devnet-ledger.jsonl`. Paste that hash into `RESULTS.md`. Do not invent one.
