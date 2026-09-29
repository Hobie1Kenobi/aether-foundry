# RESULTS — TokenEscrow labor

**Status:** live on XRPL Testnet id 1 (finish + cancel trials).  
**Network:** XRPL Testnet, id 1.  
**Amendment:** `TokenEscrow` enabled (hash `138B968F25822EFBF54C00F97031221C47B1EAB8321D93C7C2AEAF85F04EC5DF`). Re-probed before `--live`.  
**Box merge:** `e60206f14210d0b81471f2f2ad1eddb871ae5c13` (PR #26 squash).  
**Session:** 2026-09-28 ~19:34 CDT. Create/cancel: W2 RegularKey. Finish: W4 RegularKey. Never W0.

## On the ledger

| Field | Value |
|-------|--------|
| Asset | `AETH-LABOR` |
| `mpt_issuance_id` | `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED` (F2) |
| F2 create hash | `1DDA337DD81833BEE768DED7E54889A4F92D5DC5958F75760417801909C02BCB` |
| Ops fund (W5→W2, 10 units) | `E460F70FA5CB48838843C95437FB3E1CF41F0B14AFDFDE54055CFB8E80E252EE` |
| W4 opt-in | `24DC0A629A638F17F263FCCD729BF5247EC2C7C0F75928734ACAD5EC4882B33A` |
| W4 issuer authorize | `EF53EA937FC90395F7DC0595C433F8E5123D97FFD9403266EF4E5C04E6BC6A1E` |
| Trial A create hash | `BA9C9471DF8D1BE092C0296F780E864CDA17A998013980FD46B88B7BC73F95FF` |
| Trial A `offer_sequence` | `21093737` |
| Trial A escrow index | `CF9C2B6D2EF1CD360C4071D211B1919C0874FD43092F0996ED7C93E41AD3EA35` |
| Trial A `FinishAfter` / `CancelAfter` | `843957320` / `843957970` (Ripple Epoch) |
| Trial A `EscrowFinish` hash | `7536CB47DD446BF5E09ABC1A65CB0633FC556EB83E1C261257F07644A7815DA1` |
| Trial A Check hash | null (`rebate` `NO_DRIFT`) |
| Trial B create hash | `6489302245EE9E6D00506B2045446AB28C7FA2816C20CD25DB18CDCA778D547E` |
| Trial B `offer_sequence` | `21093738` |
| Trial B escrow index | `81E1D2525DB058508FFDBEEB156390162C6D576AB9F4725D8103D16B6AAC7633` |
| Trial B `FinishAfter` / `CancelAfter` | `843957302` / `843957372` (Ripple Epoch) |
| Trial B `EscrowCancel` hash | `FC7CB7C6D6CA5DA7EBCEE2C48CAECDC6599128DDD5258C167D7305BE50A58797` |
| NFT mint hash | null. The deliverable is unsigned |

Times on live rows are Ripple Epoch (all well below `1000000000`). Stranger check after create: `ledger_entry` on Trial A index showed MPT `Amount`, Ripple Epoch locks. After finish/cancel both escrow indexes are `entryNotFound`. W4 holds `MPTAmount` `1` (Flags `2`); W2 holds `9`.

## Trial A — finish

```json
{
  "ts": "2026-09-29T00:34:30.756Z",
  "action": "token_escrow_labor_create",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "destination": "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  "asset": "mpt",
  "mpt_issuance_id": "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED",
  "hash": "BA9C9471DF8D1BE092C0296F780E864CDA17A998013980FD46B88B7BC73F95FF",
  "offer_sequence": 21093737,
  "escrow_index": "CF9C2B6D2EF1CD360C4071D211B1919C0874FD43092F0996ED7C93E41AD3EA35",
  "finish_after": 843957320,
  "cancel_after": 843957970,
  "ledger_index": 21130586,
  "result": "tesSUCCESS"
}
```

```json
{
  "ts": "2026-09-29T00:35:28.788Z",
  "action": "token_escrow_labor_finish",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  "owner": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "hash": "7536CB47DD446BF5E09ABC1A65CB0633FC556EB83E1C261257F07644A7815DA1",
  "offer_sequence": 21093737,
  "ledger_index": 21130603,
  "result": "tesSUCCESS"
}
```

Check rebate row left blank: oracle quote flat at `0.01022008` (`NO_DRIFT`).

## Trial B — cancel (second create)

```json
{
  "ts": "2026-09-29T00:34:43.417Z",
  "action": "token_escrow_labor_create",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "destination": "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  "asset": "mpt",
  "mpt_issuance_id": "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED",
  "hash": "6489302245EE9E6D00506B2045446AB28C7FA2816C20CD25DB18CDCA778D547E",
  "offer_sequence": 21093738,
  "escrow_index": "81E1D2525DB058508FFDBEEB156390162C6D576AB9F4725D8103D16B6AAC7633",
  "finish_after": 843957302,
  "cancel_after": 843957372,
  "ledger_index": 21130590,
  "result": "tesSUCCESS"
}
```

```json
{
  "ts": "2026-09-29T00:36:22.411Z",
  "action": "token_escrow_labor_cancel",
  "network": "XRPL Testnet",
  "network_id": 1,
  "account": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "owner": "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "hash": "FC7CB7C6D6CA5DA7EBCEE2C48CAECDC6599128DDD5258C167D7305BE50A58797",
  "offer_sequence": 21093738,
  "ledger_index": 21130619,
  "result": "tesSUCCESS"
}
```

The live commands also appended these rows to `lab/ledger-log.jsonl`.

## Ops notes

- OutstandingAmount was `0` after F2 authorize; box ops funded W2 with 10 labor units from issuer W5 before create (Payment is not the F3 pack).
- W4 required holder opt-in then issuer authorize (`tfMPTRequireAuth` order) before finish delivery.
- Trial times used short Ripple Epoch offsets (`--finish-after` / `--cancel-after`), not Unix.

## Commands that do not submit

```bash
npm run frontier:token-escrow-create
npm run frontier:token-escrow-finish -- --offer-sequence <n> --quoted <decimal>
npm run frontier:token-escrow-cancel -- --offer-sequence <n>
```

Credentials and Batch have no hash here.
