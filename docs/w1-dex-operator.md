# W1 Testnet offer adapter

The adapter is installed and dormant. It does not read a key, open a socket, or submit while `FOUNDRY_W1_DEX_LIVE` is unset. Turning it on is a local operator action. This document is not evidence that a live transaction succeeded.

## Public boundary

- Signer account: W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS`
- Asset issuer: W0 `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` issues AETH. W0 is not a signer.
- Network: `xrpl:1` only. The socket must answer `server_info` with `network_id` 1 before any signature.
- Socket allowlist: `wss://testnet.xrpl-labs.com` with no credentials and no port.
- Book offers only. The passive flag is required. A caller cannot choose the account, destination, fee, sequence, or reserve.

## Limits and reserve

- Locked XRP on one offer is at most 800000 drops. That ceiling is not a promise that 800000 fits. Exposure is locked XRP plus the live owner-reserve increment plus the open-ledger fee, and that sum must be at most 1000000 drops. A 0.2 XRP reserve plus a fee makes 800000 drops too large. The code refuses it. Do not raise the cap. Choose a smaller order that fits, such as 100000 drops of locked XRP when the observed reserve and fee leave room.
- The open-ledger fee must be from 1 to 10000 drops. The caller does not set it.
- Exposure is locked XRP plus that fee plus one incremental owner reserve. The reserve is `validated_ledger.reserve_inc_xrp` from the socket, converted to drops. It is not a hardcoded 0.2 XRP and it is not a yield.
- The shared mission ledger still caps one mission at 1000000 drops and a Chicago day at 5000000 drops, including every outstanding hold.
- Creating the offer increases the account owner count by one. That reserve stays locked until a validated cancel or a validated consuming trade deletes the offer. The network fee is spent. Neither number is an APR.

## What one activation does

A live process invocation makes one decision. It does not loop, invent prices, or churn orders. With the live gate on and no order amounts, the decision is `hold`: no socket, no key, no reservation. An explicit order, cancel, reconcile, or consume is one action and then the socket closes. Calling it again with the same idempotency key does not sign or submit a second time. Choosing no trade is a successful decision.

## Default-off install

Leave these unset: `FOUNDRY_W1_DEX_LIVE`, `FOUNDRY_DEX_EXECUTE`, and every `W0_SEED` through `W7_SEED`. Put the W1 seed only in an absolute file outside this checkout, mode `0600`, one link, not a symlink:

```json
{"address":"rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS","seed":"<operator seed>"}
```

Health reads the file mode and path only. It does not derive the key.

```sh
node -e 'console.log(JSON.stringify(require("./src/business/dex/live").health(process.env)))'
```

A dormant result has `dormant: true`, `activated: false`, and `live_proof: false`. `account_file` is `unset`, `missing`, `present`, `refused`, or `symlink`. `present` means a regular mode `0600` file outside the checkout. It does not mean the seed matches.

## Preflight

Preflight checks the file address field against W1. It does not derive the key and does not connect. Derivation happens only inside an activated connection, and only after `server_info` has reported network id 1. A wrong network closes the socket before the key is opened. Run preflight only on the operator machine, and do not pass dependency injection:

```sh
node -e 'require("./src/business/dex/live").preflight(process.env).then((row)=>console.log(JSON.stringify(row))).catch((error)=>console.log(error.code))'
```

## Opt-in and restart

All of these must be set together. A restart with the same environment and the same mission ledger is safe: an idempotency key that already reached `submit_attempted` is not signed or submitted again. A restart does not release an outstanding hold.

- `FOUNDRY_DEX_EXECUTE=yes`
- `FOUNDRY_DEX_ROLE=W1`
- `FOUNDRY_DEX_NETWORK=xrpl:1`
- `FOUNDRY_DEX_ACCOUNT=rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS`
- `FOUNDRY_DEX_ACTIVATE=ACTIVATE-W1-DEX-ROLE`
- `FOUNDRY_DEX_MAX_LOCKED_DROPS=800000`
- `FOUNDRY_DEX_MAX_AETH=10`
- `FOUNDRY_DEX_AXELAR_DROPS=0`
- `FOUNDRY_W1_DEX_LIVE=yes`
- `FOUNDRY_W1_DEX_WS=wss://testnet.xrpl-labs.com`
- `FOUNDRY_W1_DEX_ACCOUNT_FILE=/absolute/path/outside/checkout/w1.json`

`FOUNDRY_DEX_KILL=yes` stops new reservations and does not cancel open offers or release holds.

## Shutdown

Every live tick disconnects the socket in a `finally` block, including when signing or submission throws. Shutdown does not delete the mission ledger and does not release a hold.

## Reconciliation

- The offer's own validated metadata must show both the XRP and AETH deltas. A missing offer node is not a fill.
- A later consuming trade is reconciled from `account_tx` over the create ledger through the validated ledger, with no `marker`. Exactly one foreign transaction may touch that offer sequence. Its metadata must delete or reduce the W1 offer and the W1 balance deltas must match both sides. Zero such transactions leaves the reserve in place. Two or more stay unresolved.
- `txnNotFound` releases a hold only through the existing sanctioned absence proof. A long-lived W1 sequence does not satisfy that proof, so an ordinary unfound offer stays outstanding.
