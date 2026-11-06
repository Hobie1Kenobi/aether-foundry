# Missions

Testnet mission engine for Aether Foundry. The loop is goal, plan, policy, act, observe, evaluate. The public desk only reads a sanitized snapshot.

**Authorized caps:** 1 XRP (`1000000` drops) per mission and 5 XRP (`5000000` drops) per America/Chicago day, including network fees, bridge gas, bridge custody, failed transaction fees, and amounts still pending or uncertain.

**Enabled:** off until an authenticated `control.activate` event with the phrase `ACTIVATE-XRPL1-MISSION-SPEND`. That event cannot raise the caps. Kill forces it back off. This process still does not submit; the box signer dry-run is the next step, and live submit needs `FOUNDRY_MISSION_EXECUTE=yes` plus `MISSION_XRPL_SEED` on the box only.

**Live spend:** 0. Simulation holds are not live spend. An XRPL account reserve is recorded separately and is not a fee and not available spend.

**First mission:** foreign `xrpl:1` discovery, qualify, capped purchase plan, payload check, artifact. House wallets and synthetic accounts are not foreign sellers and are not revenue. No foreign seller ends as `blocked` / `no_foreign_seller`.

**Bridge:** source inclusion and GMP states that are not destination-final stay `bridge_pending` or `uncertain`. Those outcomes are not retried. Destination-chain gas and any non-XRP asset stay unconfigured.

This pack is AI-assisted. It is not an audit.

```bash
npm run missions:status
```

Operator ledger: `lab/missions/` (gitignored). Public snapshot: `machines/missions/public-feed.json`.
