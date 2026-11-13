# W1 Testnet offer adapter

The adapter is installed and dormant. It does not read a key, open a socket, or submit while `FOUNDRY_W1_DEX_LIVE` is unset. Turning it on is a local operator action. This document is not evidence that a live transaction succeeded.

## Public boundary

- Signer account: W1 `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS`
- Asset issuer: W0 `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs` issues AETH. W0 is not a signer.
- Network: `xrpl:1` only. The socket must answer `server_info` with `network_id` 1 before any signature.
- Socket allowlist: `wss://testnet.xrpl-labs.com` with no credentials and no port.
- Book offers only. The passive flag is required. A caller cannot choose the account, destination, fee, sequence, or reserve.

## Limits and reserve

- DEX and LP share one 100000000-drop bankroll. It is not 100 XRP for each agent and it does not refill each Chicago day. A restart reads the same ledger.
- W1, W3, and W4 share one RLUSD team cap on that same mission ledger. The shipped default is 3500000 drops (3.5 XRP). `FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS` may set a lower cap and is rejected above 3500000. W1 still stops at 2000000 drops of its own RLUSD exposure. W3 stops at 500000. W4 stops at 1000000. Each mission id is counted once. An uncertain in-flight hold on any role blocks the others. See `docs/dex-roles.md`.
- Proved XRP at risk is the LP share of pool XRP, open-offer locks, the account base reserve, `OwnerCount * reserve_inc`, in-flight holds, and realized losses. AETH counts only when an outside bid pays XRP for that AETH, and only for the amount the bid takes. The pool's own price is not a value. Uncovered or frozen AETH closes new risk and does not release XRP already in the pool. Minted AETH is not booked as a fresh XRP spend.
- Payment missions stay at 1000000 drops each and 5000000 drops per Chicago day, including the 1747-drop legacy hold. New DEX rows do not write `budget.reserved`.
- The open-ledger fee must be from 1 to 10000 drops. The caller does not set it.
- Autonomous AMM deposit is unsupported. The director does not call it. `rebalance: "exit-sole-lp"` is one saved withdraw, keyed once, not once per ledger. It is not an automatic liquidation. Recovered XRP is the proved amount only, and a later smaller pool share must cover that amount. A cheap or house bid does not open headroom. A drop in pool XRP does not either: the high-water mark stays until proved XRP comes back.
- Creating an offer increases the owner count by one. That reserve stays locked until a validated cancel or a consuming trade deletes the offer. The network fee is spent. Neither number is an APR. The AMM trading fee is not a yield.

## What one activation does

`src/business/dex/supervisor.js` is the durable entry. It stays off unless `FOUNDRY_W1_DEX_SUPERVISOR=yes`. Each tick reads `FOUNDRY_MISSION_LEDGER`, `FOUNDRY_W1_DEX_JOURNAL`, the optional `FOUNDRY_W1_DEX_POLICY` file, and the latest validated book, then chooses one of research, observe, hold, reconcile, cancel, consume, or place. The journal is evidence of prior decisions. It is not model training. With the live gate on and only W1's own quotes, the choice is `observe`: `spend_enabled` is true and `traded` is false. No standing order is invented to create activity. A standing order in the policy file is used at most once per Chicago day, and only when the book is empty and the exposure fits. `cancel_standing` withdraws an order this director reserved. It does not cancel preexisting quotes.

## Default-off install

Leave these unset: `FOUNDRY_W1_DEX_LIVE`, `FOUNDRY_DEX_EXECUTE`, and every `W0_SEED` through `W7_SEED`, including `W1_REGULAR_SEED`. This adapter does not read the shared secrets file. After the format below is provisioned locally, put only the W1 regular key in an absolute file outside this checkout, mode `0600`, one link, not a symlink. The regular key address is not W1. The transaction account stays W1. A derived address equal to W1 is the master key and is refused.

```json
{"account":"rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS","regular_key":"<address derived from the regular seed>","seed":"<W1 regular seed only>"}
```

Before any signature, the socket must show network id 1 and the validated W1 `AccountRoot.RegularKey` must equal both the file's `regular_key` and the address derived from that seed. There is no master-key fallback. Each tick re-reads `amm_info`, `account_lines`, `account_offers`, and `book_offers`. Issued AETH amounts are accepted with up to 15 digits after the decimal, including the live pool value `4923.542951524584`. An offer that sells AETH locks no XRP. Its sequence still counts toward the owner reserve, and the AETH stays in inventory instead of being priced as XRP. Offers this process signs still use at most 6 fractional digits. A previous snapshot is not reused when that read fails. While W1 holds the entire LP balance and no foreign quote is visible, the decision stays `research` with `traded: false`. `spend_enabled` can still be true.

## Migration from the installed 1 XRP / 5 XRP DEX gate

Do not delete the mission ledger or the decision journal. Do not reset the 1747-drop hold. Set `FOUNDRY_DEX_BANKROLL_DROPS=100000000` and remove `FOUNDRY_DEX_MAX_LOCKED_DROPS`. Until that variable is set, `verifiedEnv` fails and the supervisor holds. The bankroll is inactive until the operator installs this build and sets the variable. No fresh 100 XRP is added on top of the live LP or the open quotes. W0 is not a funder. No faucet and no transfer from W2–W7 is part of this package. W7 is an Xahau testnet account and is not an xrpl:1 balance.

Health reads the file mode and path only. It does not derive the key.

