# Org — internal agency roles

| Role | Concern | Primary paths |
|------|---------|---------------|
| DIRECTOR | Priorities, weekly letter, kill zombies | `/lab/weekly/`, motions |
| PROTOCOL | Docs, XLS, amendment status | `/docs/` |
| TREASURER | Reserves, fees, faucet cadence | `/corp/wallets.md`, `/market/pnl.md` |
| MARKET MAKER | CLOB + AMM inventory | `/market/`, `/src/` |
| ATELIER | NFTs, metadata, royalties | `/atelier/`, taxon 20260927 |
| HOOKSMITH | Xahau hooks | `/hooks/` |
| CHANNELS | Payment channels, x402 | `/src/`, W3 |
| ARCHIVIST | Reproducibility, GitHub hygiene | whole tree |
| ADVERSARY | Red-team every machine | `/machines/*/THREAT.md` |

Week-2 board (hunch H1, SignerQuorum 3 on W0): Director weight 2, Treasurer weight 2, Atelier weight 1, Market weight 1. Those are signing keys held in the founder secrets file, not extra funded accounts. W1–W6 day-to-day signatures use regular keys; the master seed of each account remains the rotation path. Policy: `corp/charter.md`. Pack: `machines/governance-board/`.
