# RUNBOOK — LP Badge Bound

Foundry box. Secrets in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`, mode 600. Never print them. Never run the signing command in GitHub Actions.

## Probe only

```bash
npm run lp-badge:bound -- --dry-run
```

Connects to `wss://s.altnet.rippletest.net:51233`, prints whether `Credentials` is enabled, and exits. No faucet. No sign.

If `Credentials` is not enabled, stop. Do not submit. Do not point this script at Xahau or at a mainnet host. Hooks are out of scope on this server.

## One-click trial

```bash
npm run lp-badge:bound -- --record
```

First run faucets four accounts, writes seeds outside the repo, writes public addresses to `addresses.json`, then:

1. TrustSet AETH, buy ~50 AETH, `AMMDeposit` until LP ≥ 1000.
2. Door `AccountSet` DepositAuth and `DepositPreauth` for `aether-lp-ok`.
3. Stranger payment → `tecNO_PERMISSION`.
4. `CredentialCreate` (only if LP ≥ 1000) and `CredentialAccept`.
5. Holder payment without `CredentialIDs` → `tecNO_PERMISSION`.
6. Holder payment with `CredentialIDs` → `tesSUCCESS`.
7. `AMMWithdraw` all of the trial holder's LP. Abort the delete if LP is still ≥ 1000.
8. Issuer `CredentialDelete`.
9. Holder payment with the stale id → `tecBAD_CREDENTIALS`.

`--record` appends `lp_badge_bound_trial` to `lab/ledger-log.jsonl` after that sequence. `trial.json` is public fields only.

Re-running after `addresses.json` exists reuses those accounts. It will not faucet again. It will not withdraw W1.

## What the script refuses

- `CI=true` or `GITHUB_ACTIONS=true` before faucet or sign
- Hosts other than `*.rippletest.net` and `testnet.xrpl-labs.com`
- Network id `0` and Xahau mainnet `21337`
- A seed whose address does not match `addresses.json`
- `CredentialCreate` when LP is below 1000
- `CredentialDelete` when LP still meets 1000
- Recording a seed-shaped string or a key whose name contains `seed` or `secret`
