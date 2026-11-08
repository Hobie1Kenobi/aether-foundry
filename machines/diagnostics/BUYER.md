# Buyer diagnostic

Offline structural checks, a loopback seller, and one opt-in payment command. Nothing here calls `api.stablecoingateways.com` or starts the mission worker. A structural pass is not settlement.

`@x402/xrpl` 2.30.0 field checks reject an exact `xrpl:1` challenge whose `extra` omits `areFeesSponsored`. The buyer echoes the issued challenge and does not add that field. `verify()` and `settle()` open a testnet socket, so the offline command does not call them.

## Offline structural report

```sh
node src/diagnostics/buyer-diagnostic.js offline
```

## Hosted capability

GET only, 10 second timeout, redirects refused, host fixed to `xrpl-facilitator-testnet.t54.ai`:

```sh
node src/diagnostics/buyer-diagnostic.js supported
```

## Loopback seller

```sh
node src/diagnostics/controlled-seller.js
```

This listens on `127.0.0.1:8794`. `GET /paid` is the vendor-shaped challenge. `GET /paid?shape=official` is the challenge that already contains `areFeesSponsored: false`. The process prints the URL and payee address. It does not settle.

## One payment, after review

The command below is the only spend path. It refuses to run unless the existing mission ledger still counts legacy hold `msn5b5c3223e5e88526` (1747 drops), spending is already activated, and `worker.json` says asleep. It does not activate spending and it does not start the worker. A new wallet does not open a fresh cap. The payment plus fee must fit in the 1 XRP mission cap and the 5 XRP Chicago-day cap, with that 1747-drop hold included.

Preview, no write:

```sh
FOUNDRY_MISSION_HOME=... \
FOUNDRY_MISSION_LEDGER=... \
FOUNDRY_DIAGNOSTIC_PHRASE=DIAGNOSTIC-ONE-XRPL1-PAYMENT \
FOUNDRY_DIAGNOSTIC_TOKEN=... \
FOUNDRY_DIAGNOSTIC_SELLER=http://127.0.0.1:8794/paid \
node src/diagnostics/controlled-purchase.js
```

The live opt-in is the same command with `FOUNDRY_DIAGNOSTIC_LIVE=yes` and `FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE` pointing at a new faucet account outside this checkout. One attempt is recorded before the submit. A crash, timeout, or facilitator success without a validated `tx` lookup on the reconcile RPC leaves the new claim uncertain and refuses a second run. The legacy hold is not released. Do not set `FOUNDRY_MISSION_EXECUTE`.

Install the packed sources with `npm ci --ignore-scripts` from the pack root. The pack contains `package.json` and `package-lock.json`.
