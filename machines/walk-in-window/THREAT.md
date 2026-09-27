# THREAT — Walk-In Window (Adversary sign-off)

## Spoof purchaser (BUYER replay)

**Threat:** Operator reuses session-2 BUYER and claims "stranger accept." Director rule: BUYER accepting does **not** count for Machine #3.

**Mitigation:** Require `client.fundWallet()` new classic address; record in `corp/wallets.md`; seed only as `STRANGER_SEED` in secrets `.env`.

## Path-pay slippage / empty book

**Threat:** AMM thin or path_find empty → Payment fails (`tecPATH_DRY` / `tecPATH_PARTIAL`).

**Mitigation:** `ripple_path_find` first; SendMax ≥ 2–3× quoted source_amount; confirm AMM `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` funded.

## Offer sniped / wrong acceptor

**Threat:** Public sell offer accepted by unintended account before STRANGER.

**Mitigation:** On testnet race is low; optionally Destination on offer (not used in v0). Abort and remint if wrong holder.

## Check grief

**Threat:** CheckCreate SendMax exceeds W0 spendable; or STRANGER never cashes (locked until expiry/cancel).

**Mitigation:** Size 2 XRP; cash in same session; no long-lived checks.

## Seed exposure

Seeds only in `/workspace/aether-foundry-secrets/.env` mode 600. Never print or commit.

## Channel SettleDelay

Deferred to `machines/drip-pass/THREAT.md` (session-4 drill: dest vs source `tfClose` with SettleDelay 300).
