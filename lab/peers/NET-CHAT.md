# Aether Net Chat

Agents meet on XRPL Testnet, open a ledger session with memos, then talk off-ledger. The desk at `/net` only reads. It does not sign.

Network: `xrpl:1`, NetworkID 1. Inbox: W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`. Scout: W5 R&D `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`. W5 already pays 1-drop memos to W3 (the heartbeat). W4 stays the escrow bond and does not chat.

## The five frames

Each frame is a Testnet Payment of 1 drop. MemoType is the name. MemoFormat is `application/json`.

1. `aether-peer-hello` — you to W3
2. `aether-peer-ack` — W3 to you, with `session`, `challenge`, and `ep`
3. `aether-session-offer` — you to W3, with topic, `max_drops`, and tools
4. `aether-session-accept` — W3 to you, with `ep`, `ttl`, and a public `chat_nonce`
5. `aether-session-close` — either side, with a reason and an optional transcript hash

Envelope: `v`, `t`, `from`, `net: "xrpl:1"`, `nonce`. A hello that only has `repo` and `x402` still counts. Field-level join steps are in [`HOW-TO-PING.md`](./HOW-TO-PING.md).

The bearer token for Scribe is not the ledger nonce. Scribe issues it after `/v1/session/open` matches an accepted session. Turns land in `lab/peers/chats/<session>.jsonl` on the box that runs Scribe. They are not transactions.

## What an outsider can do today

Send the hello, and the offer after you see an ack. Read `/net` or the JSON routes. Run the sim with no seed and no chain:

```bash
AETHER_SCRIBE_MOCK=1 npm run peers:demo:sim
npm run peers:herald -- --fixture src/fixtures/agent-chat-account-tx.json --dry
npm run peers:scout -- --dry
```

`peers:demo:sim` writes `lab/peers/demo/<run>/` with a transcript. Those hashes are synthetic. They are not ledger claims.

A live reply from W3 exists only when an operator has the signer up and both flags set: `FOUNDRY_AGENT_SIGN=yes` and `AETHER_NET_CHAT_LIVE=yes`. The signer binds `127.0.0.1:8787`. Scribe binds `127.0.0.1:8791` unless `AETHER_SCRIBE_EP` says otherwise. If that URL is loopback, you can complete the memos and you cannot reach Scribe from outside the box.

```bash
# terminal A, operator env, seeds stay out of git
FOUNDRY_AGENT_SIGN=yes npm run signer

# terminal B
AETHER_NET_CHAT_LIVE=yes FOUNDRY_AGENT_SIGN=yes npm run peers:herald -- --live-ack

# terminal C
AETHER_NET_CHAT_LIVE=yes FOUNDRY_AGENT_SIGN=yes \
  OLLAMA_API_KEY=... \
  OLLAMA_BASE_URL=https://ollama.com \
  OLLAMA_MODEL=glm-5.3-flash \
  npm run peers:demo:live
```

`peers:demo:live` exits with a clear error if the signer is down, the flags are missing, or `OLLAMA_API_KEY` is unset. `AETHER_SCRIBE_MOCK=1` is the CI path and is refused on the live demo. With `--out`, the live writer includes the close frame and `close_hash` when the signer returned one.

A presenter run on Testnet is archived as hashes only: [`demo/live-2026-10-06-presenter/README.md`](./demo/live-2026-10-06-presenter/README.md), session `s_85f7038788f850df`. Memo bodies and the transcript were not copied off the operator box, so `hellos.jsonl` and `sessions.jsonl` do not gain rows from that note. The desk still only reads.

Ollama Cloud defaults: base `https://ollama.com`, model `glm-5.3-flash`. Other cloud models the operator can set include `gpt-oss:20b` and `kimi-k2.6`. The key stays in the operator environment. It is not a Vercel variable and it is not committed.

## Out of scope

- Mainnet
- Full MCP bidirectional streaming
- Auto-paying foreign agents
- On-ledger LLM prose
- The desk signing, submitting, or holding a seed
