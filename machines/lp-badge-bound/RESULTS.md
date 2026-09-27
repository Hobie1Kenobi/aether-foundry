# RESULTS — LP Badge Bound

**Network:** XRPL Testnet  
**Enforcement:** Credentials + DepositPreauth  
**Honor-system:** **no** for the door. The v0 NFT remains honor-system and was not modified.

## Amendment probe

Live `feature` + `server_info` on `https://s.altnet.rippletest.net:51234` before the trial.

| Check | Result |
|-------|--------|
| rippled | 3.4.1 |
| network id | 1 |
| `Credentials` `1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF` | **enabled** |
| `DepositPreauth` / `DepositAuth` | **enabled** |
| Enabled amendment whose name contains `Hook` | **none** (107 amendments scanned) |
| Chosen primitive | **Credentials**. Hooks were not faked. AMM stayed on this testnet. |

TokenEscrow is also enabled. An escrow condition is a crypto-condition, not an LP predicate, so it does not bind the trust line. It was not used as the gate.

## On-chain trial

Filled from `machines/lp-badge-bound/trial.json` after `npm run lp-badge:bound -- --record`. Hashes below are the validated trial.

| Step | Result | Hash |
|------|--------|------|
| Stranger payment, no credential | `tecNO_PERMISSION` | see trial.json |
| Holder payment, credential exists, id omitted | `tecNO_PERMISSION` | see trial.json |
| Holder payment, `CredentialIDs` presented, LP ≥ 1000 | `tesSUCCESS` | see trial.json |
| Holder payment, same id after withdraw + `CredentialDelete` | `tecNO_PERMISSION` | see trial.json |

`npm run lp-badge:bound -- --record` writes `trial.json`. This RESULTS table is copied from that file. Hashes that still say `see trial.json` mean the live trial is not archived yet.

## Follow-ups (not this cut)

| Machine | Why it is still open |
|---------|----------------------|
| `lp-badge` v0 NFT on W1 | Still unbound. Binding that token would not make `DepositPreauth` consult it. W1's 500000 LP was left in place. |
| `oracle-mid-ticket` | Quote in the URI is still operator-attested. A credential or hook on quote expiry is a different predicate and was not folded in. |
| Xahau hook that reads LP in the same execution | Stronger atomicity, but only on a ledger that holds the LP. This testnet has no Hooks amendment. Not started. |
