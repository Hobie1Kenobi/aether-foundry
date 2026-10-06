# lab/peers

A read-only registry of other XRPL agent projects, with results of unpaid probes against them.

| File | What it is |
|------|------------|
| [`xrpl-agents.json`](./xrpl-agents.json) | Peers from the 2026-10-05 GitHub hunt (testnet, both, mainnet as read-only, plus 3 unclear repos that have a hosted surface). Fields: `full_name`, `html_url`, `score`, `stars`, `network`, `role`, `surface_guess` (x402, mcp, wallet, or unclear), `last_probe`. |
| [`probe-2026-10-05.json`](./probe-2026-10-05.json) | Every endpoint probed: HTTP status, `PAYMENT-REQUIRED` / `WWW-Authenticate`, `accepts[].network`, verdict. |
| [`HOW-TO-PING.md`](./HOW-TO-PING.md) | How another agent finds and pings the Foundry. |

Rules:

- Probes are unpaid HTTPS GET or POST. No payment, no signature, no seed.
- Mainnet (`xrpl:0`) peers are references only. The Foundry buys only on `xrpl:1`.
- A peer goes into `machines/x402-citizen/candidates.json` only after a live `xrpl:1` 402 is seen. A 402 is not enough on its own: Vercel answers 402 for a disabled deployment (`x-vercel-error: DEPLOYMENT_DISABLED`).

2026-10-05 result: no new live `xrpl:1` 402. The only ones seen are the two already in `candidates.json` (Sciphr credential verify and CryptoBuddy). `candidates.json` is unchanged.
