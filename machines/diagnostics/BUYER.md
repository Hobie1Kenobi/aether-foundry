# Buyer diagnostic

Offline structural checks, a loopback seller, and one opt-in payment command. Nothing here calls `api.stablecoingateways.com`, starts the mission worker, or binds `8794`. A structural pass is not settlement.

`@x402/xrpl` 2.30.0 field checks reject an exact `xrpl:1` challenge whose `extra` omits `areFeesSponsored`. The buyer echoes the issued challenge and does not add that field. The offline command does not call `verify()` or `settle()`.

## Offline structural report

```sh
node src/diagnostics/buyer-diagnostic.js offline
```

## Hosted capability

GET only, 10 second timeout, redirects refused, host fixed to `xrpl-facilitator-testnet.t54.ai`:

```sh
node src/diagnostics/buyer-diagnostic.js supported
```

## Two faucet accounts

Create two new Testnet accounts at the public faucet. Do not use a house wallet, the legacy mission account, or the current mission account. Put the buyer seed in a mode `0600` file outside this checkout:

```json
{"address":"rBuyer...","seed":"sEd..."}
```

Check it without printing the seed:

```sh
node src/diagnostics/account-file.js /secure/diag-buyer.json
```

Write the public handover next to it. It has no seed:

```json
{"network":"xrpl:1","buyer":"rBuyer...","seller":"rSeller..."}
```

Both accounts must already exist on Testnet. A 10-drop payment cannot create the seller account.

## Loopback seller

The mission worker owns `127.0.0.1:8794`. This seller uses `8795` and refuses `8787`, `8788`, `8792`, `8793`, and `8794`. It does not stop or replace the worker.

```sh
FOUNDRY_DIAGNOSTIC_XRPL_WSS=wss://testnet.xrpl-labs.com \
FOUNDRY_DIAGNOSTIC_PAYEE=rSeller... node src/diagnostics/controlled-seller.js
```

`GET /paid` is the vendor-shaped challenge and is rejected before settle. `GET /paid?shape=official` already contains `areFeesSponsored: false`. A paid POST is verified and settled, then answered with a receipt that has no signed blob.

## Preview

Preview does not take the attempt lock and does not sign.

```sh
FOUNDRY_MISSION_HOME=... \
FOUNDRY_MISSION_LEDGER=... \
FOUNDRY_DIAGNOSTIC_PHRASE=DIAGNOSTIC-ONE-XRPL1-PAYMENT \
FOUNDRY_DIAGNOSTIC_TOKEN=... \
FOUNDRY_DIAGNOSTIC_SELLER=http://127.0.0.1:8795/paid \
FOUNDRY_DIAGNOSTIC_PAYEE=rSeller... \
node src/diagnostics/controlled-purchase.js
```

The command refuses unless the existing ledger still counts legacy hold `msn5b5c3223e5e88526` (1747 drops) on later Chicago days as well as the day it was reserved. Spending must already be activated. `worker.json` must say asleep. The command does not activate spending and does not start the worker or the signer.

## One payment, after review

Same command, with the private files and:

```sh
FOUNDRY_DIAGNOSTIC_LIVE=yes \
FOUNDRY_DIAGNOSTIC_XRPL_WSS=wss://testnet.xrpl-labs.com \
FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE=/secure/diag-buyer.json \
FOUNDRY_DIAGNOSTIC_HANDOVER=/secure/diag-handover.json
```

Do not set `FOUNDRY_MISSION_EXECUTE`. The command has no simulate switch. Set the verifier socket to a documented port-443 Testnet server before the live purchase. `wss://s.altnet.rippletest.net:51233` is refused.

```sh
FOUNDRY_DIAGNOSTIC_XRPL_WSS=wss://testnet.xrpl-labs.com
```

`wss://testnet.honeycluster.io` is the other allowed socket. The command reads `server_info` for that host and requires network id 1 and a validated ledger before it signs. The same host, or `FOUNDRY_MISSION_RECONCILE_RPC=https://testnet.honeycluster.io`, is what lookup and settlement proof use for the 20-drop claim.

The command reads the validated ledger, both account sequences, and both challenges before it takes the attempt lock. The 1747 drops have to be the retained balance of `msn5b5c3223e5e88526`, not some other uncertain mission. The authorized seller address has to equal the challenge `payTo`. One lock is kept after a crash or an ambiguous attempt file, and a second process cannot sign. The seller performs verify and settle. This command marks the budget spent only after a validated `tx` lookup matches the hash, `tesSUCCESS`, the payee, and the amount. A timeout or a failed proof leaves the new claim uncertain and records only an allowlisted reason code. The 1747-drop hold is not released.

A later read of an uncertain mission does not sign, settle, reset the attempt, or release:

```sh
FOUNDRY_MISSION_LEDGER=... \
FOUNDRY_DIAGNOSTIC_MISSION=msn... \
node src/diagnostics/controlled-purchase.js lookup
```

That lookup is not a release. Release stays on the existing reconcile history guard.

## One more attempt, after reconcile

The first live attempt keeps `diagnostic-attempt.lock` and its jsonl line forever. After every diagnostic signed claim is released or settled, including the legacy 1747-drop hold still counting, the owner can append one new grant. This does not delete the lock, does not sign, and does not reserve a new hold:

```sh
FOUNDRY_MISSION_HOME=... \
FOUNDRY_MISSION_LEDGER=... \
FOUNDRY_DIAGNOSTIC_REAUTHORIZE_PHRASE=REAUTHORIZE-ONE-DIAGNOSTIC-ATTEMPT \
FOUNDRY_DIAGNOSTIC_REAUTHORIZE_TOKEN=... \
node src/diagnostics/controlled-purchase.js reauthorize
```

The reauthorize token must be distinct from the payment token. A second grant is refused until that new attempt has itself been used and reconciled. The payment command is unchanged and still requires `FOUNDRY_DIAGNOSTIC_LIVE=yes`. A failed seller response records the allowlisted reason, stage, and HTTP status, plus the facilitator `errorReason` and `errorMessage` when those strings contain no secret, blob, or header.

Install the packed sources with `npm ci --ignore-scripts` from the pack root. The pack contains `package.json` and `package-lock.json`.
