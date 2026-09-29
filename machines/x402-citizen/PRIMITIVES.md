# PRIMITIVES — x402 citizen

Network: XRPL Testnet, network id 1. Three objects the desk and the box actually touch.

1. **Payment to W3** — exact XRP, SKU `SourceTag`, invoice memo or `InvoiceID`. Self-verify reads this from the public Testnet RPC. `NetworkID` must be 1 when the field is present.
2. **Facilitator receipt** — `payload.facilitatorReceipt` with `transaction`, `network: xrpl:1`, and facilitator `https://xrpl-facilitator-testnet.t54.ai`. The desk checks the host, then reads the same Payment. `POST /verify` is the only facilitator call, and only while the blob is not yet validated.
3. **Outbound Payment from W3** — Destination is a foreign payTo, not an address in `WALLETS`. Amount is at most 500000 drops. Memo data `aether-foundry:f11` is the fingerprint. SourceTag is the shop's tag or `202609296`.

The T54 testnet facilitator `GET /supported` answer used while writing this pack advertised `xrpl:1` only (`exact` and `upto`). The mainnet host advertised `xrpl:0`. That is why the env gate is an exact origin match, not a suffix match.
