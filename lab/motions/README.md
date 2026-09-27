# Treasury motions

An outgoing payment from W0 TREASURY of **50 test XRP or more** (50_000_000 drops) needs a markdown file in this directory. `README.md` does not count.

Use one motion per payment. The governance signer reads these lines:

```text
destination: rYOURCLASSICADDRESS
amount_drops: 50000000
```

`amount_xrp: 50` is accepted instead of `amount_drops`. The destination and the amount must match the payment exactly. A smaller payment, including the 0.01 XRP quorum demo, does not need a file here.
