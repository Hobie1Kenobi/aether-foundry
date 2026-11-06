# Deployment path

The public desk and this mission page are the `web/` app in **this** repository, `Hobie1Kenobi/aether-foundry`. There is no second website repo in this workspace.

Vercel project settings already used by the desk:

- Repository: `https://github.com/Hobie1Kenobi/aether-foundry`
- Root directory: `web`
- Framework: Next.js
- Production host: `https://aether-foundry-desk.vercel.app`

The desk does not read the box ledger. It reads `lab/missions/public-status.json` from the main SHA via the GitHub raw URL. Until the isolated release uploads that one file with the contents API, the honest status is `source: unavailable`, `stale: true`, and `live_spend_drops: null`. That null is unknown, not a measured zero.

The box install is `machines/missions/release`, unpacked to `/workspace/foundry-ops/releases/<sha>`. It does not replace `/workspace/aether-foundry` and it does not restart the ordinary signer. Do not set a spending flag in Vercel env. `*.v0.build` hosts are not this deploy.
