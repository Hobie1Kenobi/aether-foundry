# PRIMITIVES — Labor MPT

Three ledger objects, plus the NFT receipt this pack documents and does not submit.

## 1. MPTokenIssuance (`MPTokenIssuanceCreate`)

| Field | v0 |
|-------|----|
| Account | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| `AssetScale` | `0` (one labor unit is one integer) |
| `MaximumAmount` | `"1000000"` |
| `TransferFee` | `0` |
| `Flags` | `108` (`0x6C`) |
| `MPTokenMetadata` | XLS-89 hex, short keys |

Flags:

| Flag | Value | Set |
|------|------:|:---:|
| `tfMPTCanLock` | 2 | no |
| `tfMPTRequireAuth` | 4 | yes |
| `tfMPTCanEscrow` | 8 | yes, so F3 can lock a balance |
| `tfMPTCanTrade` | 16 | no. AETH IOU stays the AMM pair |
| `tfMPTCanTransfer` | 32 | yes |
| `tfMPTCanClawback` | 64 | yes |
| `tfMPTCanHoldConfidentialBalance` | 128 | no. That amendment is off |

`ImmutableFlags` is omitted. `DynamicMPT` is disabled, and that field is how immutability is declared. Do not invent it.

XLS-89 object (compact keys, the form that goes on the ledger):

| Key | Value |
|-----|--------|
| `t` | `LABOR` |
| `n` | `AETH-LABOR` |
| `ac` | `other` |
| `in` | `Aether Foundry` |
| `ai.symbol` | `AETH-LABOR` |

The ticker field allows only `A–Z` and `0–9`, six characters. `AETH-LABOR` is the name and `ai.symbol`.

`mpt_issuance_id` = `sequence` (uint32, 8 hex) ‖ issuer account id (40 hex). Later transactions pass that 48-hex string as `MPTokenIssuanceID`.

## 2. Issuer authorization (`MPTokenAuthorize`)

W5 signs. `Holder` is W2 unless `--holder` names another classic address. `Flags` is omitted, so this is an authorization, not `tfMPTUnauthorize`.

Because `tfMPTRequireAuth` is set, a holder cannot receive labor until this transaction has succeeded.

## 3. Holder opt-in (`MPTokenAuthorize`)

W2 signs the same transaction type with `Account` = W2 and no `Holder` field. That creates the holder's `MPToken` object (zero balance until a later payment). The box can sign it with `W2_REGULAR_SEED` via `--opt-in`. A stranger signs their own opt-in. This pack does not.

Outstanding amount after these two transactions is still zero. Moving units is a later Payment. It is not in this pack.

## 4. NFT receipt (documented, not submitted)

When a labor unit is delivered, W2 mints a transferable NFT whose URI points at this README and the issuance id. `receiptSketch` in `src/frontier/mpt-labor.js` is that unsigned shape:

| Field | Value |
|-------|--------|
| `TransactionType` | `NFTokenMint` |
| Account | W2 |
| Taxon | `20260927` |
| Flags | transferable |
| TransferFee | `1000` (1% to the NFT issuer, W2) |
| URI | this README `#mpt=<issuance id>&symbol=AETH-LABOR` |

F2 does not submit the mint. F3 is the TokenEscrow of the MPT against that receipt. Finish and cancel stay out of this pack, and any `FinishAfter` there is Ripple Epoch.
