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

## Press headlines

`GET /api/wall` returns a `headlines` array. The desk merges two press sources and does not rewrite `programs.json`. Stage is `press`. `onchain.kind` is `none`. These rows are not ledger reads and they are not foundry claims. The desk does not sign.

Cointelegraph comes from the public Ripple tag RSS: `https://cointelegraph.com/rss/tag/ripple`. The route fetches that feed on the server, with a five-second timeout. Each row keeps the feed title and the article URL. The actor is `Cointelegraph`. The label is `Press headline. Not on-chain.` A failed fetch leaves those rows out. The amendment ticker still renders.

X comes from the X API v2 recent-search endpoint `https://api.x.com/2/tweets/search/recent`. The query is fixed in `web/lib/x-headlines.ts`. It is not an environment variable, so a request cannot turn the desk into an open search proxy. The query allowlists `@Ripple`, `@RippleXDev`, `@RippleX`, and `@bgarlinghouse`, plus the terms Ripple, RLUSD, and XRPL. Retweets and replies are excluded. A post from outside that account allowlist is kept only when its text mentions Ripple, RLUSD, XRPL, or XRP. The route asks for at most 10 posts, times out after five seconds, and keeps a three-minute in-memory cache on a warm server. It does not page. It does not scrape x.com HTML.

Each X row uses the API text, truncated, as the title. The actor is `@handle`. The URL is `https://x.com/{handle}/status/{id}`. The label is `X post. Not on-chain.` A row is emitted only when that response included the post. The desk does not invent posts. Text that matches the wall's banned secret pattern is dropped.

Auth is the server-only env var `X_BEARER_TOKEN` on the Vercel project `aether-foundry-desk`. `TWITTER_BEARER_TOKEN` is used only when the first name is unset. Do not prefix either name with `NEXT_PUBLIC_`. Do not commit a value. If the variable is missing, or the request fails, X headlines stay empty and `probe_notes` records a soft miss. Cointelegraph rows still render. Set the variable in Production (and Preview if that environment should match), then redeploy so the server process sees it.

The merge de-duplicates by URL, sorts newest first, and keeps at most 15 headlines. `/api/wall/rss.xml` includes the same items as press. After the bearer is set, `GET /api/wall` should show `"label": "X post. Not on-chain."` and `/wall` should show those posts on the ticker with an `X` mark.
