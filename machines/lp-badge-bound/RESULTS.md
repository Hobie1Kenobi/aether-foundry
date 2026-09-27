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

Validated on XRPL Testnet, rippled 3.4.1, 2026-09-27. Raw rows: `trial.json` and `lab/ledger-log.jsonl`.

| Account | Address | Not this anchor |
|---------|---------|-----------------|
| Issuer | `rPXJrQEJN2K9grJJBqQHQ2V5nazcZQo5Cn` | not W2 |
| Holder | `rLDbAi71mciJwCDKyTn6dohD3ypDsMLRwm` | not W1 |
| Door | `r3UBPs7Lakfic2Mjq2QcgSqwfn6iYVGtFQ` | new |
| Stranger | `rUpVvDQWBQVvrdazFZfb6E7DPmoafN2jNj` | new |

LP after `AMMDeposit`: **4062.1154719097** (≥ 1000). LP after `AMMWithdraw`: **0**. Credential id `CF1E832E647C8B753B29D848651494AC64D6E5B7E3D3820F65EE7EFCCC2FB935` matched the keylet computed in `src/lp-badge-bound-guard.js` and is no longer on the ledger.

| Step | Engine | Ledger | Hash |
|------|--------|--------|------|
| AETH TrustSet | tesSUCCESS | 21100645 | `4B1A69114B1D21E2B9B4146CC19C2F376CEA5488487135CE42F8D73235FFA367` |
| Buy 50 AETH | tesSUCCESS | 21100647 | `C09E87E00DCF3CAA594E3FF7D947891AC7D61501C0D85AE6884C1FCDE2CA8249` |
| AMMDeposit | tesSUCCESS | 21100648 | `1FDDE1A94C759554DE3F1B8D457F7D6E0338F9AEF01E177B5671345803605AF0` |
| DepositAuth | tesSUCCESS | 21100650 | `DB7761E2E2B1D945E317CEDB1552EF54BA7FDF5C10ECB20717ECCD6B4020146C` |
| DepositPreauth | tesSUCCESS | 21100652 | `EB4387CB79C01E17C16AD66C4287E3DC208EBFAFDF066F2429D58906EEE2103B` |
| Stranger payment, no credential | **tecNO_PERMISSION** | 21100654 | `27AE8639E52729C1085D9D36C8E36145450502F580E4D0894804DCC01B1C6C92` |
| CredentialCreate (LP 4062.12) | tesSUCCESS | 21100655 | `12529E5C6324D9316F6D61F29BDE878F47AC8EB33108B7FAF2E57DDA5845EAA1` |
| CredentialAccept | tesSUCCESS | 21100657 | `831D1F016204F59C0B005B22CD734319D0DCFBF3CB1A414B2097736716ADBCA5` |
| Holder payment, credential exists, id omitted | **tecNO_PERMISSION** | 21100659 | `311CBEA7D2008ADE45093067A4536CE771DCD55439D930BD128F953C684DE944` |
| Holder payment, `CredentialIDs` presented | **tesSUCCESS** | 21100661 | `D21E08CC086310E2FA15B1F0E717FEF406F8BD3EF29ED5137AE9ACC64875FED2` |
| AMMWithdraw all trial LP | tesSUCCESS | 21100663 | `943FD9A5DAB346623F3C6E18FD159950F91EBC68DA9092E1CBDA3DD986CD1F60` |
| CredentialDelete (LP 0) | tesSUCCESS | 21100664 | `F02F11856EAA7BB22E66017AFAD985838C7FC27CAEF64B0F5F425028F99187AB` |
| Holder payment, stale credential id | **tecBAD_CREDENTIALS** | 21100666 | `919C1C7721EB178EBD4BC95DE35817D0F5410E3F5EA7FB6C08EE4CCA4437EE48` |

`deposit_authorized` with the id before the delete was true, and without an id was false. After the delete the same id returns `badCredentials`.

W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` was not a signer. Its 500000 LP and the v0 NFT were not moved.

## Follow-ups (not this cut)

| Machine | Why it is still open |
|---------|----------------------|
| `lp-badge` v0 NFT on W1 | Still unbound. Binding that token would not make `DepositPreauth` consult it. W1's 500000 LP was left in place. |
| `oracle-mid-ticket` | Quote in the URI is still operator-attested. A credential or hook on quote expiry is a different predicate and was not folded in. |
| Xahau hook that reads LP in the same execution | Stronger atomicity, but only on a ledger that holds the LP. This testnet has no Hooks amendment. Not started. |
