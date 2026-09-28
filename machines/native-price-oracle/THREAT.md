# THREAT — Native Price Oracle

Adversary stamps these before `--live`.

## Amendment spoof

`OracleSet` is legal only when `feature` reports `PriceOracle` `enabled: true` on this connection. A missing name is not `enabled: false` and is still a refuse. A file that says enabled does not override a live `feature` call. The keeper reads `feature` on the same HTTP URL it would submit to.

## Wrong network

Network id `0`, Xahau mainnet `21337`, and any other id are a hard refuse. Hosts `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, and `xahau.network` are refused before a fetch. If `server_info` omits `network_id`, stop.

## Honor-system relapse

The ticket path must not call `amm_info` or `book_offers`, and must not price from a process-local float when `ledger_entry` fails. A missing oracle is `ORACLE_MISSING`. Publishing a quote in the URI that was not decoded from the Oracle node puts the pack back on Machine #4's honor system.

## LastUpdateTime versus the epoch scar

`OracleSet.LastUpdateTime` is UNIX seconds. The amendment rejects a stamp more than 300 seconds from the ledger close. Do not convert it with `rippleEpoch.js`.

`EscrowCreate.FinishAfter` and `CancelAfter` stay Ripple Epoch. A UNIX `FinishAfter` is the scar. The ticket builder refuses a `FinishAfter` above 1e9.

## Self-dealing the book

W1 can still lean on a thin CLOB. Weight stays 0.7 on the AMM unless a side is empty. The oracle does not make the pool an independent market.

## Signer

`OracleSet` is **not** in `src/runtime/allowlist.json` `tx_types`. The MCP `sign_tx` path refuses it. Do not add it in this pack.

`--live` uses `W5_REGULAR_SEED` through the daemon submit helper. Account is W5. W0 is refused by `assertSigningTx`. The desk and GitHub Actions do not hold that seed.

Intent name, if a later operator allowlists it: `oracle_set`. Pin it to W5, document id 1, and no XRP amount.

## CI

`CI` or `GITHUB_ACTIONS` throws before any seed read. A dry-run that opens `W5_REGULAR_SEED` is a bug.
