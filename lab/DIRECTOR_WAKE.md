# Director wake contract

The Director resumes from `lab/director-state.json`. Routines read that file. They do not reconstruct the company from chat, `OPERATOR.md`, or a pile of session notes when the file is present and fresh.

The file is public. It holds addresses, ledger indexes, and pack hash pointers. It does not hold seeds, family-seed strings, or mainnet hosts. `npm run director:snapshot` and `npm run director:wake` do not import `xrpl` or `xahau` and do not call `Wallet.sign`.

Schema version is `1` (`kind: aether.director-state`). A failed RPC does not invent a ledger index and does not replace the file.

## Commands

```bash
npm run director:snapshot
npm run director:wake
npm run director:wake -- --check --quiet --routine morning-health
```

`director:snapshot` is a read-only refresh of XRPL Testnet (`https://s.altnet.rippletest.net:51234`, network id 1) and Xahau Testnet (`https://xahau-test.net`, network id 21338). It also GETs the desk and the toml. Canonical hosts only.

`director:wake` prints a continuation card (human text, then `--- JSON ---`). It does not hit RPC. `--json` prints the card JSON only.

| Exit | When |
|------|------|
| 0 | Card printed. With `--check`, every selected alert is quiet. |
| 2 | `--check` and at least one alert. |
| 1 | Missing file, invalid schema, unknown routine, or a snapshot RPC failure. |

`--quiet --check` prints nothing on green and writes `code: message` lines to stderr on alert. That is the same quiet-vs-alert shape as the Walk-In watcher, with one difference: a sold-out window is an alert here (exit 2). The watcher still exits 0 after it writes a dry-run plan, because CI must not go red for a sale.

Default `--max-age-hours` is 36. Older than that, every routine alerts `stale` and must snapshot before acting. If the snapshot RPC fails, stop. Do not fill in a guessed ledger.

## What a snapshot refreshes

Events that must run `npm run director:snapshot` before the next routine acts:

| Event | Why |
|-------|-----|
| Morning health | Desk, toml, W0 spendable, SignerList, and RegularKeys may have moved overnight. |
| Weekly NAV | Spendable drops, AETH outstanding, and AMM amounts are the digest. |
| Batch probe | `feature` is the only honest source of `watched.batch.atomic_enabled`. |
| Walk-In watcher `walk_in_sold_out` in `lab/ledger-log.jsonl` | The offer id in the file is stale the moment the sell offer is taken. |
| Any session that changes offers, the AMM, the SignerList, or a RESULTS hash | Refresh the ledger half, then stamp the card. |
| W7 HookHash drift | The Xahau `account_objects` type `hook` read is the live hash. |

Future listeners should call the snapshot, then `director:wake --check`. They should not parse `OPERATOR.md` for balances.

## Merge without clobbering

Snapshot rebuilds networks, wallets, machines, watched objects, probes, and `updated_at`.

It keeps these three fields when the current file already validates:

- `next_actions` (exactly three non-empty strings)
- `blockers` (founder-only; may be empty)
- `last_session_id` (string, or null when no session has stamped it)

Anything else a human typed into the JSON is replaced. Put session notes in those three fields or in `lab/sessions/`. If the current file is invalid, snapshot refuses to write, so a broken card is not wiped by a good RPC read.

Pack hash pointers (`machines.*.last_result_hash`, `watched.w7_hook.pack_hook_hash`, `watched.walk_in_offer.pack_offer_id`) come from the machine packs already in git. Snapshot does not mint new hashes. Live ids (offer, SignerList, HookHash, ledger index, balances) come from validated RPC or the field stays unwritten.

`npm run health` is not this path. That script can faucet and pay. Morning health uses the wake check.

## Quiet versus alert

