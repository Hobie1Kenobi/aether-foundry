# RUNBOOK — Agent Work License

Testnet only. The signer is `127.0.0.1:8787`. Seeds stay in the signer. The demo process does not open `.env`.

## Dry-run (no signer, no seed)

```bash
npm run license:demo
npm run license:demo -- --pace 1.5s
npm run license:demo -- --job scribe-summary --uses 1
```

Each ledger step prints a 64-character hash and `https://testnet.xrpl.org/transactions/<hash>`. Dry-run hashes are synthetic and the line says so. Redeem and deliver are off-ledger. The last block is a summary table. `--pace 1.5s` waits 1.5 seconds between steps. `--pace 0` does not wait.

## Live demo

Start the signer on the Foundry box first. It already requires `FOUNDRY_AGENT_SIGN=yes` and `FOUNDRY_SIGNER_TOKEN` (16 characters or more). W2 and W4 regular keys must be in the signer environment. Do not export those seeds into the shell that runs the demo.

```bash
FOUNDRY_AGENT_SIGN=yes FOUNDRY_SIGNER_TOKEN=<token> npm run signer
```

Second shell, same token, no seeds:

```bash
FOUNDRY_SIGNER_TOKEN=<token> npm run license:demo -- --live --pace 1.5s
```

Optional: `AETHER_SCRIBE_URL=http://127.0.0.1:8791` if Scribe is already up (`AETHER_SCRIBE_MOCK=1 npm run peers:scribe` is enough for a canned summary). If Scribe is down, the job still finishes with the fixed sentence.

The signer proves `network_id` 1 before it signs. It autofills, signs, and submits on one connection. It does not resubmit that blob to the altnet. Reads in the demo may fail over from XRPL Labs to `s.altnet.rippletest.net` only before a signature exists.

`--live` under `CI` or `GITHUB_ACTIONS` exits 1.

## What the signer will sign

| Intent | Wallet | Transaction | Cap |
|--------|--------|-------------|-----|
| `license_mint` | W2 | `NFTokenMint` taxon `20261012`, flags `9`, fee `5000` | fee only |
| `license_list` | W2 | `NFTokenCreateOffer` sell, no Destination | exactly `2000000` drops |
| `license_buy` | W4 | `NFTokenAcceptOffer` of a W2 sell offer | offer must be `2000000` drops |
| `license_burn` | W4 | `NFTokenBurn` of the held token, no `Owner` | fee only |
| `/sign-challenge` | W4 | not a transaction | the canonical challenge string only |

`NFTokenBurn` is refused for every other intent and every other wallet. W0 stays unsigned. Walk-In remint is unchanged: W2, 10 XRP, and only when the Walk-In offer is `sold_out`.

## Redeem server alone

```bash
node src/license/server.js --port 8792
```

`GET /health` is unsigned. `POST /v1/license/challenge` and `POST /v1/license/redeem` are the two calls. The demo starts its own ephemeral port and does not need this process.

## After a sale

`npm run watch:walk-in` still reports the 10 XRP Walk-In offer. If `RESULTS.md` in this folder names a license OfferID and that 2 XRP offer is gone, the watch appends a detect-only plan under `lab/remint-plans/`. It does not mint a replacement. Listing another license is `npm run license:demo -- --live` again, or the same mint and list calls against the signer.

## Receipts

`lab/ledger-log.jsonl` gains `license_redeemed` and `license_settled`. A live burn adds `license_burned` with the hash. Nonces land in `lab/licenses/nonces.jsonl`. Metadata for the minted URI lands in `lab/licenses/<hash>.json`.
