# RUNBOOK — x402 outbound

Testnet only. Seeds stay in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`. Never commit them. Never run the signer in GitHub Actions.

## 1. Foreign shop

From the repo root:

```bash
npm run x402:foreign
```

Listens on `127.0.0.1:8787`. Catalog: `GET /`. SKU: `GET /foreign-oracle-ping`.

Confirm unpaid:

```bash
curl -sS -D- -o /tmp/x402-foreign.json \
  http://127.0.0.1:8787/foreign-oracle-ping
```

Expect HTTP 402, header `PAYMENT-REQUIRED`, and `payTo` `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ`. If that address is a Foundry wallet, stop. The shop refuses to boot when `payTo` collides with `WALLETS`.

## 2. Dry-run (no seed)

```bash
npm run x402:outbound -- \
  --url http://127.0.0.1:8787/foreign-oracle-ping \
  --max-drops 10000 \
  --dry-run
```

Expect `dry-run`, the foreign payTo, `drops 5000`, and `no tx hash (not submitted)`.

Without `--max-drops` (and without `MAX_DROPS`), expect exit 2 and the line `too expensive vs DIY`.

## 3. Live pay (Foundry box)

`W3_SEED` must be the seed for `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`.

```bash
npm run x402:outbound -- \
  --url http://127.0.0.1:8787/foreign-oracle-ping \
  --max-drops 10000 \
  --record
```

Expect `paid <64-hex>`, then `status 200`, then a JSON body with `work` `foreign-oracle-ping` and a numeric `ledger_index`. `--record` appends `lab/ledger-log.jsonl` (`action` `x402_outbound`) and sets `x402_outbound_hits` to the count of unique hashes. A second record of the same hash does not double-count.

The payer retries the HTTP call if the shop has not seen the tx yet. It submits the Payment once. If HTTP stays non-200, it prints the hash and tells you not to pay again.

## 4. Any other foreign resource

```bash
npm run x402:outbound -- --url https://example.test/resource --max-drops 10000 --record
```

The URL must return 402 / `PAYMENT-REQUIRED` for `xrpl:1`. Foundry payTo is refused. Mainnet networks and mainnet XRPL hosts are refused. The payment amount must be at most `500000` drops. A second live outbound on the same UTC day is refused before `W3_SEED` is read.

Foundry-box clock (dry-run, no URL, no seed), America/Chicago:

```bash
45 10 * * * cd /path/aether-foundry && npm run x402:outbound -- --dry-run
```

That line exits 0. It does not submit. `--record` refreshes `lab/metrics.json` `last_outbound_hash` from the ledger hash after HTTP 200.

## 5. Do not

- Point this payer at `https://aether-foundry-desk.vercel.app/api/x402/*` (payTo is W3).
- Put `W3_SEED` or `FOREIGN_SEED` in Vercel or git.
- Set `XRPL_WS_URL` to a mainnet host.
- Invent a payment hash when the seed is absent. Archive the dry-run instead.
