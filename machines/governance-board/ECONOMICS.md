# ECONOMICS — governance board

**Network:** XRPL Testnet. Drops here are not mainnet XRP.

## Reserve

A SignerList created after MultiSignReserve counts as **one** owner object. Dry-run on ledger 21101142 read base reserve **1000000** drops and incremental reserve **200000** drops. W0 `OwnerCount` was 1 and no signer list was present, so the set adds one object. Projected reserve is `1000000 + 2 × 200000 = 1400000` drops. W0 balance at that read was 97999916 drops, above the line. Replacing an existing list does not add another object.

`SetRegularKey` does not add an owner object.

W0 must still cover the new reserve plus the fee. The live script refuses the SignerListSet when balance is not strictly above that reserve. It does not faucet and it does not pull float from another wallet to make the set fit.

## Fees

| Action | Fee rule |
|--------|----------|
| SignerListSet | single-sign base fee, paid by W0 |
| SetRegularKey × 6 | single-sign base fee each, paid by that W account. The first one on an account may be free; autofill pays the normal fee anyway |
| Quorum demo | multi-sign fee ≥ `(2 + 1) × base` = 3× base, paid by W0, plus **10000** drops delivered to W6 |

10000 drops stays inside the corporation (W0 → W6 GRANTS). It is not a burn and it is under the 50 XRP motion line (50_000_000 drops).

Running `npm run gov:multisign` again sends another 10000 drops. `npm run gov:live` does not send the payment.

## What this does not spend

- No signer account is funded, so the four board keys and six regular keys add no base reserve.
- No ≥ 50 XRP treasury payment is constructed by these scripts unless a motion file matches, and the built-in demo never asks for that amount.
