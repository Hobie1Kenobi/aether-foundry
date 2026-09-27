# Aether Foundry Charter

**Network:** XRPL Testnet (and altnets as required). Mainnet is out of scope for this operator.

**Thesis:** Compose ≥3 XRPL primitives into machines that produce measurable surplus on testnet.

## Governance (week 1)

- Director signs from W0; regular key pattern on W1–W6 once keys exist.
- Outgoing Treasury payments ≥ 50 test XRP require a written motion in `/lab/motions/`.
- Seeds never enter this repository. Public addresses live in `wallets.md`.

## Governance (week 2 target)

- SignerList on W0 with weights: Director / Treasurer / Atelier / Market.
- Signer policy and quorum documented here when activated.

## Roles

See `org.md`. Adversary must sign off before any machine ships on-chain. Protocol vetoes unsupported primitives. Archivist vetoes unreproducible results.

## Identity

- DIDSet on W0 URI → raw GitHub charter (this file).
- NFT taxon `20260927` (Foundry Artifact collection).
- IOU code `AETH` issued from Treasury (on-ledger hex `4145544800000000000000000000000000000000` — 4-char nonstandard); DefaultRipple on unless an experiment documents otherwise.
- AMM AETH/XRP: `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`.
