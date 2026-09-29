# RUNBOOK — x402 citizen

Foundry box for `--live`. The desk deploy stays read-only. No seed in git, Vercel, or Actions.

## Desk

Leave `XRPL_FACILITATOR_URL` unset and the desk self-verifies, which is the path already in production.

To accept T54 receipts:

```bash
XRPL_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai
XRPL_NETWORK=xrpl:1
```

Confirm `GET /api/status` shows `facilitator.mode` `dual`, `facilitator.host` `xrpl-facilitator-testnet.t54.ai`, `facilitator.networkId` `1`, `facilitator.settles` `false`. A mainnet host must show `refused` and must not be left in the env.

`GET /api/x402` is the catalog agents should find. The toml weblinks point at this pack, the desk catalog, and the testnet facilitator.

## Inbound check

1. `GET /api/x402/reserve-audit` with no payment header. Expect 402 and `howToPay.facilitator.network` `xrpl:1`.
2. Pay W3 yourself and retry with `payload.transaction`. That is self-verify. It works with the facilitator env unset.
3. With the testnet env set, a `facilitatorReceipt` whose `transaction` is that same validated hash also returns 200. The desk does not post the blob to settle.

## Daily outbound

```bash
npm run x402:citizen
npm run x402:citizen -- --url https://foreign-shop.example/sku
FOUNDRY_DAEMON_LIVE=yes npm run x402:citizen -- --live --url https://foreign-shop.example/sku --record
```

No `--url` and an empty `candidates.json` is a successful dry-run: `foreign_shop none`, `signed false`, `no tx hash (not submitted)`. That is the honest result when no foreign Testnet SKU is known. Do not invent a hash to fill `x402_outbound_hits`.

`--record` appends `x402_outbound` only after HTTP 200. The signer is `W3_REGULAR_SEED`, then `W3_SEED`, and the classic address must be W3. The process refuses NetworkID other than 1.

## Counts

`/api/status` fields:

- `facilitator.host` and `facilitator.mode`
- `x402_outbound_hits` from `lab/metrics.json` (pnl fallback if metrics is down)
- `x402_foreign_hits` from `lab/ledger-log.jsonl` rows `action: x402_hit` whose `payer` is not in `WALLETS`
