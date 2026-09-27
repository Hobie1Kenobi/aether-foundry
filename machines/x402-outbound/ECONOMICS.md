# ECONOMICS — x402 outbound

**Network:** XRPL Testnet simulation. Drops here are not mainnet XRP.

## Price

| Item | Drops | Note |
|------|-------|------|
| Foreign oracle ping | 5000 | SKU price. Account is faucet-funded, so this clears without creating the account. |
| Stated DIY cost | 0 | The same ledger read is a public RPC. |
| Operator ceiling in the one-click | 10000 | `--max-drops 10000`. Above the SKU, above DIY. |

W3 spends Testnet XRP. The counterparty is FOREIGN `r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ`. That balance is not Foundry revenue and is not an `x402_hits` desk sale.

`x402_outbound_hits` counts recorded outbound payments (unique tx hash). It stays 0 until a Foundry box runs `--record` after a real HTTP 200. Do not increment it by hand.

## Non-goals

- No spread, no grid, no claim that 5000 drops is profit.
- Desk SKUs (0.1 / 0.25 / 0.5 XRP to W3) are a different counter. Buying them with W3 does not count here.
