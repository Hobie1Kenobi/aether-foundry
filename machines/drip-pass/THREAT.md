# THREAT — Drip Pass (Adversary sign-off)

## Expire / SettleDelay grief

**Threat:** Destination sets `tfClose` immediately after create; source must wait full SettleDelay before reclaiming unclaimed XRP. Grief = capital lock for SettleDelay (here 30s testnet; mainnet often hours–days).

**Mitigation:** Keep SettleDelay low on testnet; size Amount to expected claims + small buffer; monitor Expiration on PayChannel.

## Wrong destination / tag

**Threat:** Channel created to wrong Destination (or mistyped account). Claims only redeemable by that Destination; source waits SettleDelay to recover.

**Mitigation:** Hard-code W3 from `corp/wallets.md`; dry-run address check before submit; no DestinationTag required in v0 (if RequireDest ever set on W3, claims/create fail).

## Unfunded channel

**Threat:** Create Amount exceeds spendable XRP (balance − reserve − owner reserve) → `tecUNFUNDED`.

**Mitigation:** Faucet-top BUYER before create; health check spendable ≥ Amount + fees + reserves.

## Claim overbalance

**Threat:** Signature authorizes Amount greater than channel Amount, or Balance regresses → `temBAD_AMOUNT` / `tecUNFUNDED_PAYMENT` class failures. Replay of lower cumulative claim ignored if Balance already higher.

**Mitigation:** Strictly increasing cumulative 2/4/6; never sign above channel Amount; verify `signPaymentChannelClaim` uses XRP string not drops.

## Signature / key mismatch

**Threat:** Claim PublicKey ≠ channel PublicKey or bad Signature → `temBAD_SIGNATURE` / `tecNO_PERMISSION`.

**Mitigation:** Always use BUYER key that created the channel; store channel ID from create meta, not reconstructed.

## Memo / lab desync

**Threat:** Memo points at wrong lab note or hash; social/audit mismatch only (ledger does not enforce).

**Mitigation:** Hash `lab/drip/000N.md` at claim time; record sha256 in RESULTS.

## Seed exposure

Seeds only in secrets `.env` mode 600. Never print or commit.
