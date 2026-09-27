# Governance board — RESULTS

**Network:** XRPL Testnet  
**Date:** 2026-09-27  
**Hunch:** H1 (Director 2, Treasurer 2, Atelier 1, Market 1, quorum 3)  
**W0:** `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs`

## Live set

| Item | Hash |
|------|------|
| SignerListSet | not submitted |
| SetRegularKey W1–W6 | not submitted |
| Multi-sign Payment | not submitted |

`W0_SEED`…`W6_SEED` were not in this environment (`AETHER_SECRETS` unset, `/workspace/aether-foundry-secrets/.env` absent). No payment hash is recorded. `activated.json` is not created until `npm run gov:live` validates on the Foundry box.

`npm run gov:live` exited 1 with `Refusing to sign. No tx hash.` `CI=true npm run gov:live` exited 1 with `refusing to load seeds or sign in CI`.

## Read-only pre-state (`npm run gov:dry`)

Validated ledger **21101142**. Network id **1**. Base reserve **1000000** drops (1 XRP). Incremental reserve **200000** drops (0.2 XRP). These rows are `account_info` with `signer_lists: true`. They are not transactions.

| ID | Balance drops | OwnerCount | RegularKey | Signer lists | lsfDisableMaster | lsfPasswordSpent |
|----|---------------:|-----------:|------------|-------------:|------------------|------------------|
| W0 | 97999916 | 1 | none | 0 | no | no |
| W1 | 50032224 | 7 | none | 0 | no | no |
| W2 | 112009895 | 2 | none | 0 | no | no |
| W3 | 105994928 | 0 | none | 0 | no | no |
| W4 | 110010039 | 1 | none | 0 | no | no |
| W5 | 99999988 | 1 | none | 0 | no | no |
| W6 | 100000000 | 0 | none | 0 | no | no |

W0 owner delta for a new SignerList is **+1**. Projected reserve after the list: `1000000 + 2 × 200000 = 1400000` drops. Balance 97999916 is above that. No regular key is set on W1–W6, and `lsfPasswordSpent` is unset, so the first `SetRegularKey` on each account is still inside the free-fee window. The script pays autofill's normal fee anyway.

Signer addresses were not assigned. The dry-run does not read seeds.

## Foundry-box command

```bash
npm run gov:dry
npm run gov:live
npm run gov:multisign
```

`gov:live` generates `SIGNER_DIRECTOR_SEED`, `SIGNER_TREASURER_SEED`, `SIGNER_ATELIER_SEED`, `SIGNER_MARKET_SEED`, and `W1_REGULAR_SEED`…`W6_REGULAR_SEED` into the secrets file when they are missing, then submits. It prints public addresses only.
