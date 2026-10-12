# Machine — Agent Work License

**Status:** demo on XRPL Testnet. Not in the director catalog until a live `tesSUCCESS` hash is archived.  
**Network:** XRPL Testnet only (`network_id` 1). XRPL Labs primary, Ripple altnet fallback.  
**Thesis:** An XLS-20 NFToken is a license to hire the Foundry Atelier agent for one job. Holding it is the right to call the paid work endpoint. The agent checks the holder on the ledger before it works. A later resale pays the issuer the transfer fee.

```bash
npm run license:demo
npm run license:demo -- --pace 1.5s
FOUNDRY_SIGNER_TOKEN=... npm run license:demo -- --live --pace 1.5s
```

Dry-run is the default. It loads no seed. Live mode talks to the loopback signer. This process never reads `W2_REGULAR_SEED` or `W4_REGULAR_SEED`.

## Flow

1. **Mint.** W2 Atelier mints a license. Flags are burnable and transferable (`9`). `TransferFee` is `5000` (5%). Taxon `20261012`, not the Walk-In taxon.
2. **List.** W2 creates a sell offer at 2 XRP with no Destination. Same shape as the Walk-In shop, a different price and a different product line.
3. **Buy.** W4 accepts the offer. The first sale is from the issuer, so the 5% fee is not charged. A later sale between other accounts pays W2 that fee on-ledger.
4. **Redeem.** The buyer asks the local redeem server for a one-time challenge, signs it, and posts it back. The server checks the signature, `account_nfts`, remaining uses, expiry, and the nonce.
5. **Deliver.** The job is a ledger analysis of the buyer account (balance, owner count, objects, sequence). If Scribe is listening on `AETHER_SCRIBE_URL` or `127.0.0.1:8792`, it summarizes. If it is not, the sentence is fixed. The redeem server listens on `127.0.0.1:8793` (`AETHER_LICENSE_PORT`).
6. **Settle.** One use, or the last use of a multi-use license: the holder submits `NFTokenBurn`. Uses still remaining only advance a counter in `lab/ledger-log.jsonl`.

## Why the holder burns

`NFTokenCreateOffer` with an empty amount is not a valid buyback. A zero-price offer would be a second sale, not a receipt. The owner of an NFToken can burn it. The mint sets `tfBurnable` as well, so the issuer could burn a token it does not hold by setting `Owner`. That path is documented and not on the signer allowlist. The demo burns from W4, the account that holds the token, with no `Owner` field.

## Metadata

The full JSON lives in [`desk/`](./desk/) and, for a live mint, in `lab/licenses/<sha256>.json`. The URI on the token is `aflic:1:` plus the SHA-256 of the canonical JSON. It is short enough for the 256-byte URI field and it does not drift if the prose around it changes.

| Job | Uses | File |
|-----|------|------|
| `ledger-analysis-report` | 1 | `desk/ledger-analysis-report.uses1.json` |
| `scribe-summary` | 1 | `desk/scribe-summary.uses1.json` |
| `ledger-analysis-report` | 3 | `desk/ledger-analysis-report.uses3.json` |

## Where the shop and the watch fit

Walk-In stays a 10 XRP sell offer on W2. The remint watch still treats that price as the Walk-In line. A 2 XRP sell offer is the license line. When the last known license offer is gone, the same watch writes a detect-only plan. It does not remint either line. Founder remint of Walk-In is still `npm run remint:walk-in` on the Foundry box.

## Diagrams

| Picture | File |
|---------|------|
| Lifecycle | [`diagrams/lifecycle.png`](./diagrams/lifecycle.png) |
| Redeem checks | [`diagrams/redeem.png`](./diagrams/redeem.png) |
| Wallets, fee, watch | [`diagrams/economics.png`](./diagrams/economics.png) |

SVG sources are beside the PNGs. Mermaid sources are the `.mmd` files.

## Docs

| File | Role |
|------|------|
| [PRIMITIVES.md](./PRIMITIVES.md) | Transaction fields and the challenge string |
| [RUNBOOK.md](./RUNBOOK.md) | Commands, signer, and what to print |
| [THREAT.md](./THREAT.md) | Replay, wrong holder, signer scope |
| [RESULTS.md](./RESULTS.md) | No trial hash until a live demo is archived |
