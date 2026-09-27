# Machine #1 — Work-Ticket Escrow (stub)

**Status:** proposed / not yet packed  
**Network:** XRPL Testnet only  
**Thesis:** Escrow a work ticket (XRP or AETH) against an Artifact NFT deliverable; release on finish or return on timeout.

## Primitive composition (≥3)

1. **EscrowCreate / EscrowFinish / EscrowCancel** — time-locked work deposit (W4 ESCROW as custodian or peer-to-peer).
2. **NFTokenMint / NFTokenCreateOffer / NFTokenAcceptOffer** — Artifact receipt + optional sell offer to client.
3. **Payment (AETH IOU)** — settle surplus or bounty in Foundry units via W0-issued AETH (trust line required).
4. *(Optional fourth)* **AMMSwap** — convert AETH↔XRP at the seeded pool `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` for payout currency preference.

## Happy path (sketch)

1. Client TrustSets AETH (if paying in AETH) or holds XRP.
2. Client EscrowCreates deposit to W4 with `FinishAfter` / `CancelAfter` window.
3. Atelier mints work Artifact under taxon `20260927` with URI → ticket metadata.
4. On acceptance: EscrowFinish → treasury/atelier; optional NFT offer to client.
5. On timeout: EscrowCancel → client; Artifact remains Foundry-owned or burned via offer-to-issuer pattern.

## Success metrics

- Escrow finish rate ≥ target (document in RESULTS).
- Cycle time escrow→finish logged in `lab/ledger-log.jsonl`.
- No stranded OwnerCount / reserve on W4.

## Open questions

- Conditioned escrow (crypto-condition) vs pure time locks for v1?
- Should Artifact TransferFee (1% on genesis) apply to ticket NFTs?
- x402 gate in front of ticket creation?

## Non-goals (v1)

- Mainnet.
- Multisig release (week-2 SignerList may wrap this later).

See `machines/genesis-artifact/RESULTS.md` for the boot mint that this machine builds on.
