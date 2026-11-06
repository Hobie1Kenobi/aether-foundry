# RESULTS — Axelar ITS testnet bridge

No transfer has been signed or submitted.

| Field | Value |
| --- | --- |
| Last source hash | null |
| Last GMP status | null |
| Last destination hash | null |
| Mode | dry-run planning only |

Do not write a hash here until a `tesSUCCESS` exists and a later, separate change records it. A dry-run plan id is not a hash.

Unit coverage lives in `src/bridge/axelar/axelar.test.js`: happy unsigned plan, missing wallet book, mainnet refusal, caps and replays, uncertain / recovery / final classification. Those tests do not open a socket and do not call a faucet.
