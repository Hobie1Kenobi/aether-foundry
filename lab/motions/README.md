# Treasury motions

An outgoing payment from W0 TREASURY of **50 test XRP or more** (50_000_000 drops) needs a markdown file in this directory. `README.md` does not count.

Use one motion per payment. The governance signer reads these lines:

```text
destination: rYOURCLASSICADDRESS
amount_drops: 50000000
```

`amount_xrp: 50` is accepted instead of `amount_drops`. The destination and the amount must match the payment exactly. A smaller payment, including the 0.01 XRP quorum demo, does not need a file here.

W6 grants use this directory the same way. `npm run grants:pay -- --drops` at or above 50 XRP (50_000_000 drops) refuses unless a motion names that destination and that amount. The default 1 XRP grant does not need a file. W0 is not debited for the flywheel.
