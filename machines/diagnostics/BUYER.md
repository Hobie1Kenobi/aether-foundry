# Buyer diagnostic

This is an offline check of the Foundry buyer construction. It does not start the mission worker, does not change the allowlist, and does not call `api.stablecoingateways.com`. A passing local verifier is not proof that seller accepts the payload.

Installed local verifier: `@x402/xrpl` 2.30.0. It rejects an exact `xrpl:1` challenge whose `extra` omits `areFeesSponsored`. The buyer echoes the challenge and does not add that field. The same construction with `areFeesSponsored: false` already on the challenge is the comparison case.

Hosted facilitator read, GET only: `https://xrpl-facilitator-testnet.t54.ai/supported`. That server advertises x402 v2 `exact` on `xrpl:1`. This package does not POST `/verify` or `/settle`.

## Offline

```sh
node src/diagnostics/buyer-diagnostic.js offline
```

The JSON report includes the payer address and verifier reasons. It does not include a seed, a signed blob, or a payment header.

## Hosted capability

```sh
node src/diagnostics/buyer-diagnostic.js supported
```

This is a GET of `/supported` only.

## Later live step

Not part of this run. After review, the operator may fund one new faucet wallet and make one `xrpl:1` payment. That payment is outside the asleep mission worker. Do not set `FOUNDRY_MISSION_EXECUTE`. Do not use the existing mission account. Do not release `msn5b5c3223e5e88526`. The 1747-drop hold still counts toward the 5 XRP Chicago-day cap. One attempt, no retry. A new wallet does not reset the cap.
