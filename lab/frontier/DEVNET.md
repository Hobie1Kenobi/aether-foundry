# Devnet packs — F8, F9, F10

XRPL Devnet only. Network id **2**. Default RPC `https://s.devnet.rippletest.net:51234`. These commands refuse mainnet hosts and any other network id before a submit. They do not write Testnet `lab/ledger-log.jsonl`, desk `WALLETS`, director NAV, or Walk-In.

Nothing in this file was signed. `D0`–`D3` in `corp/wallets.md` stay `_blank_` until the Foundry box pastes a faucet address. Placeholder shape, no secrets: [`devnet-wallets.example.json`](./devnet-wallets.example.json).

Re-probe first. `npm run frontier:probe-devnet` rewrites `amendments-devnet.json`. The three CLIs also call `server_info` and `feature` and abort unless the amendments for that pack are still enabled on id 2. A dry-run does not rewrite the map file.

```bash
npm run frontier:probe-devnet
npm run frontier:devnet-sponsor
npm run frontier:devnet-vault
npm run frontier:devnet-confidential
```

Dry-run is the default. It prints unsigned JSON and does not read seeds. `--live` needs `FOUNDRY_DAEMON_LIVE=yes`, refuses `CI` / `GITHUB_ACTIONS`, and takes one `--step`. It signs with `D0_SEED`…`D3_SEED` (and the confidential sender / ElGamal seeds below). It does not use the Testnet agent allowlist. A hash is archived only after `tesSUCCESS`, into `lab/frontier/devnet-ledger.jsonl`, tagged `"network": "XRPL Devnet"` and `"network_id": 2`.

## Env

Names only. Values stay in the secrets file, mode 600, outside git. See `.env.example`.

| Name | Use |
|------|-----|
| `D0_ADDRESS` / `D0_SEED` | Sponsor, vault owner, confidential issuer |
| `D1_ADDRESS` / `D1_SEED` | Vault depositor and loan borrower |
| `D2_ADDRESS` / `D2_SEED` | New sponsoree. Do not faucet-fund D2 first |
| `D3_ADDRESS` / `D3_SEED` | Confidential counterparty |
| `D_CONF_SENDER_ADDRESS` / `D_CONF_SENDER_SEED` | Holder who sends the confidential payment. Not D0, not D3, not a Testnet label |
| `D0_ELGAMAL_SEED` | Issuer encryption key. Not `D0_SEED` |
| `D3_ELGAMAL_SEED` | D3 holder key. Not `D3_SEED` |
| `D_CONF_SENDER_ELGAMAL_SEED` | Sender holder key. Not the sender signing seed |

`FOUNDRY_XRPL_HTTP` is Testnet. These CLIs do not read it. Optional Devnet overrides: `FOUNDRY_XRPL_DEVNET_HTTP`, `XRPL_DEVNET_HTTP`, `FOUNDRY_XRPL_DEVNET_WS`, `XRPL_DEVNET_WS`.

Refused as D0–D3 or the confidential sender: W0–W6, BUYER, STRANGER, AMM, FOREIGN. The Testnet `AETH-LABOR` issuance `0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED` is refused.

## F8 — Sponsor

`npm run frontier:devnet-sponsor`

1. `--step create` — D0 `Payment` of 1 drop, `tfSponsorCreatedAccount`, destination D2. D2 must not already exist.
2. `--step object` — D2 `DepositPreauth` authorizing D0. `Sponsor` is D0. `SponsorFlags` is fee plus object reserve. D2 signs, then D0 `signAsSponsor`.

```bash
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step create
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step object
```

## F9 — Vault and loan

`npm run frontier:devnet-vault`

Asset is XRP. `LendingProtocolV1_1` is required, so the vault is closed-ended and the accounting line is cash-basis (`LEVersion` 1). This pack does not book accrual. Interest is recognized when a payment delivers it.

Steps, in order: `create`, `deposit`, `broker`, `cover`, `loan`, then either `repay` or `default`.

- `create` — D0 `VaultCreate`. `SubscriptionDate` is 180 seconds ahead. `RedemptionDate` is 3600 seconds after that. Wait until the subscription time before `loan`.
- `deposit` — D1 deposits 5 XRP. Pass `--vault-id` from the create result. The id is not invented.
- `broker` — D0 `LoanBrokerSet` on that vault.
- `cover` — D0 `LoanBrokerCoverDeposit` of 0.2 XRP. That is the Devnet first-loss slice. It is not Testnet W6.
- `loan` — D0 signs `LoanSet`, D1 counter-signs. Principal 1 XRP. One payment, 600 second interval, 60 second grace. Interest 1000 tenth-basis-points (1% annualized).
- `repay` — D1 `LoanPay`. Amount is `Loan.PeriodicPayment` rounded up, unless `--amount` is set.
- `default` — D0 `LoanManage` with `tfLoanDefault`. The ledger returns `tecTOO_SOON` until the due date plus grace. One of repay or default is the success line, not both.

Pass `--vault-id`, `--broker-id`, or `--loan-id` from the previous `tesSUCCESS`. A missing id keeps that step `ready: false`.

## F10 — Confidential MPT

`npm run frontier:devnet-confidential`

Amendments `DynamicMPT`, `ConfidentialTransfer`, and `MPTokensV1`. Issuance flags include CanHoldConfidentialBalance, and `ImmutableFlags` locks that capability. `TransferFee` is 0. Ticker `DCONF`. Not AETH-LABOR.

The issuer cannot hold a confidential balance of its own token. The sender is a separate Devnet account.

| Step | What submits | Public? |
|------|----------------|---------|
| `issue` | D0 `MPTokenIssuanceCreate` | yes |
| `keys` | D0 `MPTokenIssuanceSet` `IssuerEncryptionKey` | the public key, yes. No auditor key |
| `authorize-sender` / `authorize-d3` | `MPTokenAuthorize` | yes |
| `public-sender` / `public-d3` | D0 `Payment` of 100 and 1 units | amounts are public |
| `convert-d3` | D3 converts 1 unit to register a holder key | `MPTAmount` is plaintext |
| `convert-sender` | sender converts 10 | plaintext |
| `merge-sender` | `ConfidentialMPTMergeInbox` | no amount |
| `pay` | `ConfidentialMPTSend` of 10 to D3 | amount is not a plaintext field |
| `lock` | `tfMPTLock` on D3 | yes |
| `clawback` | `ConfidentialMPTClawback` of D3's entire confidential balance | `MPTAmount` is the plaintext total burned |

Proof steps call `xrpl.prepareConfidential*`. If that helper does not return a `ZKProof`, the process stops and does not invent one. `--issuer-encryption-key` may be passed on a dry-run of `keys`; it is a 33-byte public key, not a seed.

What a public ledger reader sees, and does not see, is the `public_ledger` object in the dry-run JSON. A grant of confidential units can still be proved by the issuer mirror key or by D3's holder key. There is no auditor ciphertext. A payment from an account to itself is refused.

## Foundry box

Fund D0, D1, D3, and the confidential sender from the Devnet faucet on the box. Leave D2 unfunded so `create` can sponsor it. Then probe, dry-run, and `--live --step` in the order above. Copy real hashes into the pack `RESULTS.md`. Do not paste seeds into git, the PR, or chat.
