# RUNBOOK — grants flywheel

Testnet only. The desk does not sign. Seeds stay in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`.

## Read the candidate list

```bash
npm run grants:scan
```

This reads `lab/ledger-log.jsonl`, `lab/grants/ledger.jsonl` when it exists, and the public Testnet HTTP endpoint. It prints selectable counterparties and does not submit. `--no-rpc` stays on the local logs.

Eligible means a Walk-In accept, an x402 Payment to W3, an AETH trust line or path-pay, or a taxon `20260927` holder, and the address is not in `WALLETS`.

## Plan a payment

```bash
npm run grants:pay -- --dry-run
npm run grants:pay -- --dry-run --drops 1000000
npm run grants:pay -- --dry-run --destination rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN
```

Dry-run prints the unsigned Payment (`Account` W6, 1000000 drops unless `--drops` is set, memos `aether-grant` / `grants-flywheel` / reason). It does not load `W6_SEED` or `W6_REGULAR_SEED`. It prints `no tx hash (not submitted)`.

`--drops` at or above `50000000` exits unless `lab/motions/` has a matching `destination` and amount. That check runs on the dry-run too.

## Pay one counterparty

On the Foundry box, after the dry-run names the destination you expect:

```bash
npm run grants:pay -- --record
```

Prefer `W6_REGULAR_SEED`. The signer address must be the W6 regular key in `machines/governance-board/activated.json`. `W6_SEED` or `GRANTS_SEED` is the master fallback. The command refuses CI, mainnet hosts, and NetworkID 0.

Success writes `lab/grants/ledger.jsonl` immediately. `--record` also appends `lab/ledger-log.jsonl`, increments `grants_paid` in `market/pnl.md`, appends a table to `RESULTS.md`, and refreshes `lab/metrics.json` from the public ledger. `last_grant_hash` is that `tesSUCCESS` hash. Without a `tesSUCCESS` hash, none of those files change. A second live payment on the same UTC day is refused before the seed file is opened. The Foundry-box clock runs the dry-run only; see `machines/foundry-runtime/RUNBOOK.md`.

Optional AETH, only for an `aeth_counterparty` whose trust line is the reason you are paying:

```bash
npm run grants:pay -- --dry-run --aeth --reason aeth_counterparty
```

The XRP grant is still the default Payment. AETH is a second Payment of 1 AETH with SendMax capped at 2 XRP, and only when a path is that cheap. The archived grant hash is the XRP Payment.

## If the list is empty

Exit 3 on a live pay means nobody eligible is outside the cooldown. Do not add a Foundry address to force a payment. Do not lower the exclusion list. Wait for a real Walk-In or x402 payer, or wait out the 7-day cooldown.

## Do not

- Run `npm run grants:pay` without `--dry-run` in GitHub Actions.
- Pay a second grant on the same UTC day. The daemon and `grants:pay` both stop at one.
- Pay STRANGER, BUYER, W0–W6, or the AMM.
- Fund the grant from W0.
- Touch the Unix-epoch BUYER escrow.
- Write a hash into `RESULTS.md` or `artifact.json` by hand.
