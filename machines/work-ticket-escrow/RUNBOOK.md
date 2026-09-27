# RUNBOOK — Work-Ticket Escrow v0

## Prerequisites

```bash
# secrets outside git
chmod 600 /workspace/aether-foundry-secrets/.env
cd /workspace/aether-foundry
npm install   # xrpl, dotenv
```

WS: `wss://s.altnet.rippletest.net:51233`

## Ripple Epoch helper

**NEVER pass Unix timestamps as FinishAfter/CancelAfter.** Use `src/time/rippleEpoch.js`.
See also `docs/ripple-epoch.md`.

```js
const RIPPLE_EPOCH_OFFSET = 946684800;
const rippleNow = () => Math.floor(Date.now()/1000) - RIPPLE_EPOCH_OFFSET;
```

## Scripts (this repo)

| Script | Purpose |
|--------|---------|
| `src/health.js` | account_info W0–W4 + AMM + reserves |
| `src/place-four-clean.js` | 4× tfPassive OfferCreate from W1 |
| `src/work-ticket-trials.js` | mint Artifact #1, sell, accept, escrow (use finish script for times) |
| `src/work-ticket-trials-finish.js` | Trial A finish + Trial B cancel with Ripple Epoch |

## Trial A (happy path) — manual outline

1. `client.fundWallet()` → BUYER; store seed in secrets as `BUYER_SEED` only.
2. W2 `NFTokenMint` taxon 20260927, TransferFee 1000, URI = README raw URL hex.
3. W2 `NFTokenCreateOffer` sell; BUYER `NFTokenAcceptOffer`.
4. BUYER `EscrowCreate` Amount=10 XRP, Destination=W4, FinishAfter=now+20, CancelAfter=now+180 (**Ripple time**).
5. Wait until ledger time > FinishAfter; W4 (or BUYER) `EscrowFinish` with Owner=BUYER, OfferSequence=create seq.
6. Log hashes → RESULTS.md.

## Trial B (cancel path)

1. BUYER `EscrowCreate` 2 XRP → W4, FinishAfter=now+25, CancelAfter=now+40 (CancelAfter > FinishAfter).
2. Wait until ledger time > CancelAfter.
3. BUYER `EscrowCancel`.
4. Log hashes → RESULTS.md.

## Safety

- Never print or commit seeds.
- `submitAndWait` only on testnet WS above.
