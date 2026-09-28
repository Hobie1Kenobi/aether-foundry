# Wallet address book (public addresses only — no seeds)

| ID | Role | Address | Network | Funded |
|----|------|---------|---------|--------|
| W0 | TREASURY | rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs | XRPL Testnet | yes |
| W1 | MARKET | rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS | XRPL Testnet | yes |
| W2 | ATELIER | rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw | XRPL Testnet | yes |
| W3 | CHANNELS | rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw | XRPL Testnet | yes |
| W4 | ESCROW | ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN | XRPL Testnet | yes |
| W5 | R&D | rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ | XRPL Testnet | yes |
| W6 | GRANTS | rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf | XRPL Testnet | yes |
| W7 | XAHAU treasury (hook account) | r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h | Xahau Testnet | yes (faucet, 1000 XAH) |
| W8 | EVM | _deferred_ | XRPL EVM Testnet | n/a |
| BUYER | work-ticket client (session-2) | rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth | XRPL Testnet | yes (faucet) |
| STRANGER | walk-in purchaser (session-4) | rh4c6qMMyafccZrPFCPCN742BNMXfjKYss | XRPL Testnet | yes (faucet) |
| AMM | AETH/XRP pool | r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w | XRPL Testnet | seeded 2026-09-27 |
| FOREIGN | x402 outbound counterparty (not a Foundry anchor; do not add to desk `WALLETS`) | r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ | XRPL Testnet | yes (faucet) |

Seeds live in founder local `.env` only (`/workspace/aether-foundry-secrets/.env`, mode 600 — outside git tree).

## Week-2 board (XRPL Testnet, public addresses only)

Hunch H1. SignerQuorum **3**. Weights: Director 2, Treasurer 2, Atelier 1, Market 1. Master keys stay enabled. No Xahau twin.

Activated 2026-09-27 on the Foundry box (`SignerListSet` `EDD27C458D314602E6059D8351D2DDA322A5E4BD1FD55602B3D2E667EA970299`). Public addresses also in `machines/governance-board/activated.json`. Seeds stay outside git.

| Persona / key | Weight | Address | Seed env |
|---------------|-------:|---------|----------|
| Director signer | 2 | `rpEpjesFRPcpWWVKoheDT59YKtoA6Xureg` | `SIGNER_DIRECTOR_SEED` |
| Treasurer signer | 2 | `rHG25YbFNqFL9HzVqa9JQhXFY9Zignxznh` | `SIGNER_TREASURER_SEED` |
| Atelier signer | 1 | `rGfkxsMvv833ioy2QjmTXhYF49J94N9WRu` | `SIGNER_ATELIER_SEED` |
| Market signer | 1 | `r4Qc6iUKrLZQwM9sPdPWCCHAK2bcMsrxVr` | `SIGNER_MARKET_SEED` |
| W1 regular key | — | `rDyiGKuMgL2F8S7TjB6m6Wg1pLg5KDPJYY` | `W1_REGULAR_SEED` |
| W2 regular key | — | `rNNzhkcScozB7Nzv3cWCZAEnu6MMC64rmy` | `W2_REGULAR_SEED` |
| W3 regular key | — | `rJRxr1E1Dzz5TXJsCHhwQAm4qS68Y73dQj` | `W3_REGULAR_SEED` |
| W4 regular key | — | `rfXBxqPjprj1J5Ekq5v82D3BDqRm7ms7p2` | `W4_REGULAR_SEED` |
| W5 regular key | — | `rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q` | `W5_REGULAR_SEED` |
| W6 regular key | — | `rGjdFjMz577GF4uvb4N9ayCqP5Q74kwVq5` | `W6_REGULAR_SEED` |

## Xahau Testnet split destinations (W7 hook)

These are Xahau accounts. They are not the XRPL Testnet twins and they are not in the desk `WALLETS` map. Public addresses only. Seed env names are placeholders in `.env.example`.

