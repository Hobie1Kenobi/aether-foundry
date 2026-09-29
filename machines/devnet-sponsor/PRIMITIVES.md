# Primitives — Devnet Sponsor

| Item | Value |
|------|--------|
| Amendment | `Sponsor` |
| Network | XRPL Devnet id 2 |
| Create | `Payment`, `Flags` `tfSponsorCreatedAccount` (`0x00080000`), `Amount` `"1"` |
| Object | `DepositPreauth`, `SponsorFlags` `spfSponsorFee` \| `spfSponsorReserve` (`3`) |
| Co-sign | D2 signs, D0 `signAsSponsor` |
| Refused | network id other than 2, mainnet hosts, Testnet labeled wallets |
