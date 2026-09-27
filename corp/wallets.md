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
| W7 | XAHAU | _pending_ | Xahau Testnet | no |
| W8 | EVM | _deferred_ | XRPL EVM Testnet | n/a |
| BUYER | work-ticket client (session-2) | rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth | XRPL Testnet | yes (faucet) |
| AMM | AETH/XRP pool | r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w | XRPL Testnet | seeded 2026-09-27 |

Seeds live in founder local `.env` only (`/workspace/aether-foundry-secrets/.env`, mode 600 — outside git tree).

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
