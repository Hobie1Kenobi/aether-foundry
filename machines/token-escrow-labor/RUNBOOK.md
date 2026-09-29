# RUNBOOK — TokenEscrow labor

**Default:** dry-run. **Network:** XRPL Testnet id 1. **Create and cancel:** W2 regular key. **Finish:** W4 regular key. **Rebate:** W6 regular key. Never W0. Never a Vercel env.

## 1. Probe

```bash
npm run director:snapshot
npm run frontier:probe
```

Read `lab/frontier/amendments.json`. `TokenEscrow` must be `enabled: true` and `network_id` must be `1`. If it is disabled, stop. Do not submit `EscrowCreate`. Do not lock XRP and call it the labor ticket.

The three scripts call `feature` themselves and refuse when that live row is disabled or missing. Exit 2. `tx` is null.

## 2. Which asset

```bash
npm run frontier:token-escrow-create
```

Expect JSON with `"mode": "dry-run"`, `"signed": false`, `"key_loaded": false`, `"network_id": 1`.

- `lab/metrics.json` currently holds `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED`. Expect `asset.kind` `mpt` and `Amount` `{ "mpt_issuance_id", "value": "1" }`.
- If that field is null: `asset.kind` is `aeth`. `Amount.currency` is `4145544800000000000000000000000000000000`, `issuer` is W0, `value` is `"1"`.

`predicted_sequence` is W2's current sequence when `account_info` answered. It is not the archived `OfferSequence`. `FinishAfter` and `CancelAfter` are below `1000000000`. `deliverable.submitted` is false. `key_env` is the name `W2_REGULAR_SEED`. The process must not print a seed.

Exit 0 when the amendment is on. Exit 2 with `"tx": null` when `TokenEscrow` is off.

To force a known id before metrics has one:

```bash
npm run frontier:token-escrow-create -- --issuance-id <48 hex>
```

The flag must match `lab/metrics.json` when that field is already set.

## 3. Holder W2 is already authorized

F2 issuance `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED` is live. Issuer W5. W2 opted in (`B46088B6AF5E5F7457718F9733D47E9D12A23B195EF1180A80664F20C8368452`), then W5 authorized (`79BFF663AB029843FCE293C3049E516D28A5AE7FA756F5E44EB57A801EEBA8FF`). W2's `MPToken` Flags are `2`. Do not opt W2 in again and do not authorize W2 again.

`tfMPTRequireAuth` order for any later holder, including W4 before a finish can deliver: holder opt-in first, then issuer authorize. The reverse returns `tecOBJECT_NOT_FOUND`.

W4 `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN` still needs that order. Dry-run `--opt-in --holder ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN` prints the unsigned `MPTokenAuthorize`. The F2 live command only loads daemon seed names (`W2`, `W3`, `W5`, `W6`). `W4_REGULAR_SEED` is not one of them, so W4 signs that unsigned transaction on the box, and only then does W5 authorize W4.

W2 must hold at least 1 `AETH-LABOR` before create. A Payment from W5 is not this pack.

The AETH fallback needs W2's trust line and a balance of at least 1 AETH. W0 already set `asfAllowTrustLineLocking` (`B0F214DB216FF071515C2F125DB8A429273ED769CDBFB7071891741E3079E1F6`). Do not send `AccountSet` from W0.

## 4. Publish one create (Foundry box)

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:token-escrow-create -- --live
```

This refuses `CI` and `GITHUB_ACTIONS`. It signs with `W2_REGULAR_SEED` and checks the address against W2's `regular_key` in `lab/director-state.json`.

On `tesSUCCESS` the script appends `lab/ledger-log.jsonl` and prints `offer_sequence` and `escrow_index`. Copy `offer_sequence` into the finish or cancel command. Leave RESULTS blank until that hash exists. Do not paste `predicted_sequence`.

## 5. Finish path

Use the sequence from a create whose `FinishAfter` has passed and whose `CancelAfter` has not.

```bash
npm run frontier:token-escrow-finish -- --offer-sequence <n> --quoted <create quote>
```

Expect `EscrowFinish` with `Owner` W2, `Account` W4, and no `FinishAfter`. When the oracle quote is higher than `--quoted`, `rebate.tx` is a `CheckCreate` from W6 to W2, `SendMax` at most `"1000000"`, `Expiration` in Ripple Epoch. When the quote is flat or lower, `rebate.tx` is null.

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:token-escrow-finish -- --live --offer-sequence <n> --quoted <create quote>
```

That submits the finish only. Add `--rebate` to submit the Check as well, after the finish hash is in hand. The daemon still refuses `EscrowFinish`; this script is the path that signs it, and it still refuses the scar.

## 6. Cancel path

Use a second create. Wait until its `CancelAfter`.

```bash
npm run frontier:token-escrow-cancel -- --offer-sequence <n>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:token-escrow-cancel -- --live --offer-sequence <n>
```

Expect `EscrowCancel` from W2, `Owner` W2. Do not pass `--finish-after`. The command rejects a time flag.

Refused, exit 2, `tx` null:

```bash
npm run frontier:token-escrow-finish -- \
  --owner rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth \
  --offer-sequence 21094052
```

## 7. Stranger check

After a live create, the escrow index from the JSON:

```bash
curl -sS https://s.altnet.rippletest.net:51234 \
  -H 'content-type: application/json' \
  -d '{"method":"ledger_entry","params":[{"index":"<64 hex escrow index>","ledger_index":"validated"}]}'
```

`FinishAfter` and `CancelAfter` on that object are Ripple Epoch (well below `1000000000`). `Amount` is the MPT object or the AETH IOU. It is not a drops string.

`/api/status` `mpt_issuance_id` is still the F2 field. This pack reads it and does not replace it.

## 8. Not this pack

Do not submit `CredentialCreate` or `PermissionedDomainSet`. Do not submit `Batch`. Do not add `Condition`. Do not finish the scar.
