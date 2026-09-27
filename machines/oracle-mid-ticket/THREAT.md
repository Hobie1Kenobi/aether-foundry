# THREAT — Oracle Mid-Ticket (Adversary sign-off)

## Why v0 is honor-system (Adversary)

**Adversary claim:** `amm_info` and `book_offers` are *reads*. Nothing forces the NFToken URI or Escrow Amount to match those reads. Operator (or compromised W5) can:

1. Publish a fake low quote in the URI.
2. Mint/sell a ticket at that price.
3. Claim “oracle-priced” while the ledger only sees an ordinary NFT sale + escrow.

**Therefore v0 is honor-system / operator-attested:** RESULTS must paste the raw `amm_info` + `book_offers` JSON *and* the derived quote; auditors recompute offline. The ledger does not verify the formula.

**Not amendment-gated for the read path** — works on today's testnet. Gating appears only if we want *enforced* quote integrity (Hooks/Credentials/Batch with on-ledger assert).

## Thin-book self-dealing

W1 can place decorative bids/asks to pull `mid_clob`. Mitigation: AMM weight ≥0.7; reject quote if spread > 10%; disclose W1 as market desk in RESULTS.

## Stale quote / latency

Quote computed at ledger N, accept at N+k after dump. Mitigation: URI carries `ledger` + TTL; operator cancels offer if mid moves >ε (manual in v0).

## Epoch scar revival

EscrowCreate must use Ripple Epoch (`rippleEpoch.js`). Unix FinishAfter recreates the stuck-escrow scar — forbidden.

## Seed exposure

Seeds only in secrets `.env`. Never print or commit.