```sh
node -e 'console.log(JSON.stringify(require("./src/business/dex/live").health(process.env)))'
```

A dormant result has `dormant: true`, `activated: false`, and `live_proof: false`. `account_file` is `unset`, `missing`, `present`, `refused`, or `symlink`. `present` means a regular mode `0600` file outside the checkout. It does not mean the seed matches.

## Preflight

Preflight checks the file address field against W1. It does not derive the key and does not connect. Derivation happens only inside an activated connection, and only after `server_info` has reported network id 1. A wrong network closes the socket before the key is opened. Run preflight only on the operator machine, and do not pass dependency injection:

```sh
node -e 'require("./src/business/dex/live").preflight(process.env).then((row)=>console.log(JSON.stringify(row))).catch((error)=>console.log(error.code))'
```

## Opt-in and restart

All of these must be set together. A restart with the same environment and the same mission ledger is safe: an idempotency key that already reached `submit_attempted` is not signed or submitted again. A restart does not release an outstanding hold.

- `FOUNDRY_DEX_EXECUTE=yes`
- `FOUNDRY_DEX_ROLE=W1`
- `FOUNDRY_DEX_NETWORK=xrpl:1`
- `FOUNDRY_DEX_ACCOUNT=rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS`
- `FOUNDRY_DEX_ACTIVATE=ACTIVATE-W1-DEX-ROLE`
- `FOUNDRY_DEX_BANKROLL_DROPS=100000000`
- `FOUNDRY_DEX_RLUSD=yes` enables W1 RLUSD trading. Leave it unset and the supervisor does not place RLUSD. `bin/start` for the payment worker is unchanged and stays asleep. The DEX supervisor is a separate process. Do not put a seed in its environment. The first tick opens one W1 RLUSD trust line with NoRipple and a limit of 10, if that line is missing and the headroom after the AETH high-water covers the 0.2 XRP reserve. The next tick places one passive RLUSD bid of 1 XRP that does not cross the outside ask. A self-payment is used only when that book has no outside ask, with `SendMax`, `DeliverMin`, and a 1 percent haircut. Open RLUSD exposure, including a resting offer and any unreconciled transaction, stays at or below 2 XRP. Keys are stable for the trust line, the resting offer, the Chicago day, and a cancel. A resting offer stays open until a validated account offer list shows it gone after a proved cancel. One RLUSD transaction is signed per tick, and at most two economic RLUSD orders are signed per Chicago day. A resting offer that leaves the book is proved from the consuming transaction, or, when `validated_ledger` is older than every `complete_ledgers` start and history is empty, from reconcile records that already store `tesSUCCESS`, the hash, that ledger, and the TrustSet balance. A reserve-time baseline is not a proof. A gap in `complete_ledgers` is not pruned history. The Nov 8 rows from release `6aef386c` do not carry those reconcile fields. After the offer is missing from three different validated ledgers and history still cannot attribute it, the row becomes `rlusd_vanished_unattributed`: the offer lock is released, and exposure is the current RLUSD balance mark. That is not an outside fill. A new offer locks its own 0.2 XRP owner reserve until a proof shows it consumed or cancelled. A sell needs both an outside bid and an outside ask, and its price sits strictly above that bid and at or below that ask. A 1 percent step that jumps the spread is pulled back inside it. The key uses the current Chicago day, and the mark must cover the offer reserve. A missing transaction that the XRPL client throws as txnNotFound, entryNotFound, actNotFound, or lgrNotFound is treated as that error, not as an unknown lookup. The vanished row closes on the third distinct validated ledger that confirms the absence. A cancelled or expired sell releases the reserve and marks the RLUSD still on the line. A partial sell keeps the unsold remainder's mark plus that reserve. A finished sell key is not replayed into a new place. `FOUNDRY_W1_DEX_WS` may list testnet sockets in order; the first one that proves network id 1 is used. Inventory is then the lower of the pool and the best outside bid, less 10 percent. A house or AMM counterparty is not an outside fill. If the socket times out, the tick is `observe` / `degraded`, nothing is signed, and the process keeps running. It does not exit the AETH pool unless the saved policy already says `rebalance: "exit-sole-lp"`. If the headroom is below 1 XRP, the journal proposes that exit and does not send it.
- `FOUNDRY_DEX_MAX_AETH=10`
- `FOUNDRY_DEX_AXELAR_DROPS=0`
- `FOUNDRY_W1_DEX_LIVE=yes`
- `FOUNDRY_W1_DEX_WS=wss://testnet.xrpl-labs.com`
- `FOUNDRY_W1_DEX_ACCOUNT_FILE=/absolute/path/outside/checkout/w1.json`

`FOUNDRY_DEX_KILL=yes` stops new reservations and does not cancel open offers or release holds.

## Shutdown

Every live tick disconnects the socket in a `finally` block, including when signing or submission throws. Shutdown does not delete the mission ledger and does not release a hold.

## Reconciliation

- The offer's own validated metadata must show both the XRP and AETH deltas. A missing offer node is not a fill.
- A later consuming trade is reconciled from `account_tx` over the create ledger through the validated ledger, with no `marker`. Exactly one foreign transaction may touch that offer sequence. Its metadata must delete or reduce the W1 offer and the W1 balance deltas must match both sides. Zero such transactions leaves the reserve in place. Two or more stay unresolved.
- `txnNotFound` releases a hold only through the existing sanctioned absence proof. A long-lived W1 sequence does not satisfy that proof, so an ordinary unfound offer stays outstanding.
