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
npm run x402:citizen -- --url https://verify.sciphr.io/v1/credential/verify
npm run x402:citizen -- --url https://verify.sciphr.io/v1/did/resolve
FOUNDRY_DAEMON_LIVE=yes npm run x402:citizen -- --live --url https://verify.sciphr.io/v1/credential/verify --record
```

No `--url` probes `candidates.json` in order. Sciphr entries are POST with a JSON body. The demo `subject` (credential verify) and `account` (DID resolve) are W3 CHANNELS `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`. That address is the request body on Testnet. It is not the pay-to. CryptoBuddy stays a GET. A dry-run that finds a 402 prints `method`, `pay_to`, `drops`, and `source_tag`, and does not sign. An empty `urls` list is still a successful dry-run: `foreign_shop none`, `signed false`, `no tx hash (not submitted)`. Do not invent a hash to fill `x402_outbound_hits`.

`--live` retries the same method and body with `PAYMENT-SIGNATURE`. Sciphr settles the presigned blob (HTTP 200, Foundry does not submit). `payment_not_on_ledger` is the only path that submits that blob once.

`--record` appends `x402_outbound` only after HTTP 200. The signer prefers `W3_REGULAR_SEED`. That seed's classic address must be the W3 regular key in `machines/governance-board/activated.json`, or `W3_REGULAR_ADDRESS` when that env is set. `W3_SEED` is used only when the regular seed is absent, and then the classic address must be W3. The Payment `Account` stays W3 CHANNELS. The process refuses NetworkID other than 1.

The signature payload includes `invoiceId` from the challenge when `extra.invoiceId` is set. Foundry does not submit first. A shop that settles the presigned blob (CryptoBuddy / t54, Testnet only) returns 200 from that signature. A shop that only looks up a validated Payment answers `payment_not_on_ledger`; Foundry then submits the same blob once and retries. The fingerprint memo and the shop `SourceTag` stay on the Payment.

## Counts

`/api/status` fields:

- `facilitator.host` and `facilitator.mode`
- `x402_outbound_hits` from `lab/metrics.json` (pnl fallback if metrics is down)
- `x402_foreign_hits` from `lab/ledger-log.jsonl` rows `action: x402_hit` whose `payer` is not in `WALLETS`
