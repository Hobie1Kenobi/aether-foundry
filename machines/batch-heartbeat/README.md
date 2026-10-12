# Machine — Batch Heartbeat

**Status:** spec-only until a tesSUCCESS hash. Atomic Batch is **enabled** on XRPL Testnet (network id 1). Re-probe 2026-10-12 09:53 CDT on XRPL Labs (`wss://testnet.xrpl-labs.com`, rippled 3.4.1, ledger 21481707): `BatchV1_1`, `fixBatchV1_2`, and `TicketBatch` are enabled. Earlier probes (through 2026-09-28) found the atomic amendments disabled. Those rows stay in RESULTS.  
**Network:** XRPL Testnet only. Primary host is XRPL Labs. Network id 1. No mainnet.  
**Thesis:** One all-or-nothing **Batch** heartbeat: accept a Foundry artifact sell offer, deposit XRP into the AETH/XRP pool, and stamp a DID, so inventory, liquidity, and the public claim move together or not at all.

## How to run

Dry-run is the default. It autofills and prints. It does not submit and it does not read a seed.

```bash
npm run batch:heartbeat
npm run batch:heartbeat -- --live
```

`--live` posts to the loopback signer at `127.0.0.1:8787`. It needs `FOUNDRY_AGENT_SIGN=yes` and `FOUNDRY_SIGNER_TOKEN`. It refuses `CI` and `GITHUB_ACTIONS`. The signer re-reads `feature` and refuses a network id other than 1.

## Wallets

| Wallet | Role | What it signs |
|--------|------|----------------|
| W2 | atelier | Prepare only, outside the Batch: `NFTokenMint` then a sell `NFTokenCreateOffer` to W1. Key `W2_REGULAR_SEED`, loaded by the signer. |
| W1 | market | The outer Batch and all three inners. Key `W1_REGULAR_SEED`. |
| W0 | treasury | Nothing. The signer does not load `W0_SEED` or the board seeds. |

The DID leg is `DIDSet` on **W1**. W0 already publishes the charter DID. A W0 inner would need a `BatchSigner`, and producing that signature would load the treasury seed or the board seeds into the signer. This signer does not do that. The stamp is the charter URI plus a timestamp on the market wallet:

`https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/corp/charter.md#heartbeat=<ISO timestamp>`

`Data` is JSON `{"machine":"batch-heartbeat","heartbeat":"<same stamp>"}`.

If the owner wants the stamp on W0 later, that needs an out-of-band signing path. This signer will not grow one.

## The Batch

One outer transaction, `Flags` `65536` (`tfAllOrNothing`). No `BatchSigners`. Three inners, in order, each with `tfInnerBatchTxn` (`1073741824`), `Fee` `"0"`, and an empty `SigningPubKey`:

1. `NFTokenAcceptOffer` of a W2 sell offer whose token is taxon `20261012` (not the Walk-In taxon `20260927`). Default price `10000` drops. Cap `100000` drops. Destination is W1.
2. `AMMDeposit` into `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`, single-asset XRP (`tfSingleAsset`), `Asset2` AETH issued by W0. Default `1000000` drops. Cap `2000000` drops.
3. `DIDSet` on W1, as above.

Prepare is a separate pair of transactions so the accept leg has a fresh offer. The Walk-In inventory is not sold. One `batch_heartbeat` per UTC day. Prepare is not day-capped, so a mint can be finished.

## Cost

Default spend is `10000` + `1000000` = `1010000` drops (about 1.01 XRP) plus the outer fee (a few dozen drops; the policy cap is `100000` drops). The first live run also locks about 0.4 XRP of owner reserve on W1 when the DID object and the LP trust line are new. The W2 sell-offer reserve returns when the accept succeeds.

## Director

`batch-probe` stays detect-only. It does not submit. While `src/batch/heartbeat.js` is in the tree, an enabled gate does not raise `batch_enabled` and does not hold the other routines. If that file is absent, `batch_enabled` still stops the wake and still does not submit.

## Non-goals

- No sequential faux-heartbeat.
- No generic `Batch` from the daemon or from any intent other than `batch_heartbeat`.
- No W0 seed in the signer process.
- No live submit from CI.
- No mainnet.
