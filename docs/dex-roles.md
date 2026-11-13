# Testnet house roles

W1, W3, and W4 can each run the DEX supervisor. They share one 100 XRP bankroll and one RLUSD team cap through `FOUNDRY_MISSION_LEDGER`. The shipped team cap is 3500000 drops. Leave `FOUNDRY_DEX_RLUSD_TEAM_CAP_DROPS` unset to use that default. A lower drop string tightens it. A higher value does not activate.

W1's own RLUSD exposure still stops at 2000000 drops. W3 stops at 500000. W4 stops at 1000000. Outstanding amounts are added once. An uncertain in-flight hold on one role blocks new signatures on the others. Learning stays off. Axelar and EVM budgets stay 0. The only RLUSD issuer is `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`. The pool is `rPn7kHwycXzS5XNj167CnKwC2t82yAAdNW`. W0 never signs.

Each role has its own journal directory and its own mode-0600 key file outside this checkout. The process reads that file by path and does not print the seed. One signature is allowed per tick per role. The missions payment worker and hold `msn5b5c3223e5e88526` are not part of this loop.

## W1 market maker

Unchanged activation. `FOUNDRY_DEX_ROLE=W1` with `ACTIVATE-W1-DEX-ROLE`, `FOUNDRY_W1_DEX_SUPERVISOR=yes`, `FOUNDRY_W1_DEX_LIVE=yes`, `FOUNDRY_W1_DEX_JOURNAL`, and `FOUNDRY_W1_DEX_ACCOUNT_FILE`. `FOUNDRY_DEX_RLUSD=yes` still opts into RLUSD. Passive AETH and RLUSD behavior is the same book as before.

## W3 pool taker

`FOUNDRY_DEX_ROLE=W3`, account `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw`, phrase `ACTIVATE-W3-DEX-ROLE`. Also set `FOUNDRY_DEX_EXECUTE=yes`, `FOUNDRY_DEX_NETWORK=xrpl:1`, `FOUNDRY_DEX_BANKROLL_DROPS=100000000`, `FOUNDRY_DEX_MAX_AETH=10`, `FOUNDRY_DEX_AXELAR_DROPS=0`, `FOUNDRY_DEX_RLUSD=yes`, `FOUNDRY_W3_DEX_LIVE=yes`, `FOUNDRY_W3_DEX_SUPERVISOR=yes`, `FOUNDRY_W3_DEX_JOURNAL`, and `FOUNDRY_W3_DEX_ACCOUNT_FILE`.

The taker sends `tfImmediateOrCancel` OfferCreate transactions of 0.1 to 0.25 XRP against the official RLUSD book, at most four economic orders per Chicago day, after opening a NoRipple trust line if it is missing. A fill writes counterparty accounts into that role's journal immediately. House wallets and both house AMM accounts are not outside fills.

## W4 resting quoter

`FOUNDRY_DEX_ROLE=W4`, account `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN`, phrase `ACTIVATE-W4-DEX-ROLE`. Use `FOUNDRY_W4_DEX_LIVE`, `FOUNDRY_W4_DEX_SUPERVISOR`, `FOUNDRY_W4_DEX_JOURNAL`, and `FOUNDRY_W4_DEX_ACCOUNT_FILE` with the same shared network, bankroll, Axelar, and RLUSD flags.

One passive bid and/or ask sits inside the official spread. Cancel or replace waits at least 2 hours and refreshes by 3 hours. Exposure for this role stays at or below 1 XRP.

## W5 RLUSD oracle

Dry-run is the default. It prints an unsigned OracleSet for official RLUSD/XRP and does not read a key.

Live needs `FOUNDRY_W5_ORACLE_LIVE=yes`, `FOUNDRY_W5_ORACLE_SUPERVISOR=yes`, `FOUNDRY_W5_ORACLE_ACTIVATE=ACTIVATE-W5-RLUSD-ORACLE`, `FOUNDRY_DEX_EXECUTE=yes`, `FOUNDRY_DEX_NETWORK=xrpl:1`, `FOUNDRY_DEX_AXELAR_DROPS=0`, `FOUNDRY_W5_ORACLE_JOURNAL`, and `FOUNDRY_W5_ORACLE_ACCOUNT_FILE`. The signer posts from W5 only, fees only, at most every 30 minutes. Document 1 remains the AETH oracle. This publisher uses document 2. OracleSet is on the agent signer allowlist for W5 only.

## Ensure-up

`machines/dex/ensure-up.snippet.sh` is documentation. It is not sourced by `bin/start`, cron, or the missions worker. An operator may paste it into the host ensure-up hook before that script's final `exit 0`. The snippet starts a role only when that role's supervisor flag is already `yes`, and it leaves a live pid alone. It does not read or print key files.
