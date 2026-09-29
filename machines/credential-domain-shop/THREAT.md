# THREAT — Credential domain shop

Adversary stamps these before `--live`.

## Amendment gate

`CredentialCreate`, `CredentialAccept`, `PermissionedDomainSet`, and a domain `OfferCreate` are legal only when `feature` reports `Credentials`, `PermissionedDomains`, and `PermissionedDEX` `enabled: true` on this connection, each under its Testnet amendment hash. A missing name is not treated as disabled and is still a refuse. `lab/frontier/amendments.json` does not override the live `feature` call.

If any of the three is off, the process prints `steps: null` and does not build a Payment, a Walk-In mint, a Batch, a Sponsor, or a Vault in their place.

## Wrong network

Network id `0`, Xahau mainnet `21337`, and any other id are a hard refuse before `feature`. Hosts `ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, and `xahau.network` are refused before a fetch. If `server_info` omits `network_id`, stop.

## Uncredentialed path (documented for live verification)

The refusal is an `OfferCreate` whose `Account` has not accepted `aether-agent`, whose `DomainID` is this domain, and whose flags do not include `tfHybrid`. The expected engine result is `tecNO_PERMISSION`.

This pack does not contain that hash. A dry-run prints the unsigned transaction and `"live_verified": false`, `"hash": null`. Writing a hash into RESULTS before the ledger returns one is an invented result. `/api/status` `domain_id` stays null until `PermissionedDomainSet` metadata matches the keylet.

The domain owner can place an offer without the credential. That exception is why the uncredentialed account is a faucet stranger, not W5.

## LP credential reused without an LP read

`aether-lp-ok` means LP ≥ 1000 on the LP door. This shop does not read `account_lines`. Issuing that type here would claim a bond the domain does not check. The domain accepts `aether-agent` only.

## Hybrid offer

`tfHybrid` (`0x00100000`) would let the open DEX cross the offer later. The builder refuses the flag. The public book is not the accredited counter.

## Open Walk-In

W2's NFT sell offer has no `DomainID` and no credential check. This script does not submit `NFTokenMint` or `NFTokenCreateOffer`. Gating Walk-In would change the public shop. That is out of scope.

## Signer

W5 transactions use `W5_REGULAR_SEED`. Faucet accounts use `CDS_AGENT_SEED`, `CDS_STRANGER_SEED`, and `CDS_MINT_SEED`. `W0_SEED` and `TREASURY_SEED` are refused. Account is never W0. These transaction types are not added to the daemon allowlist. The desk and GitHub Actions do not hold the seeds.

## Disabled work this pack must not pretend

| Amendment | What we do |
|-----------|------------|
| `BatchV1_1` / `fixBatchV1_2` | No Batch. |
| `Sponsor` | No Sponsor. |
| `SingleAssetVault` / lending | No Vault. |
| T54 facilitator | Not this pack. |
