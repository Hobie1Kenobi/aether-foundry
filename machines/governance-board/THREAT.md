# THREAT — governance board

Adversary sign-off for the week-2 cut. The board is a drill: one founder holds every seed.

## One leaked signer

**Claim:** a copied `SIGNER_DIRECTOR_SEED` drains W0.

**Mitigation:** Director weight is 2 and quorum is 3. Unit tests lock the five losing coalitions (each singleton, and Atelier+Market). The live payment path uses `autofill(tx, signerCount)` and `xrpl.multisign`. A single signature is not a valid multi-sign for this list.

## Founder holds every seed

**Claim:** weights are theater because the same person can produce any coalition.

**Mitigation:** acknowledged. H1 does not create independent custody. It forces scripts to collect two keys and it keeps a stolen single signer file from passing quorum. Real split custody would mean the founder does not hold all four seeds. That is out of scope for this lab week.

## Disable master, then lose the board

**Claim:** `asfDisableMaster` plus a lost quorum bricks W0.

**Mitigation:** this pack never sends `AccountSet`. `assertNoDisableMaster` rejects `AccountSet` and `SetFlag` 4. `lsfDisableMaster` already set on W0–W6 aborts the run. Recovery while the master seed exists: W0 master signs a new `SignerListSet`. Recovery if only the master seed is lost: any passing coalition can still sign. Both lost: the account is stuck, which is why master stays on.

## Replace a live list by accident

**Claim:** a second run points W0 at a new board and strands the previous signers.

**Mitigation:** if the on-ledger list or regular key differs, the script exits before any submit unless `--replace` is present. Matching configuration prints `already matches; no new tx` and does not invent a hash.

## Secret in git or CI

**Claim:** the generator writes a seed into the repo, or GitHub Actions signs.

**Mitigation:** new seeds append only to `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`. That path is gitignored (`**/*secret*`). The writer refuses a repo-relative path that `git check-ignore` does not ignore. Values are not printed and are not returned from `upsertSecrets`. `assertNotCi` runs before the secrets file is read. `gov:dry` does not call `fromSeed`.

## Mainnet or Xahau

**Claim:** the same script sets a signer list on mainnet or on the W7 Xahau hook account.

**Mitigation:** URLs must be `*.rippletest.net`. Hosts containing `xahau` are refused. `network_id` must be 1 when the server reports it. NetworkID 0 is refused. W7 is not in the account table.

## Quorum demo as a treasury drain

**Claim:** the demo flag accepts an amount ≥ 50 XRP, or a destination outside the corp.

**Mitigation:** the demo amount and destination are constants (10000 drops, W6). `buildDemoPayment` throws at ≥ 50 XRP unless a motion file matches `destination` and `amount_drops` or `amount_xrp`. There is no amount flag. The Unix-epoch BUYER escrow is not referenced and there is no escrow transaction in the signer.

## Multi-sign malleability

**Claim:** an extra valid signature changes the hash after signers agreed.

**Mitigation:** the demo submits exactly two signatures, the minimum winning coalition, and archives the validated hash from `submitAndWait`. It does not archive the per-signer hash.

## Desk signing

**Claim:** the Next desk grows a `Wallet.sign` path for the board.

**Mitigation:** `web/` is unchanged. No governance import. The desk stays read-only.
