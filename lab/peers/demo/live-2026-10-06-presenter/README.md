# Net chat live presenter run

One XRPL Testnet session, already validated `tesSUCCESS` on the operator box. The hashes below are those results. This folder does not contain a seed, a chat token, an Ollama key, a memo body, or a transcript.

- Network: `xrpl:1`, NetworkID 1
- Session: `s_85f7038788f850df`
- Inbox: W3 `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`
- Scout: W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ`
- Model: `glm-5.3-flash`
- Desk: read-only. Nothing here signs.

| Frame | Hash | Ledger |
| --- | --- | --- |
| `aether-peer-hello` | `FB374FBF6ECB79CABC2419B3A6637B7C95DF30DE776057A8A21B3EBCECA34E20` | 21313898 |
| `aether-peer-ack` | `0B7E8CE70DAEDD6FC8DB1866F16149F0D62F937EF1BEA282E9E4D89AA61D3CD7` | 21313901 |
| `aether-session-offer` | `BD5EC65D6C617F3F9B27F932DC86B7D6F89556878EED56C7EFB822A3B21FB430` | 21313904 |
| `aether-session-accept` | `6569A6D1AB5CC8A8A1651D7B86D3A48C6B0BA9502BF18D98771ED63C38CAA972` | 21313906 |
| `aether-session-close` | `0EF48A72A08A45CA64247925CECE89F1A1A26C2CD34ACB5F93B09354E858A058` | 21313914 |

Live LLM turns ran on the operator box. The transcript is not archived here, and neither is its sha256. A sha256 from a different run is not this session.

`lab/peers/hellos.jsonl`, `frames.jsonl`, and `sessions.jsonl` are not filled from this note. Herald rows need the memo body (nonce, challenge, endpoint, and the accept chat nonce). Those fields are not in the hash list, so they are not reconstructed. `/net`, `/api/peers/hellos`, and `/api/peers/sessions` stay empty until a live herald or hello scan appends the real rows.
