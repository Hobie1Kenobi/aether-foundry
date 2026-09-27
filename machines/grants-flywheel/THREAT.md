# THREAT — grants flywheel

Adversary sign-off for outbound W6 Payments. The desk never signs.

## Paying the house

**Claim:** the scanner treats STRANGER, BUYER, or W0–W6 as a "user" and W6 pays itself.

**Mitigation:** eligibility reads `web/lib/xrpl-public.ts` `WALLETS` and drops every address in that object. STRANGER is in the object. An explicit `--destination` that hits the map exits 2 before a seed is read. The Payment builder rejects `Destination == W6`. Unit tests lock the Day-30 buyer in and STRANGER out.

## Double pay

**Claim:** a second run sends another 1 XRP to the same buyer for the same reason.

**Mitigation:** `lab/grants/ledger.jsonl` and `grant_paid` lines in `lab/ledger-log.jsonl` block that destination and reason for 7 days. The newest 20 W6 Payments are scanned for the `aether-grant` / `grants-flywheel` memo. A missing timestamp is treated as still inside the window. After 7 days a new grant is allowed; that is the flywheel, not a retry of the same receipt.

## Drain

**Claim:** `--drops` empties W6, or a script pulls the amount from W0.

**Mitigation:** the payer account is hardcoded to W6. At or above 50 XRP the command throws unless `lab/motions/` covers that destination and amount. A separate float check refuses a grant that would leave under 10 spendable XRP. The optional AETH path cannot set `SendMax` above 2 XRP. There is no loop over the candidate list.

## Mainnet or CI

**Claim:** the same flags sign on mainnet, or GitHub Actions loads `W6_SEED`.

**Mitigation:** HTTP and websocket hosts must be `*.rippletest.net`. Mainnet hostnames and Xahau hosts throw. NetworkID 0 throws before `submit`, including when it arrives from `server_info` before any `account_tx`. `CI` and `GITHUB_ACTIONS` throw before the seed file is read. `--dry-run` never calls the seed loader. Seeds are not written into git, the desk, or `RESULTS.md`.

## Memo or hash fiction

**Claim:** a failed Payment, or a plan, is archived as `grants_paid`.

**Mitigation:** `recordGrant` throws unless `result` is `tesSUCCESS` and `hash` is 64 hex. `--record` is what updates `market/pnl.md`, `lab/ledger-log.jsonl`, and `RESULTS.md`. The director pack pointer for this machine stays `null` until that hash exists. Do not invent one.

## RPC thrash

**Claim:** discovery pages the full history of W2 and W3.

**Mitigation:** each `account_tx` request sets `limit` to 20 and does not send `marker`. NFT issuer reads stop at 20. A failed `nft_info` or `nfts_by_issuer` is skipped. Local `ledger-log.jsonl` still supplies the Day-30 buyer when RPC is down (`--no-rpc`).
