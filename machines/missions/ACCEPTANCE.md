# Mission acceptance

Startup stays asleep. This file is not permission to spend, and it does not release `msn5b5c3223e5e88526`.

## Already true

- Caps stay 1 XRP (`1000000` drops) per mission and 5 XRP (`5000000` drops) per Chicago day, including fees.
- No mainnet, no W0, and no EVM gas. The Axelar return leg has no verified native value.
- The 1747-drop hold stays uncertain. Hash `6022D12A2FBA5C4321FB7A1CED1E10FFC91B75C521F402A725B0518B101A8FEC` was `txnNotFound` at validated ledger 22120454. Account sequence was 22117391 and the balance was 100000000. There is no `LastLedgerSequence`. A clock time is not a release. An operator override is not a release. The code refuses `override`.
- The retained invoice `1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45` cannot be admitted or signed again.
- A later unpaid challenge for the same sanctions URL was read at `2026-11-06T20:56:57.160Z`: x402 version 2, exact `xrpl:1`, XRP, amount `1753`, payTo `rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs`, source tag `26100014`, `maxTimeoutSeconds` 600, invoice `1793999217-8ff0cbc91cfe49c6-d1753-3be1077708929724e01824ae`. Discovery was not rewritten. No candidate id was minted. That file is not a payment. Its freshness window ended at `2026-11-06T21:06:57.160Z`.
- `./bin/start` stays asleep. `./bin/wake` is a separate command. It cannot set execute.
- The box has no cron, pm2, or supervisord. systemd is not usable. `ensure-up` is one flocked bashrc hook for a new shell. The mission block must sit before that script's final `exit 0`. A block after `exit 0` does not run. The tested order stops and restarts the dedicated worker asleep, leaves the ledger and the account unchanged, and leaves 8787, 8792, and 8793 healthy.

## Account sequence

The unknown blob has no ledger window, so sequence 22117391 cannot be reused safely. A new payment from that account would consume the sequence. That is a cancellation, and the code refuses it.

| Choice | What the parent does | What the code does |
| --- | --- | --- |
| `hold` | Nothing. This is the default. | No new signature from the held account. The 1747-drop claim stays uncertain. |
| `new_account` | Provision a different isolated Testnet account and point the mission signer at it. Do not submit anything from the held account. | A different account is not blocked by this claim. The old sequence stays unused. |
| `supersede` | Not available. | Refused. Override does not release the claim. |

## Wake and admission

`bin/wake` requires `FOUNDRY_MISSION_WAKE_TOKEN` (at least 32 characters, from mode-0600 `tokens.env`, not the command line) and `FOUNDRY_MISSION_WAKE_PHRASE=WAKE-MISSION-CONTROL`. It writes one 10-minute lease for one control tick. The lease sets `execute` and `spend` to false. A second wake in that window is refused.

If `FOUNDRY_MISSION_CHALLENGE_FILE` points at an unpaid x402 version 2 file for the exact sanctions URL, the tick appends `challenge.admitted` and sets `payable` to false. It does not rewrite discovery, mint a candidate, reserve drops, or sign. The retained invoice is refused. The same invoice cannot be admitted twice.

## Publisher

The desk ingest is `POST https://aether-foundry-desk.vercel.app/api/missions/ingest`. The body is the sanitized snapshot. The header is `Authorization: Bearer` plus `FOUNDRY_MISSION_INGEST_SECRET` (at least 32 characters). The private Blob store `aether-mission-snapshots` (`store_P9565xtEmQV5q207`) is connected to project `aether-foundry-desk`, and `BLOB_READ_WRITE_TOKEN` is set for production, preview, and development. The desk writes `missions/public-status.json` there and reads it before the git snapshot. A lower sequence is refused. The public status route stays read-only. No GitHub token is required. GitHub remains the fallback reader until the first stored snapshot exists. The ingest secret authorizes one desk path. It is not a git credential.

## One-shot purchase

The parent approved a new isolated Testnet account. The code path is separate from wake.

`bin/wake` still cannot spend. `bin/start` still stays asleep and does not set execute. `bin/account` only appends `control.new_account`. `bin/execute` is the only purchase command. The release pack follows every `node src/...` path in `bin/`, so `execute-once.js` and `publish-health.js` are in `SHA256SUMS`. The previous archive copied the two shell scripts and omitted those modules. `bin/execute` does not require `worker.json` to be unlatched, and a signer it spawns receives `FOUNDRY_MISSION_LEDGER`. Purchases stay stopped. The signed payment used a memo and omitted XRPL `InvoiceID`. Public exact verifiers that reject memos fail that blob. `bin/reconcile` only reports unless the audit phrase is set, and it refuses the older no-window claim. It allows one signature, then refuses a second call. It does not rewrite `discovery.json`, does not mint a `cand-17` or `fee-retry` key, and does not release the prior claim. The new mission records `prior_claim_id`. The payment uses a live x402 version 2 `xrpl:1` accept, a new invoice, the exact sanctions URL, and payTo `rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs`. Sequence and `LastLedgerSequence` come from a validated network-1 read and are stored before the blob is offered. The daily cap still includes the 1747-drop hold. Caps stay 1 XRP and 5 XRP.

