# F8 — Sponsor a new Devnet account

**Status:** unsigned. No hash until the Foundry box passes `--live`.  
**Network:** XRPL Devnet, network id **2** only.  
**Amendment:** `Sponsor` (`BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC`).  
**Sponsor:** D0. **Sponsee:** a new D2. Not W0–W6, BUYER, STRANGER, AMM, or FOREIGN.

D0 pays 1 drop with `tfSponsorCreatedAccount`, so the new account reserve sits on D0. D2 then holds a `DepositPreauth` whose fee and object reserve D0 co-signs. D2 must not be faucet-funded first.

```bash
npm run frontier:devnet-sponsor
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step create
FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step object
```

Operator note: [`lab/frontier/DEVNET.md`](../../lab/frontier/DEVNET.md). Seeds: `D0_SEED`, `D2_SEED`.