| Routine | Quiet (exit 0) | Alert (exit 2) |
|---------|----------------|----------------|
| `morning-health` | Desk HTTP 200, toml HTTP 200, W0 spendable at least 1 XRP, SignerList `matches_h1`, master key still enabled, RegularKeys `matches_pack`, file fresh | `desk`, `toml`, `treasury`, `signer_list`, `regular_keys`, `stale` |
| `weekly-nav` | W0–W6 spendable drops, AMM amounts, and `aeth_outstanding` are present. The digest prints the numbers. A changed NAV is not an alert. | `nav`, `stale` |
| `batch-probe` | `watched.batch.atomic_enabled` is false. `TicketBatch: true` is not the gate. | `batch_enabled` when atomic Batch flips on. `batch_unknown` when the amendments are missing. Do not submit a Batch transaction from this alert. |
| `walk-in-remint` | `watched.walk_in_offer.status` is `open`. Strangers buy with `npm run buy:walk-in` while it is open. The desk does not sign. | `walk_in_sold_out`. Remint only on the Foundry box (`npm run remint:walk-in`). CI does not sign. |
| default (`--check` with no routine) | All of the above, plus W7 `hook_hash` equals the pack pointer | Adds `hook` |

`unique_counterparties` is not in this file. Weekly NAV still reads `market/pnl.md` for that count. Do not invent it here.

## Fields each routine reads

### morning-health

- `updated_at`
- `probes.desk.http_status`
- `probes.toml.http_status`
- `wallets.W0.spendable_drops`
- `wallets.W0.address`
- `watched.w0_signer_list.quorum`
- `watched.w0_signer_list.matches_h1`
- `watched.w0_signer_list.master_disabled`
- `watched.regular_keys.matches_pack`
- `networks.xrpl_testnet.validated_ledger_index`

### weekly-nav

- `updated_at`
- `wallets.W0.spendable_drops`
- `wallets.W1.spendable_drops`
- `wallets.W2.spendable_drops`
- `wallets.W3.spendable_drops`
- `wallets.W4.spendable_drops`
- `wallets.W5.spendable_drops`
- `wallets.W6.spendable_drops`
- `watched.testnet_nav_spendable_drops`
- `watched.aeth_outstanding`
- `watched.amm.account`
- `watched.amm.amount_aeth`
- `watched.amm.amount_xrp_drops`
- `networks.xrpl_testnet.validated_ledger_index`

`watched.testnet_nav_spendable_drops` is the sum of W0–W6 `spendable_drops` from the same snapshot. It is not a second RPC.

### batch-probe

- `updated_at`
- `watched.batch.atomic_enabled`
- `watched.batch.amendments`
- `networks.xrpl_testnet.http`

### walk-in-remint

- `updated_at`
- `watched.walk_in_offer.status`
- `watched.walk_in_offer.offer_id`
- `watched.walk_in_offer.nftoken_id`
- `watched.walk_in_offer.amount_drops`
- `wallets.W2.address`

## Continuation card

`director:wake` prints the MASTER_PROMPT §12 card from the file:

- network ids, public URLs, and last validated ledger indexes (`networks.xrpl_testnet`, `networks.xahau_testnet`)
- W0–W7 public addresses and spendable drops
- open Walk-In offer, AMM account and amounts, W0 SignerList quorum, W7 hook
- `next_actions` (three)
- `blockers` (founder-only)

After a session, set `last_session_id` to the session note stem (for example `2026-09-27-8`) and rewrite `next_actions` / `blockers` if the plan changed. The next snapshot keeps that card.

## Clock

`updated_at` is ISO-8601 in `America/Chicago` with a numeric offset (`-05:00` or `-06:00`). Wake parses that offset. Do not write a naive local time.

## What this file is not

- Not a seed store. A `seed` / `secret` / `private_key` key, or a family-seed value, fails validation and is not written.
- Not a mainnet config. Network id 0 and 21337, and hosts such as `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, and `xahau.network`, are refused.
- Not a desk signer. The desk stays read-only. This file is for routines and the next session, not for `Wallet.sign`.
- Not a second copy of RESULTS. `last_result_hash` is a pointer into the pack that already recorded the hash.
