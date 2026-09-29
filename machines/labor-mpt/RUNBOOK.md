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

## 4. Authorize W2

```bash
npm run frontier:mpt-labor-authorize -- --issuance-id <48 hex from the create>
```

Expect `MPTokenAuthorize` with `Account` W5, `Holder` W2, and `MPTokenIssuanceID` the 48-hex id. Then, on the box:

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:mpt-labor-authorize -- --live --issuance-id <48 hex>
```

Holder opt-in (creates the zero-balance `MPToken` on W2):

```bash
npm run frontier:mpt-labor-authorize -- --opt-in --issuance-id <48 hex>
FOUNDRY_DAEMON_LIVE=yes npm run frontier:mpt-labor-authorize -- --live --opt-in --issuance-id <48 hex>
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

Do not submit TokenEscrow, EscrowFinish, or EscrowCancel. Do not submit CredentialCreate. The NFT receipt shape is in PRIMITIVES. It is not a command.
