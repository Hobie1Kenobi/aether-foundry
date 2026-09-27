# RUNBOOK — Drip Pass

## Prerequisites

```bash
chmod 600 /workspace/aether-foundry-secrets/.env
cd /workspace/aether-foundry
npm install
npm test   # rippleEpoch unit tests
```

WS: `wss://s.altnet.rippletest.net:51233`

## Ripple Epoch (escrow elsewhere — not channel fields)

```js
const { rippleNow, unixToRipple } = require('../../src/time/rippleEpoch.js');
// NEVER pass Unix into FinishAfter/CancelAfter on EscrowCreate
```

Channels use `SettleDelay` (seconds), not Ripple Epoch.

## Script

| Script | Purpose |
|--------|---------|
| `src/drip-pass-session.js` | Mint pass, channel, 3 claims, settle, optional Epoch Scar |
| `src/token-escrow-probe.js` | M1 TokenEscrow housekeeping (separate) |

```bash
node src/drip-pass-session.js
# writes /tmp/drip-pass-result.json — copy hashes into RESULTS.md
```

## Manual outline

1. Ensure BUYER funded (faucet POST destination or treasury Payment).  
2. Write `lab/drip/0001.md`–`0003.md`.  
3. W2 mint + sell; BUYER accept.  
4. BUYER `PaymentChannelCreate` → W3.  
5. For n=1..3: BUYER signs claim cumulative `2*n` XRP; W3 submits claim + memo.  
6. W3 `PaymentChannelClaim` + `tfClose`; wait SettleDelay; BUYER `tfClose` to settle.  
7. Log all hashes → RESULTS.md; append `lab/ledger-log.jsonl`.

## Safety

- Testnet only. No seeds in git or logs.

## Observed settle quirk (testnet 2026-09-27)

Destination `PaymentChannelClaim` + `tfClose` **deleted** the PayChannel immediately after claims (Balance delivered, remainder to source). A follow-up source `tfClose` returned `tecNO_TARGET`. Treat dest close as settle if the object is gone.
