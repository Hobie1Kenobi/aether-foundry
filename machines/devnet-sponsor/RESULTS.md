# RESULTS — Devnet Sponsor

**Status:** live on XRPL Devnet id 2 (object path).  
**Network:** XRPL Devnet, id 2.  
**Box merge:** `e0224883f0de4e7e82ba78986bca7ad7434ca853` (PR #31).  
**Session:** 2026-09-28 ~21:56–22:03 CDT. Signers: D0 + D2. Not Testnet W*.

## Quirk — D2 already funded

D2 `rpxsXpi7UwaPUp7opKkMGHJY6GR7MzsR1m` was faucet-funded (~200 XRP) before this drill, so the new-account `create` path could not succeed. Live `--step create` submitted `Payment` with `tfSponsorCreatedAccount` and returned **`tecNO_SPONSOR_PERMISSION`** (hash below; not archived — archive requires `tesSUCCESS`). Success line is the sponsored-object path: D2 `DepositPreauth` authorizing D0, with D0 `signAsSponsor` for fee + object reserve.

| Step | Result | Ledger | Hash |
|------|--------|--------|------|
| create (`Payment`, `tfSponsorCreatedAccount`) | `tecNO_SPONSOR_PERMISSION` (D2 already exists) | `5694557` | `25E8080E3BAB1E9F34D9226FDE58A023783DBD330B286A9E3C96F6CA3AB6F67E` |
| object (`DepositPreauth`, sponsored reserve) | `tesSUCCESS` | `5694560` | `5D533E560251B575007355766B5FB74BEA1C9985674FA682BC8EEDCDA779BF1F` |

Archive row (object only) in `lab/frontier/devnet-ledger.jsonl` tagged `"network": "XRPL Devnet"` and `"network_id": 2`. Do not copy into Testnet NAV.
