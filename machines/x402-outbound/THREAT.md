# THREAT — x402 outbound

## Circular self-pay

**Adversary claim:** W3 calls the desk, the desk's payTo is W3, and the books show a sale.

**Mitigation:** `src/x402-outbound-guard.js` parses `web/lib/xrpl-public.ts` `WALLETS` and refuses every address (W0–W6, AMM, BUYER, STRANGER), with W3 hard-stopped even if the parse misses it. The foreign shop refuses to boot if its payTo is in that set.

## Mainnet

The payer refuses `xrpl:0`, mainnet hostnames (`ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`), non-`rippletest.net` websockets, and `NetworkID` 0. The shop refuses a `network` query other than `xrpl:1` and a mainnet RPC URL.

## Seed exposure

`W3_SEED` and `FOREIGN_SEED` load from outside the repo. The payer does not print them. CI and `GITHUB_ACTIONS` cannot sign. `web/` still has no `Wallet.sign`.

## Overpay

A 402 can name any amount. The cheapness gate exits with `too expensive vs DIY` when the ask exceeds `--max-drops`, `MAX_DROPS`, or the challenge's stated `diyCostDrops`. The foreign shop states DIY `0`, so a bare run does not pay. Unknown shops that omit DIY and are called without a ceiling are paid as asked — set `--max-drops` first.

## Replay

The shop does not durably mark an invoice spent. The same validated Payment can unlock the JSON again. `--record` dedupes by tx hash. That is the same tradeoff as the desk verifier: Vercel and this process do not keep a spent-invoice database.

## Work-product honesty

The 200 body must include a `ledger_index` read from the public RPC. If that read fails after the Payment validated, the shop returns 502 `retry_same_proof` and the payer prints the hash and says not to pay again.
