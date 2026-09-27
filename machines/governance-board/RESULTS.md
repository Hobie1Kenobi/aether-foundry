# Governance board — RESULTS

**Network:** XRPL Testnet  
**Date:** 2026-09-27  
**Hunch:** H1 (Director 2, Treasurer 2, Atelier 1, Market 1, quorum 3)  
**W0:** `rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs`

## Live set (Foundry box 2026-09-27)

| Item | Hash |
|------|------|
| SignerListSet (quorum 3) | `EDD27C458D314602E6059D8351D2DDA322A5E4BD1FD55602B3D2E667EA970299` |
| SetRegularKey W1 | `BE9FFD71974AA61D7525F3002564C98EF02FAD6D5005951E4E0D35D6092D04C6` |
| SetRegularKey W2 | `E235A6A2D7BC3495870A99E0C8748A278235E3070F897E931820618D33F540AC` |
| SetRegularKey W3 | `FCA7EBA1993980ABE2B49AEABD261160D29922E25AF573D9D1896F89AB0A544C` |
| SetRegularKey W4 | `337941DF15A47FEAAFB09AE52E76A21AE073442D89C77733491C25CD9FE10564` |
| SetRegularKey W5 | `EFC010077E587E2DDC7971CDFC535304A9533F42474E6E4F034E9FC07CB1CE99` |
| SetRegularKey W6 | `09BD4B69B05411FC864E38A9AA7C04897AAB22F47D2F44D4CAC85CEC848C5864` |
| Multi-sign Payment (Director+Market, 10000 drops → W6) | `9162E6DFD7CD2BFB413CC90470A7E8124B66DF241A620442FD39F3FC3F379C24` |

Public addresses and hashes also live in `activated.json`. Signer / regular-key **seeds** stay only in `/workspace/aether-foundry-secrets/.env` (never git). Master keys remain enabled (`lsfDisableMaster` unset).

### Signer addresses (H1)

| Persona | Weight | Address |
|---------|-------:|---------|
| Director | 2 | `rpEpjesFRPcpWWVKoheDT59YKtoA6Xureg` |
| Treasurer | 2 | `rHG25YbFNqFL9HzVqa9JQhXFY9Zignxznh` |
| Atelier | 1 | `rGfkxsMvv833ioy2QjmTXhYF49J94N9WRu` |
| Market | 1 | `r4Qc6iUKrLZQwM9sPdPWCCHAK2bcMsrxVr` |

### Regular keys

| Wallet | Account | RegularKey |
|--------|---------|------------|
| W1 | `rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS` | `rDyiGKuMgL2F8S7TjB6m6Wg1pLg5KDPJYY` |
| W2 | `rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw` | `rNNzhkcScozB7Nzv3cWCZAEnu6MMC64rmy` |
| W3 | `rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw` | `rJRxr1E1Dzz5TXJsCHhwQAm4qS68Y73dQj` |
| W4 | `ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN` | `rfXBxqPjprj1J5Ekq5v82D3BDqRm7ms7p2` |
| W5 | `rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ` | `rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q` |
| W6 | `rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf` | `rGjdFjMz577GF4uvb4N9ayCqP5Q74kwVq5` |

Cloud-agent PR trial had no master seeds; this Foundry-box run is the activation archive.

## Read-only pre-state (`npm run gov:dry`)

Validated ledger **21101142**. Network id **1**. Base reserve **1000000** drops (1 XRP). Incremental reserve **200000** drops (0.2 XRP). These rows are `account_info` with `signer_lists: true`. They are not transactions.

| ID | Balance drops | OwnerCount | RegularKey | Signer lists | lsfDisableMaster | lsfPasswordSpent |
|----|---------------:|-----------:|------------|-------------:|------------------|------------------|
| W0 | 97999916 | 1 | none | 0 | no | no |
| W1 | 50032224 | 7 | none | 0 | no | no |
| W2 | 112009895 | 2 | none | 0 | no | no |
| W3 | 105994928 | 0 | none | 0 | no | no |
| W4 | 110010039 | 1 | none | 0 | no | no |
| W5 | 99999988 | 1 | none | 0 | no | no |
| W6 | 100000000 | 0 | none | 0 | no | no |

W0 owner delta for a new SignerList is **+1**. Projected reserve after the list: `1000000 + 2 × 200000 = 1400000` drops. Balance 97999916 is above that. No regular key is set on W1–W6, and `lsfPasswordSpent` is unset, so the first `SetRegularKey` on each account is still inside the free-fee window. The script pays autofill's normal fee anyway.

Signer addresses were not assigned. The dry-run does not read seeds.

## Foundry-box command

```bash
npm run gov:dry
npm run gov:live
npm run gov:multisign
```

`gov:live` generates `SIGNER_DIRECTOR_SEED`, `SIGNER_TREASURER_SEED`, `SIGNER_ATELIER_SEED`, `SIGNER_MARKET_SEED`, and `W1_REGULAR_SEED`…`W6_REGULAR_SEED` into the secrets file when they are missing, then submits. It prints public addresses only.
