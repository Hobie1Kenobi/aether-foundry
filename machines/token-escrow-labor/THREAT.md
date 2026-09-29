# THREAT — TokenEscrow labor

Adversary stamps these before `--live`.

## Amendment spoof

`EscrowCreate`, `EscrowFinish`, and `EscrowCancel` in this pack are legal only when `feature` reports `TokenEscrow` `enabled: true` on this connection. A missing name is not `enabled: false` and is still a refuse. `lab/frontier/amendments.json` does not override the live `feature` call.

If the row is disabled, the process prints `tx: null`. It does not build a Payment, an XRP escrow, a Check, or an NFT in its place. It does not submit a sequence of other transactions and call that a TokenEscrow.

An issuance id with `MPTokensV1` disabled is also a refuse. The pack does not silently lock AETH instead.

## Wrong network

Network id `0`, Xahau mainnet `21337`, and any other id are a hard refuse before `feature`. Hosts `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, and `xahau.network` are refused before a fetch. If `server_info` omits `network_id`, stop.

## Unix time lock

`FinishAfter`, `CancelAfter`, and Check `Expiration` must be Ripple Epoch seconds. A value above `1000000000` is refused. Current Unix seconds (about `1.79e9` in 2026) sit above that line. Ripple Epoch in 2026 sits near `8.4e8`. The oracle ticket uses the same line. `OracleSet.LastUpdateTime` stays UNIX and is not copied onto the escrow.

The BUYER escrow at owner `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth`, sequence `21094052`, hash `6B9528CCE3F90E39A6D6E1A8A1F1E637E1A38B575F0DDB105785D3A66A319462` is refused by owner and by hash. Do not finish it. Do not cancel it.

## Daemon versus this command

`src/runtime/policy.js` `assertSigningTx` still refuses every `EscrowFinish` and `EscrowCancel`, so the daemon cannot touch the scar. This pack does not remove that ban and does not add these types to the agent allowlist.

`--live` signs with `W2_REGULAR_SEED` (create and cancel), `W4_REGULAR_SEED` (finish), and `W6_REGULAR_SEED` (`--rebate`). Account is never W0. The AETH `Amount.issuer` is W0's address. That is the currency issuer, not the signer. No `AccountSet` is sent from W0.

## What this pack must not pretend

| Amendment or field | What we do |
|--------------------|------------|
| `TokenEscrow` disabled | `tx: null`. Stop. |
| `Batch` | No `RawTransactions`. |
| `Credentials` / `PermissionedDomains` | No `CredentialIDs`, no `DomainID`. |
| Crypto-condition | No `Condition`, no `Fulfillment`. |

## CI

`CI` or `GITHUB_ACTIONS` throws before any seed read. A dry-run that opens a seed is a bug. `key_env` in the JSON is the variable name.