`bin/publish` writes a health snapshot with `worker_asleep: true` and `execute: false` while purchase execution is off. The asleep worker also refreshes that snapshot when `FOUNDRY_MISSION_PUBLISH=yes`, at most every four minutes, so an idle feed does not sit on an old observation time. Neither path signs. The Vercel ingest secret is still not approved for production. Until the same secret is on the desk and in mode-0600 `tokens.env`, publish writes the local snapshot and returns `no_ingest_secret`. No token is read from the desk.

## Challenge echo

The payment header echoes the selected live xrpl:1 accept. It does not add `areFeesSponsored` when the challenge omits it, and it keeps the boolean when the challenge includes it. Invoice binding remains SHA-256 of the invoice string, with no `Memos` and no `NetworkID` on the signed payment. `signed_fields` records that omission for new lines. Older ledger lines that stored `NetworkID: 1` are not rewritten. A 402 diagnostic stores only short `reason`, `invalidReason`, and `errorReason` tokens. `@x402/xrpl` 2.30.0 still rejects a challenge whose extra lacks `areFeesSponsored`. The public seller 402 does not show whether its facilitator adds that field. Exact echo is not proof the next attempt will verify. The facilitator host named in discussion is `https://xrpl-facilitator-testnet.t54.ai`. No successful envelope was available, and this tree does not call it.

## Claim absence

`./bin/reconcile` does not release because a validated head is past `LastLedgerSequence` and a pruned server says `txnNotFound`. The selector is `FOUNDRY_MISSION_RECONCILE_MISSION`. Omitting it exits `PLAN`. A report-only run sets that selector and not `FOUNDRY_MISSION_RECONCILE_PHRASE`. `FOUNDRY_MISSION_RECONCILE_RPC` may be `https://testnet.honeycluster.io` for the documented testnet archive. Other hosts are refused. The worker and the signer do not read it. `released` stays false. An apply run also sets `FOUNDRY_MISSION_RECONCILE_PHRASE=AUDIT-RELEASE-PASSED-WINDOW` and uses the reconcile token already in the environment. Release requires a validated account-creation proof and `complete_ledgers` continuous from that creation ledger through `LastLedgerSequence`. The creation ledger is read from the validated account and its creating transaction. It is not saved back onto the claim as a guessed earliest ledger. `msn5b5c3223e5e88526` still has no `LastLedgerSequence` and is not released. A testnet full-history range may start at 32570 rather than ledger 1.

## Exact next ops

These are parent actions. This cloud run does not perform them, does not sign, and does not change either account file.

1. Keep the installed `ensure-up` block before `exit 0`. Do not add `bin/execute` to that hook. Do not stop 8787, 8792, or 8793.
2. Install the new tar asleep with `./bin/start`. Do not set `FOUNDRY_MISSION_EXECUTE` in the asleep process. Do not delete `asleep`.
3. Copy the current `account.json` to `account.held.json`, mode 0600, and leave that file unused. Put the new faucet wallet at `account.json`, mode 0600. Do not submit from the held account. Its sequence stays unused.
4. Save a new unpaid 402 for the sanctions URL. Do not reuse invoice `1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45` or the expired `1793999217-8ff0cbc91cfe49c6-d1753-3be1077708929724e01824ae`. The file must be younger than `maxTimeoutSeconds` at the moment of `bin/execute`.
5. Source `tokens.env`. Record the decision, naming the open claim. `FOUNDRY_MISSION_ACCOUNT_TOKEN` must already be in the environment and at least 32 characters. This command does not spend.

```sh
FOUNDRY_MISSION_ACCOUNT_PHRASE=USE-NEW-ISOLATED-ACCOUNT \
FOUNDRY_MISSION_PRIOR_CLAIM=msn5b5c3223e5e88526 \
./bin/account
```

6. One purchase. `FOUNDRY_MISSION_EXECUTE_TOKEN` must already be in the environment. A second run is refused. Do not run the `cand-17-51ec932c8e` fee retry.

```sh
FOUNDRY_MISSION_EXECUTE_PHRASE=EXECUTE-ONE-FRESH-PURCHASE \
FOUNDRY_MISSION_CHALLENGE_FILE=/path/to/fresh-402.json \
MISSION_XRPL_ADDRESS=<new isolated address> \
./bin/execute
```

7. Health publish, with execute unset. `FOUNDRY_MISSION_PUBLISH_TOKEN` must already be in the environment. This uploads only when `FOUNDRY_MISSION_INGEST_SECRET` is present locally and on the desk. Do not create a GitHub PAT for it.

```sh
FOUNDRY_MISSION_PUBLISH_PHRASE=PUBLISH-HEALTH-SNAPSHOT \
./bin/publish
```

8. EVM gas stays unauthorized. Do not cancel `msn5b5c3223e5e88526`.

## Not done

The open claim has no seller body and no ledger window. This repository run did not execute the purchase. EVM gas is not authorized. The ingest secret is not in this tree; until the parent sets it on both sides, the desk keeps reading the last git snapshot.
