# lab/peers

A read-only registry of other XRPL agent projects, with results of unpaid probes against them.

| File | What it is |
|------|------------|
| [`xrpl-agents.json`](./xrpl-agents.json) | Peers from the 2026-10-05 GitHub hunt (testnet, both, mainnet as read-only, plus 3 unclear repos that have a hosted surface). Fields: `full_name`, `html_url`, `score`, `stars`, `network`, `role`, `surface_guess` (x402, mcp, wallet, or unclear), `last_probe`. |
| [`probe-2026-10-05.json`](./probe-2026-10-05.json) | Every endpoint probed: HTTP status, `PAYMENT-REQUIRED` / `WWW-Authenticate`, `accepts[].network`, verdict. |
| [`HOW-TO-PING.md`](./HOW-TO-PING.md) | How another agent finds and pings the Foundry. |
| [`hellos.jsonl`](./hellos.jsonl) | Append-only log of inbound `aether-peer-hello` Payments to W3. Created on the first new hello. |

Rules:

- Probes are unpaid HTTPS GET or POST. No payment, no signature, no seed.
- Mainnet (`xrpl:0`) peers are references only. The Foundry buys only on `xrpl:1`.
- A peer goes into `machines/x402-citizen/candidates.json` only after a live `xrpl:1` 402 is seen. A 402 is not enough on its own: Vercel answers 402 for a disabled deployment (`x-vercel-error: DEPLOYMENT_DISABLED`).

2026-10-05 result: no new live `xrpl:1` 402. The only ones seen are the two already in `candidates.json` (Sciphr credential verify and CryptoBuddy). `candidates.json` is unchanged.

## Peer hello watcher

`npm run peers:hello` reads one validated `account_tx` page for W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` on `https://s.altnet.rippletest.net:51234` (network id 1). A Payment to W3 counts when MemoType is `aether-peer-hello`, or when a memo `purpose` equals that string and another memo holds the JSON body. Each new row in `hellos.jsonl` has `network`, `account`, `hash`, `ledger`, `memo` (`MemoType`, `MemoFormat`, `MemoData`, `repo`, `x402`), and `seen_at`.

The watcher does not sign, pay, or reply. It does not edit `xrpl-agents.json` or `candidates.json`. Re-scans skip hashes already in the log. The page is capped (`--limit`, default 100, max 200) and the request does not send a marker.

## Net chat

[`NET-CHAT.md`](./NET-CHAT.md) is the session layer on top of hello: ack, offer, accept, close, then off-ledger speech. `npm run peers:herald` appends `frames.jsonl` and `sessions.jsonl` in this directory. Default mode observes and does not sign. Live ack needs the localhost signer and `AETHER_NET_CHAT_LIVE=yes`. `npm run peers:demo:sim` writes a synthetic transcript under `demo/<run>/`. Those hashes are not ledger claims. The desk reads hellos and sessions and does not sign.

```bash
npm run peers:hello -- --dry
npm run peers:hello -- --fixture src/fixtures/peer-hello-account-tx.json --dry
npm run peers:hello -- --fixture src/fixtures/peer-hello-account-tx.json --record --root /tmp/peer-hello
npm run peers:hello
```

The fixture hashes are synthetic. Use `--dry` or `--root /tmp/peer-hello` for that file. `--record` on a fixture writes; a live run writes unless `--dry` is set. `--alert` exits 2 when the log grew. `--hands FILE` (or `AETHER_PEER_HELLO_HANDS`) appends one JSON notice for agent-hands. If that write or hook throws, the jsonl line stays and the process still exits 0 (or 2 with `--alert`). `.github/workflows/peer-hello-watch.yml` runs the live scan and commits `hellos.jsonl` when it changes. It does not load a seed.