| Role | Share | Address | Seed env | XRPL Testnet twin |
|------|------:|---------|----------|-------------------|
| W7 treasury | hook account | `r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h` | `W7_SEED` | none |
| MARKET | 40% | `rUV6zDW72xLRWtECfAivjfQ67EXUE5cq38` | `W7_MARKET_SEED` | W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` |
| ATELIER | 25% | `rU98zDxthCRjoQLURzhrPJoo2t851gvExk` | `W7_ATELIER_SEED` | W2 `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` |
| R&D | 20% | `rB5jFnmc7BdBAJdquSMwhkTKjJaJGfnB8m` | `W7_RD_SEED` | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| GRANTS | 10% | `rHjzEwwBAB7BRwfjFMVGsmGduEahSCPkBh` | `W7_GRANTS_SEED` | W6 `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf` |
| SINK | remainder | `rLwvjUEuSBe8PByEnpwWxUryG4KRCXqt6K` | `W7_SINK_SEED` | none |
| Trial payer | n/a | `rKteu2WyN5nm7i8txzw1VCgN14DDGxztC9` | `W7_PAYER_SEED` | none |

HookHash `B9B6A6D5DDCF4212CC046217500AB3D90D54C7E63684F98E7991F4EBA9BC6C09`. SetHook `7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447`. Details: `machines/xahau-split-treasury/RESULTS.md`.

## On-chain identity / issuance (2026-09-27 boot-onchain)

| Item | Value |
|------|-------|
| DID URI (W0) | https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/corp/charter.md |
| DefaultRipple (W0) | enabled (`Flags` includes `lsfDefaultRipple`) |
| AETH issuer | W0 `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` |
| AETH currency hex | `4145544800000000000000000000000000000000` (ASCII `AETH`, 4-char nonstandard) |
| AMM account | `r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w` |
| LP token currency | `0330E60FAE706EAD2C7D511D790B07A6F3B89931` (issuer = AMM) |
| Artifact #0 NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF129D634CE0141DD56` |
| NFT taxon | `20260927` |
| NFT issuer / minter | W2 ATELIER |
| Artifact #1 NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF13EFDC5CD0141DD57` |
| Artifact #1 holder | BUYER `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` |

Booted 2026-09-27 via faucet + on-chain boot. Explorer: https://testnet.xrpl.org

| Drip Pass NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1579B96CC0141DD58` |
| Drip Pass holder | BUYER `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` |
| Epoch Scar NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF16CA1A7CB0141DD59` |
| Epoch Scar holder | W5 `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` |
| PayChannel (session-3, settled) | `DCE8401B0DFFE4031FBB15935D0EC33F72B010C8B89E2F60E6E6AC8B0572E9F5` |

| Walk-In NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1854F48CA0141DD5A` |
| Walk-In holder | STRANGER `rh4c6qMMyafccZrPFCPCN742BNMXfjKYss` |
| Path-pay (STRANGER) | 50 AETH via AMM; hash `BAF7B71ADCC203985D5686B201CE2E1FA94677D73A59428C02C902747E8C1158` |

| Domain (W0) | `aether-foundry-desk.vercel.app` (AccountSet hash `15D20D72A5BECEE3A84998503F8D357B68D321563959497D2FF629A6D0685F76`, ledger 21096168) |
| Oracle Mid-Ticket NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF19A5519C90141DD5B` |
| Oracle Mid-Ticket holder | BUYER `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` |
| Oracle quote file | `lab/oracle/2026-09-27-1144.json` |
| F1 OracleSet | W5 document `1`, pair AETH/XRP, scale 8. No `oracle_id` until the box submits. Pack `machines/native-price-oracle/`. |

| LP Badge v0 NFTokenID | `000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C` |
| LP Badge bound issuer | `rPXJrQEJN2K9grJJBqQHQ2V5nazcZQo5Cn` (XRPL Testnet, not W2) |
| LP Badge bound holder | `rLDbAi71mciJwCDKyTn6dohD3ypDsMLRwm` (XRPL Testnet, not W1) |
| LP Badge bound door | `r3UBPs7Lakfic2Mjq2QcgSqwfn6iYVGtFQ` |
| LP Badge bound stranger | `rUpVvDQWBQVvrdazFZfb6E7DPmoafN2jNj` |
| LP Badge bound credential | `CF1E832E647C8B753B29D848651494AC64D6E5B7E3D3820F65EE7EFCCC2FB935` |
| LP Badge holder | W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` |
| LP Badge mint | `A8185AFA42F082A85792D3AF534A852B7060726D44A29420C14DD4A673E36E5C` |
