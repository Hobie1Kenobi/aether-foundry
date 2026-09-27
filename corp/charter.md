# Aether Foundry Charter

**Network:** XRPL Testnet (and altnets as required). Mainnet is out of scope for this operator.

**Thesis:** Compose ≥3 XRPL primitives into machines that produce measurable surplus on testnet.

## Governance (week 1)

- Director signs from W0; regular key pattern on W1–W6 once keys exist.
- Outgoing Treasury payments ≥ 50 test XRP require a written motion in `/lab/motions/`.
- Seeds never enter this repository. Public addresses live in `wallets.md`.

## Governance (week 2 — in force)

Policy hunch **H1**. Quorum math is tested. The ledger `SignerListSet` is Foundry-box gated until `machines/governance-board/RESULTS.md` records a hash. This section is the board the live script installs. It is not a later design target.

**Account:** W0 TREASURY `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` on XRPL Testnet only. No Xahau twin in this cut.

**Custody:** the operator generates the four signer seeds and the founder holds them in the secrets file. That simulates a board. It is not independent custody.

| Persona | Weight | Seed env (value never in git) | Address |
|---------|-------:|-------------------------------|---------|
| Director | 2 | `SIGNER_DIRECTOR_SEED` | assigned by `npm run gov:live` |
| Treasurer | 2 | `SIGNER_TREASURER_SEED` | assigned by `npm run gov:live` |
| Atelier | 1 | `SIGNER_ATELIER_SEED` | assigned by `npm run gov:live` |
| Market | 1 | `SIGNER_MARKET_SEED` | assigned by `npm run gov:live` |

**SignerQuorum: 3.** The weights sum to 6. No single persona reaches 3. Atelier + Market = 2 and does not pass. Any other pair passes. Every trio passes.

Signer addresses are classic addresses of unfunded ed25519 key pairs. They must not be W0–W6. Public addresses land in `corp/wallets.md` and `machines/governance-board/activated.json` when the live set validates. Until that file exists, W0 still moves on its master key alone.

**Master key stays enabled.** This cut does not send `AccountSet` and does not set `asfDisableMaster` / `lsfDisableMaster`. Recovery while `W0_SEED` exists: the founder signs a replacement `SignerListSet`. Recovery if the master seed is lost and the signer seeds remain: a weight ≥ 3 coalition can sign, including a new `SignerListSet`. Recovery if both are lost: the account is stuck. That is why master stays on.

**Regular keys (W1–W6).** `SetRegularKey` writes `AccountRoot.RegularKey` (`AccountSet` does not carry that field) from `W1_REGULAR_SEED` … `W6_REGULAR_SEED`. Masters on W1–W6 stay enabled, so the founder can rotate a regular key with the master seed. Day-to-day scripts may load the regular seed and sign with `Account` still set to the W1–W6 address. Those regular-key addresses are unfunded and disjoint from the board signers and from W0–W6.

**Treasury motions.** An outgoing W0 payment ≥ 50 test XRP (50_000_000 drops), master-signed or multi-signed, still needs a file in `/lab/motions/` whose `destination` and `amount_drops` or `amount_xrp` match. See `lab/motions/README.md`.

**Quorum demo.** `npm run gov:multisign` sends 10_000 drops (0.01 XRP) from W0 to W6, signed by Director (2) + Market (1). Under the motion line. It does not touch the Unix-epoch BUYER escrow.

## Roles

See `org.md`. Adversary must sign off before any machine ships on-chain. Protocol vetoes unsupported primitives. Archivist vetoes unreproducible results.

## Identity

- DIDSet on W0 URI → raw GitHub charter (this file).
- NFT taxon `20260927` (Foundry Artifact collection).
- IOU code `AETH` issued from Treasury (on-ledger hex `4145544800000000000000000000000000000000` — 4-char nonstandard); DefaultRipple on unless an experiment documents otherwise.
- AMM AETH/XRP: `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w`.
