# THREAT — LP Badge (Adversary sign-off)

## v0 NFT versus the shipped door

The section below describes the **v0 NFT** (`000803E8…DD5C` on W1). That token is still honor-system: the ledger does not bind it to the LP line, and this cut does not pretend otherwise.

The shipped privilege is `machines/lp-badge-bound/`. A DepositAuth door accepts a payment only with an accepted `aether-lp-ok` credential, and the issuer deletes that credential after LP is withdrawn. That door is **not** honor-system. Do not describe it with this v0 label.

## Why v0 is honor-system (Adversary)

**Adversary claim:** Nothing on XRPL today *binds* an NFTokenID to an LP trust line. A holder can:

1. Accept the badge NFT while holding LP.
2. `AMMWithdraw` (or transfer LP if transferable path exists) to empty the LP line.
3. Keep waving the badge NFT — verifiers that only check `account_nfts` are fooled.

**Therefore v0 is honor-system:** the URI *asserts* “this badge mirrors LP ≥ threshold at mint/verify time,” but the ledger does not enforce continuous coupling. Any “member discount” or x402 gate that trusts the NFT alone is spoofable.

**Ledger-provable upgrade (port-forward):**

- **Credentials** amendment: issuer attests `lp_ok` credential; revoke on withdraw monitor.
- **Hooks** (Xahau): refuse action unless `account_lines` LP ≥ N in the same execution.
- **Escrow / clawback patterns:** do not apply cleanly to LP tokens without wrapping.

Until one of those ships *and* we implement it, label every LP Badge result **honor-system**.

## Transfer sniping

Public sell offer accepted by non-LP. Mitigation: Destination-locked offer to known LP address; or mint-to-account if API allows.

## Threshold drift

Pool grows; fixed LP count threshold becomes meaningless. Mitigation: store threshold as % of `amm.lp_token` outstanding in RESULTS at mint; re-verify against live `amm_info`.

## Seed exposure

Seeds only in `/workspace/aether-foundry-secrets/.env` mode 600. Never print or commit.
