# Mission acceptance

This is the checklist for a later asleep install. It is not a boot service, and it is not permission to spend.

## Already true

- Caps stay 1 XRP (`1000000` drops) per mission and 5 XRP (`5000000` drops) per Chicago day, including fees.
- No mainnet, no W0, no EVM gas, no return-leg value.
- `msn5b5c3223e5e88526` stays uncertain for 1747 drops. Hash `6022D12A2FBA5C4321FB7A1CED1E10FFC91B75C521F402A725B0518B101A8FEC` was `txnNotFound` at validated ledger 22120454. Account sequence was 22117391 and the balance was 100000000. That is not a release. A clock time is not a release. An operator override is not a release.
- The retained challenge invoice `1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45` is not permission to sign again. A future purchase needs a new live 402.
- The reviewed resource is exactly `https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96`, x402 version 2, scheme exact, network `xrpl:1`, asset XRP, payTo `rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs`. The retained amount was 1737 drops, source tag 26100014, and `maxTimeoutSeconds` 600. A fresh challenge can show a different amount or invoice. Use the live `xrpl:1` row only. Ignore `xrpl:0` and the EVM rows.
- `./bin/start` in this tree stays asleep even when an arm file exists. It does not set execute.
- The box has no cron, no pm2, and no supervisord. systemd is not usable. `ensure-up` is one flocked bashrc hook for new shells, not a five-minute service. Do not call that a boot service.

## Accounting before any later purchase

The 1747-drop hold still counts in the daily cap. A later sanctions payment is a different mission. At the last public read its price was 1753 drops plus a network fee, which fits under 1 XRP and under the remainder of 5 XRP. That fit is not approval to spend. The parent assesses first. This repository run does not submit a transaction.

## What a completed purchase must show

- A fresh HTTP 402, x402 version 2, with an exact `xrpl:1` XRP accept for this URL and payTo.
- A new invoice id, not the retained one, and the live source tag, copied onto the Payment.
- Validated network id 1, the validated account sequence, and `LastLedgerSequence` no more than 20 ledgers ahead. The signer reads those again. The window is not refreshed after signing.
- The hash and the non-secret fields stored before the blob is offered. No blob in the ledger or in public logs.
- HTTP 200 whose `data.listed` is a boolean and whose `data.query.address` is the address in the URL. `data: {}` is not a result. The OpenAPI title says mainnet and lists `xrpl:0`; that is not authorization.

## Website

The desk reads one sanitized git snapshot. It is not a live loop. Automatic upload needs a GitHub token with Contents read and write on `Hobie1Kenobi/aether-foundry` only. GitHub cannot limit that token to one file. The process refuses every other path. No token is in this tree. Until that token is supplied, publication stays a manual snapshot. Do not send a broader admin, secrets, or workflow token.

## Axelar

The planner can describe native XRPL Testnet to XRPL EVM Testnet chain 1449000. The return leg has no verified native value and no EVM gas authorization. It is not part of this purchase.

## Parent must supply before any awake purchase

1. A decision that a new sanctions purchase may be attempted while the 1747-drop hold remains.
2. A fresh discovery file containing only the live 402 for the reviewed URL. Do not reuse the retained invoice.
3. The asleep runtime still on the current release until this tar is installed by the parent, with execute left off.
4. Optional: the Contents token above, if automatic snapshots are wanted.

## Not done

The open claim has no seller body and no `LastLedgerSequence`. It is unresolved. There is no continuous publisher and no real boot supervisor.
