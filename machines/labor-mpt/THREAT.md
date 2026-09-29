# THREAT — Labor MPT

Adversary stamps these before `--live`.

## Amendment spoof

`MPTokenIssuanceCreate` and `MPTokenAuthorize` are legal only when `feature` reports `MPTokensV1` `enabled: true` on this connection. A missing name is not `enabled: false` and is still a refuse. `lab/frontier/amendments.json` does not override a live `feature` call. The script reads `feature` on the same HTTP URL it would submit to.

If the row is disabled, the process prints `tx: null` and does not build a Payment or TrustSet in its place.

## Wrong network

Network id `0`, Xahau mainnet `21337`, and any other id are a hard refuse before `feature`. Hosts `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, and `xahau.network` are refused before a fetch. If `server_info` omits `network_id`, stop.

## Disabled amendments this pack must not pretend

| Amendment | On Testnet 3.4.1 | What we do |
|-----------|------------------|------------|
| `DynamicMPT` | disabled | No `ImmutableFlags`. |
| `ConfidentialTransfer` | disabled | No `tfMPTCanHoldConfidentialBalance`. |
| `TokenEscrow` | enabled | Still not used here. Finish and cancel are F3. No Unix `FinishAfter`. |
| `Credentials` | enabled | Not used here. F4. |

## Trading the labor unit

`tfMPTCanTrade` stays off. A labor book next to the AETH AMM would be a second price. The IOU pair is the pool.

## Signer

Neither MPT transaction is in `src/runtime/allowlist.json` `tx_types`. The MCP `sign_tx` path refuses them. Do not add them in this pack.

`--live` uses `W5_REGULAR_SEED` for the issuance and the issuer authorization, and `W2_REGULAR_SEED` for W2's opt-in. Account is never W0. The desk and GitHub Actions do not hold those seeds.

Intent names, if a later operator allowlists them: `mpt_labor_create`, `mpt_labor_authorize`.

## Invented id

A 64-hex ledger index is not an issuance id. A sequence read during dry-run is `predicted_mpt_issuance_id` and is not written to `lab/metrics.json`. `/api/status` reads that file and returns null until a real id is there. A 64-hex value in the file is refused, not published.

## CI

`CI` or `GITHUB_ACTIONS` throws before any seed read. A dry-run that opens `W5_REGULAR_SEED` is a bug.
