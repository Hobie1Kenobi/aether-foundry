# PRIMITIVES — governance board

**Network:** XRPL Testnet. Network id **1**. WebSocket `wss://testnet.xrpl-labs.com`.

## SignerListSet

| Field | Value |
|-------|--------|
| Account | W0 `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` |
| SignerQuorum | 3 |
| SignerEntries | Director 2, Treasurer 2, Atelier 1, Market 1 |
| SignerListID | 0 (the only list an account can have) |

Entries are sorted by decoded AccountID before submit. rippled rejects an unsorted list (`temBAD_SIGNER`). A signer cannot be the account itself. Quorum must be between 1 and the sum of weights (`temBAD_QUORUM` otherwise). Four entries is inside the legacy cap of 8, so this list does not depend on ExpandedSignerList.

After MultiSignReserve (enabled 2019-04-17) a new signer list counts as **one** owner object (`lsfOneOwnerCount`). It does not cost 2 + N objects.

The signer addresses do not need to be funded. An unfunded signer can sign only with the master key of that address, which is the key we generate. A multi-signature cannot itself be satisfied by another multi-signature.

Setup is signed by the W0 master key. The master stays enabled, so the same key can replace the list later.

## SetRegularKey

| Field | Value |
|-------|--------|
| TransactionType | `SetRegularKey` |
| Account | W1, W2, W3, W4, W5, or W6 |
| RegularKey | address derived from `W1_REGULAR_SEED` … `W6_REGULAR_SEED` |

`AccountSet` does not carry `RegularKey`. This cut sends no `AccountSet`, so it cannot set `asfDisableMaster` (flag 4) in the same transaction.

The regular key must not equal the account's master address. Later transactions keep `Account` as the W1–W6 address and are signed by the regular key pair. The server matches `SigningPubKey` to `AccountRoot.RegularKey`.

The first `SetRegularKey` on an account is allowed to have a zero fee when `lsfPasswordSpent` is unset. The script still lets `autofill` attach a normal fee, which is above that minimum. Later rotations pay a normal fee and the flag stays set. A regular key is a field on AccountRoot, not an extra owner object, so it does not raise the reserve.

## Multi-sign Payment

xrpl.js path, used by `npm run gov:multisign`:

1. `client.autofill(tx, signerCount)` so the fee is at least `(signers + 1) × base fee`.
2. `wallet.sign(prepared, true)` on each signer. `SigningPubKey` on the outer tx is empty. Each signature sits in `Signers`.
3. `xrpl.multisign(blobs)` sorts the signers and returns one blob.
4. `submitAndWait` on that blob. The hash that counts is the validated response hash. Per-signer hashes are not the ledger id (a different signer set would hash differently).

Demo fields:

| Field | Value |
|-------|--------|
| Amount | `10000` drops (0.01 XRP) |
| Destination | W6 `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf` |
| SourceTag | `202609274` |
| Memo | type `foundry`, data `gov-quorum-demo` |
| Signers | Director weight 2, Market weight 1 |

## Explicit non-use

- No `AccountSet`, no `asfDisableMaster`, no `lsfDisableMaster`.
- No Xahau `SetHook` and no W7 twin in this cut.
- No `EscrowFinish` / `EscrowCancel`. The Unix-epoch BUYER scar stays put.
- No `Wallet.sign` under `web/`.
