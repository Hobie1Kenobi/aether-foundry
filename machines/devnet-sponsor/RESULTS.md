# RESULTS — Devnet Sponsor

**Status:** live on XRPL Devnet id 2 (create-account + object path).  
**Network:** XRPL Devnet, id 2.  
**Box merge:** prior packs through `dcaff13`; this session archives create on a fresh D2.  
**Session:** 2026-09-28 ~22:06–22:10 CDT. Signers: D0 (+ D2 for object). Not Testnet W*.

## Quirk — first D2 was faucet-funded

Prior D2 `rpxsXpi7UwaPUp7opKkMGHJY6GR7MzsR1m` was faucet-funded (~200 XRP) before the first drill, so create returned **`tecNO_SPONSOR_PERMISSION`**. Sponsored-object `DepositPreauth` still succeeded on that address. Seeds for that wallet are retained off-git as `D2_FUNDED_*`.

## Fresh unfunded D2' (active)

Generated a new classic address, **not** faucet-funded. Confirmed `account_info` → `actNotFound` on `https://s.devnet.rippletest.net:51234` before create. Active `D2_ADDRESS` / `D2_SEED` in box secrets point here.

| Field | Value |
|-------|-------|
| Active D2 | `rGK3QfP57LzBzS8KcYHmpBa8NvUHxoxAgV` |
| Prior funded D2 | `rpxsXpi7UwaPUp7opKkMGHJY6GR7MzsR1m` (historical) |

| Step | Result | Ledger | Hash |
|------|--------|--------|------|
| create (`Payment`, `tfSponsorCreatedAccount` / Flags `524288`) | `tesSUCCESS` | `5694766` | `002F5E3D285FADCEED03D8CFA602C73363539BFCB1190D30E56BA4F4E3BB8BE4` |
| object (`DepositPreauth`, sponsored reserve) on prior D2 | `tesSUCCESS` | `5694560` | `5D533E560251B575007355766B5FB74BEA1C9985674FA682BC8EEDCDA779BF1F` |
| create on prior funded D2 | `tecNO_SPONSOR_PERMISSION` | `5694557` | `25E8080E3BAB1E9F34D9226FDE58A023783DBD330B286A9E3C96F6CA3AB6F67E` (not archived) |

Archive rows in `lab/frontier/devnet-ledger.jsonl` tagged `"network": "XRPL Devnet"` and `"network_id": 2`. Do not copy into Testnet NAV.
