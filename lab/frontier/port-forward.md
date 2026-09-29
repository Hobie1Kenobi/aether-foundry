# Port-forward — F8, F9, F10

Measured Chicago `2026-09-28T20:17` CDT. Testnet id **1** has these amendments disabled. Devnet id **2** has them enabled. Both servers reported rippled **3.4.1**. Sources: `lab/frontier/amendments.json`, `lab/frontier/amendments-devnet.json`.

No Devnet account is funded. `D0`–`D3` in `corp/wallets.md` are `_blank_`. This note is not a transaction. Nothing here was signed or submitted. There is no ledger hash for Sponsor, a vault, a loan, or a confidential transfer.

`XChainBridge` is enabled on that same Devnet map and disabled on Testnet. No lock and no claim.

## F8 — Sponsor

Amendment `Sponsor` (`BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC`), XLS-68. Testnet `enabled: false`. Devnet `enabled: true`.

Later, on the Foundry box, after a Devnet faucet returns an address for `D0` and a different address for `D2`:

1. `npm run frontier:probe-devnet` again. Stop unless `Sponsor` is still enabled and `network_id` is 2.
2. `D0` sponsors reserve for `D2`, a new account, so `D2` can hold a Walk-In-style object without already carrying the full reserve.
3. `D2` must not be a Testnet labeled wallet (`W0`–`W6`, BUYER, STRANGER, AMM, FOREIGN). Sponsoring a house account is the threat case in the limit-push list.
4. Archive the real engine result and hash with `"network": "XRPL Devnet"`.

Public note, not a step this session ran: the August 2026 XLS-68 disclosure says a sponsor must not unilaterally drop an object reserve the owner cannot cover. xrpld 3.4.0 carries that fix. Devnet's build string was `3.4.1`. That is not a reason to submit a Sponsor transaction tonight.

## F9 — Single-asset vault and a loan

Amendments, same hashes on both networks, enabled only on Devnet:

| Name | Hash |
|------|------|
| `SingleAssetVault` | `81BD2619B6B3C8625AC5D0BC01DE17F06C3F0AB95C7C87C93715B87A4FD240D8` |
| `LendingProtocol` | `565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509` |
| `LendingProtocolV1_1` | `A360E2BFD775A5B0DCE1C36C16DF31B72735A57584FD163655D2F9564F8E7AC8` |

XLS-65 is the vault. XLS-66 is the loan that sits on a vault. `LendingProtocolV1_1` is also on, so a later RESULTS line has to say whether the booked loan is cash-basis or accrual. Off-chain underwriting can live in RESULTS. The XRP still has to move.

Later sequence, still unsigned:

1. Re-probe Devnet. All three names `enabled: true`, id 2, or stop.
2. `D0` creates one single-asset vault (AETH or an MPT issued on Devnet, not the Testnet `AETH-LABOR` id).
3. `D1` deposits.
4. A loan broker on that vault. First-loss slice from a Devnet grants account, not from Testnet W6's balance.
5. One repayment, or one documented default. One originated loan is the success line.

Do not point this at Testnet while the Testnet rows are disabled. Do not invent a vault id.

## F10 — Confidential MPT

| Name | Hash | Devnet |
|------|------|--------|
| `DynamicMPT` | `58E92F338758479C06084E1B6BA366BAD8F75E5329A7F0EEAFFFDA51E5106B7F` | enabled |
| `ConfidentialTransfer` | `2110E4A19966E2EF517C0A8C56A5F35099D7665B0BB89D7B126B30D50B86AAD5` | enabled |

Both are disabled on Testnet. Later sequence: one confidential issuance from `D0`, one confidential payment to `D3`, one clawback. The RESULTS line for that session has to say what the public ledger does not show, and whether a grant can still be proved. A confidential self-deal is not an inbound counterparty.

No issuance id, no payment hash, no clawback hash.

## Pack

The Foundry-box commands are `npm run frontier:devnet-sponsor`, `npm run frontier:devnet-vault`, and `npm run frontier:devnet-confidential`. Dry-run is the default. `--live` takes one `--step` and is not for this agent. Operator note: [`DEVNET.md`](./DEVNET.md). Addresses stay `_blank_` in [`devnet-wallets.example.json`](./devnet-wallets.example.json). This section does not add a ledger hash.

## What stays on Testnet

`BatchV1_1`, `fixBatchV1_2`, and `PermissionDelegationV1_1` are enabled on this Devnet map and disabled on Testnet. `machines/batch-heartbeat/` stays spec-only. No delegate grant. Devnet having the flag is not a Testnet submit.
