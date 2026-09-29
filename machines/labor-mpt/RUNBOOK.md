# RUNBOOK — Labor MPT

**Default:** dry-run. **Network:** XRPL Testnet id 1. **Issuer signer:** Foundry box, W5 regular key. **Holder:** W2. Never W0. Never a Vercel env.

## 1. Probe

```bash
npm run director:snapshot
npm run frontier:probe
```

Read `lab/frontier/amendments.json`. `MPTokensV1` must be `enabled: true` and `network_id` must be `1`. If it is disabled, stop. Do not submit `MPTokenIssuanceCreate`. Do not fake it with a Payment.

The create and authorize scripts also call `feature` themselves and refuse when that live row is disabled or missing.

## 2. Dry-run the issuance

```bash
npm run frontier:mpt-labor-create
```

Expect JSON with `"mode": "dry-run"`, `"signed": false`, `"key_loaded": false`, `"network_id": 1`, `"mpt_issuance_id": null`, and an unsigned `MPTokenIssuanceCreate`:

- `Account` = W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`
- `MaximumAmount` = `"1000000"`
- `AssetScale` = `0`
- `Flags` = `108`
- metadata name `AETH-LABOR`, ticker `LABOR`

`predicted_mpt_issuance_id` is 48 hex when `account_info` returned a sequence. It is not the archived id. `key_env` is the name `W5_REGULAR_SEED`. The process must not print a seed. Exit 0 when the amendment is on. Exit 2 with `"tx": null` when `MPTokensV1` is off.

## 3. Publish (Foundry box only)

On the box, with the regular-key env loaded outside git:

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:mpt-labor-create -- --live
```

This refuses `CI` and `GITHUB_ACTIONS`. It signs with `W5_REGULAR_SEED` and checks the address against W5's `regular_key` in `lab/director-state.json`. It does not go through MCP `sign_tx`.

On `tesSUCCESS` the script reads `mpt_issuance_id` from the transaction metadata (48 hex). It appends `lab/ledger-log.jsonl` and sets `lab/metrics.json` `mpt_issuance_id` from that value. If the metadata omits the id, the hash is still archived and the metrics field stays null. Do not paste the dry-run prediction into the file.

## 4. Authorize a holder

`tfMPTRequireAuth` requires holder opt-in before issuer authorize. Issuer authorize first returns `tecOBJECT_NOT_FOUND` (`2EF521755BCF81A4320BE57EF05B3AE73E2AA3C4B77788CD20F6739DA4260BA9`).

W2 already finished that order for issuance `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED`: opt-in `B46088B6AF5E5F7457718F9733D47E9D12A23B195EF1180A80664F20C8368452`, then issuer authorize `79BFF663AB029843FCE293C3049E516D28A5AE7FA756F5E44EB57A801EEBA8FF`. The holder `MPToken` Flags are `2`. F3 assumes that holder and does not repeat these two transactions.

A new holder still uses this order. Opt-in (creates the zero-balance `MPToken`):

```bash
npm run frontier:mpt-labor-authorize -- --opt-in --issuance-id <48 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:mpt-labor-authorize -- --live --opt-in --issuance-id <48 hex>
```

Then issuer authorize (`Account` W5, `Holder` the opted-in account):

```bash
npm run frontier:mpt-labor-authorize -- --issuance-id <48 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:mpt-labor-authorize -- --live --issuance-id <48 hex>
```

`--opt-in` for an address outside W1–W6 prints the unsigned transaction and refuses `--live`. That account signs for itself.

If `--issuance-id` is omitted, the script reads `lab/metrics.json`. While that field is null, the command exits 2 with `MISSING_ISSUANCE`.

## 5. Stranger check

After a live create, fetch the issuance with the 48-hex id (not a guessed ledger index):

```bash
curl -sS https://s.altnet.rippletest.net:51234 \
  -H 'content-type: application/json' \
  -d '{"method":"ledger_entry","params":[{"mpt_issuance":"<48 hex>","ledger_index":"validated"}]}'
```

Decode `MPTokenMetadata` from hex to JSON. `n` is `AETH-LABOR`. `MaximumAmount` is `1000000`.

`/api/status` field `mpt_issuance_id` is that same 48-hex string once `lab/metrics.json` has it, and null before that. The desk does not sign.

## 6. Not this pack

Do not submit TokenEscrow, EscrowFinish, or EscrowCancel from this pack. Those commands are `npm run frontier:token-escrow-create`, `frontier:token-escrow-finish`, and `frontier:token-escrow-cancel`. Do not submit CredentialCreate. The NFT receipt shape is in PRIMITIVES. It is not a command.
