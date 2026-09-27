# THREAT — Drip Pass (Adversary sign-off)

## Expire / SettleDelay grief — dest vs source `tfClose` (session-4 drill)

**Rule under test:** PaymentChannel with `SettleDelay >= 300` (5 minutes).

### Observed asymmetry (XRPL Testnet 2026-09-27-4)

| Closer | Immediate effect | Unclaimed XRP | SettleDelay role |
|--------|------------------|---------------|------------------|
| **Destination** `tfClose` | PayChannel **Deleted** in the same validated ledger | Returns to **source now** | **Does not delay** dest-initiated close |
| **Source** `tfClose` | PayChannel **Modified**; `Expiration = close_time + SettleDelay` | Locked until Expiration; dest may still claim | **Binds the source** — capital grief window |

**Evidence (SettleDelay = 300):**

- Dest path: create `6AB809739241786772F6171AD210427F5A776BD55FAC0605655A6556B1CDA3EE` → channel `2E8127901427C3696EBAEA50FFC59F774D23C35D3402EA2598361DD995F60568` → dest `tfClose` `E233D2E8C6AB41DA5A6C9032D566D127CB21F7DA58A58BB7C97743DB5021CE33` → **DeletedNode** (Balance 0, Amount 2 XRP returned to STRANGER).
- Source path: create `C1ACB9658B27DEDDF5108F63118091D345FF0B4346F77A6298119A0B7539DC5C` → channel `F83E073B648600D863FC8F3BB53B047D697FD1B87136A05B72F2F8296B7CC40E` → source `tfClose` `D04A320649912A028C27E67922BF681CEF6ADF12FBF2ACF46B884962A55BCF04` → still on ledger with `Expiration=843837231` (~**10:13:51 CT** = Ripple Epoch + 946684800).

**Corrected threat model (replaces earlier “dest close locks source for SettleDelay” shorthand):**

- **Grief vector:** Source wants to abort / reclaim early → must wait full SettleDelay while destination can still redeem signed claims.
- **Dest power:** Destination can nuke the channel immediately (forfeiting unredeemed claim opportunity); source gets unclaimed balance back without waiting.
- **Mitigation:** Size Amount to expected claims + small buffer; on testnet prefer low SettleDelay unless deliberately drilling grief; monitor `Expiration` after source `tfClose`; never assume dest close equals source close.

This is a **threat-note drill only** — not Drip Pass v2.

## Wrong destination / tag

**Threat:** Channel created to wrong Destination (or mistyped account). Claims only redeemable by that Destination; if source then `tfClose`, source waits SettleDelay to recover.

**Mitigation:** Hard-code W3 from `corp/wallets.md`; dry-run address check before submit; no DestinationTag required in v0 (if RequireDest ever set on W3, claims/create fail).

## Unfunded channel

**Threat:** Create Amount exceeds spendable XRP (balance − reserve − owner reserve) → `tecUNFUNDED`.

**Mitigation:** Faucet-top source before create; health check spendable ≥ Amount + fees + reserves.

## Claim overbalance

**Threat:** Signature authorizes Amount greater than channel Amount, or Balance regresses → `temBAD_AMOUNT` / `tecUNFUNDED_PAYMENT` class failures. Replay of lower cumulative claim ignored if Balance already higher.

**Mitigation:** Strictly increasing cumulative 2/4/6; never sign above channel Amount; verify `signPaymentChannelClaim` uses XRP string not drops.

## Signature / key mismatch

**Threat:** Claim PublicKey ≠ channel PublicKey or bad Signature → `temBAD_SIGNATURE` / `tecNO_PERMISSION`.

**Mitigation:** Always use source key that created the channel; store channel ID from create meta, not reconstructed.

## Memo / lab desync

**Threat:** Memo points at wrong lab note or hash; social/audit mismatch only (ledger does not enforce).

**Mitigation:** Hash `lab/drip/000N.md` at claim time; record sha256 in RESULTS.

## Seed exposure

Seeds only in secrets `.env` mode 600. Never print or commit.
