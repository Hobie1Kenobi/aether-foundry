# RUNBOOK — governance board

XRPL Testnet only. Seeds stay in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env` (mode 600). Never commit them. Never print them. Never run the signer in GitHub Actions.

## 1. Dry-run (no seed)

From the repo root:

```bash
npm run gov:dry
```

This connects to `wss://s.altnet.rippletest.net:51233`, reads `server_state` and `account_info` (with `signer_lists`) for W0–W6, and prints balances, owner counts, current `RegularKey`, and whether a signer list exists. It ends with `no tx hash (not submitted)`. It does not read the secrets file.

Override the socket only with another `*.rippletest.net` URL (`XRPL_WS_URL`).

## 2. Live set (Foundry box)

Master seeds must already be in the secrets file as `W0_SEED`…`W6_SEED` (or `TREASURY_SEED`, `MARKET_SEED`, `ATELIER_SEED`, `CHANNELS_SEED`, `ESCROW_SEED`, `RD_SEED`, `GRANTS_SEED`). The derived classic address must match `corp/wallets.md`.

```bash
npm run gov:live
```

What it does:

1. Refuses CI, mainnet hosts, Xahau hosts, and NetworkID other than 1.
2. If `SIGNER_*_SEED` or `W1_REGULAR_SEED`…`W6_REGULAR_SEED` are missing, generates ed25519 keys and appends them to the secrets file. Existing values are not rotated. Names are printed. Values are not.
3. Refuses if any of those addresses collide with each other or with W0–W6.
4. Refuses if any of W0–W6 already has `lsfDisableMaster`.
5. Submits `SignerListSet` from the W0 master when no list is present. A different existing list stops the run before any submit unless you pass `--replace`.
6. Submits `SetRegularKey` for each of W1–W6. A different existing regular key stops the run before any submit unless you pass `--replace`.
7. Appends `lab/ledger-log.jsonl` only after `tesSUCCESS` with a 64-hex hash.
8. Writes public addresses and those hashes to `machines/governance-board/activated.json`.

`--dry-run` on this command still requires master seeds, still refuses CI, and does **not** generate keys or submit. Use `npm run gov:dry` when the seeds are not on the machine.

## 3. Quorum demo

```bash
npm run gov:multisign
```

Same as the live set, then a multi-signed Payment of 10000 drops from W0 to W6 signed by Director and Market. Each run sends another 10000 drops. It refuses if the on-ledger list does not match hunch H1.

A payment at or above 50 XRP is not what this command sends. Any such payment needs a file in `lab/motions/` other than `README.md` with `destination:` and `amount_drops:` or `amount_xrp:` matching the payment.

## 4. Archive

Copy the public addresses from the script output into `corp/wallets.md` if `activated.json` is not enough for the address book. Put the hashes in `RESULTS.md`. Do not paste seeds.

## Explicit non-actions

- Do not set `asfDisableMaster`.
- Do not `EscrowFinish` or `EscrowCancel` the Unix-epoch BUYER scar.
- Do not point this script at Xahau or at W7.
- Do not add seeds to Vercel.
