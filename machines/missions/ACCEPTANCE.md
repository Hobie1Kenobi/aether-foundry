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

## Exact next ops

These are parent actions. This cloud run does not perform them.

1. Choose `hold` or `new_account`. Do not choose supersede.
2. Keep the installed `ensure-up` block before `exit 0` when the release SHA changes. Take a backup of the script first. Do not add `exit 0` above the block.
3. Install the new tar asleep. Run `./bin/start` only from that release. Do not set `FOUNDRY_MISSION_EXECUTE`. Do not delete `asleep`. Do not stop 8787, 8792, or 8793.
4. Create one random ingest secret of at least 32 characters. Set it as sensitive Vercel env `FOUNDRY_MISSION_INGEST_SECRET` on project `aether-foundry-desk` for production. Put the same value in `tokens.env` mode 0600, with `FOUNDRY_MISSION_PUBLISH=yes`. The Blob store is already connected. Do not create a GitHub PAT for this. Until this secret exists on both sides, ingest stays unconfigured and the desk keeps the git snapshot.
5. Optional control tick, still with execute off: source `tokens.env`, set the wake phrase, and run `bin/wake`. A challenge file admitted by that tick is not payable. The 20:56 invoice is already outside its 600-second window, so a purchase still needs a newer live 402.
6. A purchase remains a separate decision after the sequence choice, a fresh 402, and execute still off until that decision is explicit. Do not retry `cand-17-51ec932c8e`. Do not cancel `msn5b5c3223e5e88526`.

## Not done

The open claim has no seller body and no ledger window. No purchase has completed. EVM gas is not authorized. The ingest secret is not in this tree; until the parent sets it on both sides, the desk keeps reading the last git snapshot.
