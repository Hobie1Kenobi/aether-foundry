# Wall of Change

A curated wire of XRPL institutional primitives and named programs. It is not a bank leaderboard and it is not a logo strip.

The desk renders it at [https://aether-foundry-desk.vercel.app/wall](https://aether-foundry-desk.vercel.app/wall). JSON: `/api/wall`. RSS: [/api/wall/rss.xml](https://aether-foundry-desk.vercel.app/api/wall/rss.xml).

The desk does not sign. It does not submit. Mainnet dots come from a read-only `server_info` and `feature` probe of `https://xrplcluster.com/` (network id 0) inside this merge only. Any other method, path, or host is refused before fetch. There is no second mainnet host. A failed probe stays `unknown` and is not stored as `enabled: true`. Submit paths elsewhere still refuse `xrplcluster.com`.

## Files

| File | Role |
|------|------|
| `programs.json` | Editorial rows. 12–20. One sentence, one stage, one rail. |
| `sources.json` | Citation map. Every program points at keys in this file. |
| `last-seen.json` | Amendment dots last acknowledged. The card's left bar pulses only when a live dot differs. |

Foundry twin rows (`foundry-heartbeat`, `foundry-oracle`, `foundry-labor-mpt`, `foundry-credential-domain`) do not store ledger ids here. `GET /api/wall` fills them from the same read as `/api/status`. A missing id stays `onchain.kind: none`. A failed RPC does not become `enabled: true`.

## Stage

`rumor` `press` `sandbox` `devnet` `testnet` `mainnet-pilot` `mainnet-live`

`mainnet-live` requires an https explorer URL and an on-chain kind other than `none`. Press without a hash stays `press`. RippleNet messaging, ODL production settlement, public XRPL, MAS sandbox, and Devnet are different rails. Name the one you mean.

`rumor` is omitted from the RSS feed and hidden on the card unless the filter is All.

## Clock

Testnet prefers `lab/frontier/amendments.json` when `probed_at` is under 36 hours. Otherwise the route calls `server_info` and `feature` on `https://s.altnet.rippletest.net:51234` (network id 1). Devnet uses `lab/frontier/amendments-devnet.json` or `https://s.devnet.rippletest.net:51234` (network id 2). Mainnet has no cached file. Each read calls `server_info` and `feature` on `https://xrplcluster.com/` and keeps the dots only when `network_id` is 0. `enabled: true` is on. `enabled: false` with a majority close time is voting. `enabled: false` with no majority is off. A missing name stays unknown.

`last-seen.json` records the mainnet column read at 2026-09-30T03:36:35Z. The route does not rewrite that file. Batch is whatever the live read says. This folder does not mark Batch enabled.
