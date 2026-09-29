# RUNBOOK — Devnet confidential MPT

**Default:** dry-run. **Network:** XRPL Devnet id 2. Proofs are built only on `--live` by xrpl.js. A missing `ZKProof` aborts. This pack does not invent one.

## 1. Probe

```bash
npm run frontier:probe-devnet
```

`DynamicMPT` and `ConfidentialTransfer` must be enabled on network id 2. `MPTokensV1` must be enabled too.

## 2. Dry-run

```bash
npm run frontier:devnet-confidential
```

Expect `"key_loaded": false`, an `MPTokenIssuanceCreate` with confidential flags, and `pay` / `clawback` steps with `"tx": null`. Read `public_ledger`.

## 3. Live

ElGamal seeds are separate from signing seeds. Fund the sender. Do not use a Testnet labeled wallet.

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-confidential -- --live --step issue
```

Continue with `--issuance-id` from that result: `keys`, `authorize-sender`, `authorize-d3`, `public-sender`, `public-d3`, `convert-d3`, `convert-sender`, `merge-sender`, `pay`, `lock`, `clawback`.

Record the real hashes. Say in RESULTS what the public ledger showed and what it did not.
