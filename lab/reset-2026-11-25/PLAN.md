# Aether Foundry — XRPL Testnet/Devnet reset rebuild plan (2026-11-25)

Status: **plan + dry-run only.** No transaction has been signed or submitted. Approved to prepare by Hobie (Mon 2026-11-23). Every live step below needs Hobie's go on Wed night.

Notice: https://xrpl.org/blog/2026/testnet-devnet-reset — Testnet **and** Devnet wiped Wed 2026-11-25, 5–6 PM PT = **7–8 PM CT**. All accounts, balances, settings, offers, AMMs, escrows, NFTs are deleted. Same addresses can be re-funded from the faucet. **Re-created AMMs get new account addresses.** Testnet amendments are restored to **match Mainnet**. URLs and network id (1) stay the same. Mainnet and Xahau are not affected (W7 hook account and the Xahau split are untouched).

Files in this folder:

| File | What |
|---|---|
| `pre-reset-snapshot.json` | Read-only state of W0–W6, BUYER, STRANGER, FOREIGN, LP-badge-bound accounts, AMM, RLUSD issuer, amendments, ledger-log/metrics freeze hashes. Taken 2026-11-23 09:37 CT, validated ledger 22,553,108 (Labs). Public data only. |
| `rebuild-plan.json` | Ordered unsigned tx templates generated from the snapshot (`node src/reset/rebuild.js --plan`). |
| `ops/reset-pause.sh`, `ops/reset-resume.sh` | Box service pause/resume (copies installed in `/workspace/foundry-ops/`). |
| `rebuild-log.jsonl` | Created Wed night by `--live` steps: step id, engine result, hash. No blobs, no seeds. |

Scripts (repo, no secrets): `src/reset/snapshot.js` (read-only), `src/reset/rebuild.js` (`--detect` read-only, `--plan` dry-run, `--live --step <id>` gated), `src/reset/anchors.js` (live-config address swap, dry-run by default), `src/reset/accounts.js` (public addresses).

`--live` refuses unless `REBUILD_GO=2026-11-25` is set, refuses under CI, refuses until `--detect` shows Labs serving a fresh (<5M) ledger in `full` state, runs one step per call, never retries, and refuses a step with an unresolved hash in the log (look it up by hash instead of resubmitting). It reads only the one seed that step needs from `/workspace/aether-foundry-secrets/.env` and never prints it.

---

## 1. What the reset erases (from the snapshot)

| Account | State that will be gone |
|---|---|
| **W0** treasury `rJ9WRL…EbVs` | 97.99 XRP. Flags `defaultRipple`, `allowTrustLineLocking`. Domain `aether-foundry-desk.vercel.app`. DID (URI = corp/charter.md). **SignerList quorum 3**: Director `rpEpje…Xureg` w2, Treasurer `rHG25Y…xznh` w2, Atelier `rGfkxs…WRu` w1, Market `r4Qc6i…srxVr` w1. No RegularKey on W0 (master only). AETH issuer: 10,100 outstanding. |
| **W1** market `rsi9kh…phzS` | 49.04 XRP. RegularKey `rDyiGK…JYY`. AETH 4,976.457; LP tokens 504,886.588; RLUSD dust (limit 10). 5 DEX offers (AETH bids/asks, 1 RLUSD bid). NFTs: LP Badge v0, one taxon-20261012 license-type NFT. DID (Batch heartbeat data). AMM auction slot + vote slot. |
| **W2** atelier `rLBKyi…UywKEw` | 124.02 XRP. RegularKey `rNNzhk…rmy`. NFTs: Artifact #0 (README), **Walk-In** `…1E1248CC60141DD5E` (taxon 20260927, flags 8, fee 1000, URI walk-in-window/INBOUND.md). **Walk-In sell offer** `CEAC38D1…159654F` 10 XRP. MPToken (labor, 9). MintedNFTokens 11. |
| **W3** channels `rB6tyD…n43Fw` | 105.92 XRP. RegularKey `rJRxr1…dQj`. RLUSD line (limit 10). Inbound PayChannel from STRANGER. x402 pay-to. |
| **W4** escrow `ra9X6T…D8pN` | 108.01 XRP. RegularKey `rfXBxq…7p2`. AETH 50, RLUSD line, 1 RLUSD bid (0.2 XRP). MPToken (labor, 1). Destination of the BUYER **Unix-epoch scar escrow** `908D26FC…D346E7` (erased by the reset; record kept here; do not recreate). |
| **W5** R&D `rGpUbs…RgKQ` | 100.01 XRP. RegularKey `rav5cY…y7Q`. **Oracle doc 1** AETH/XRP (last 2026-09-28) and **doc 2** RLUSD/XRP (updated daily by the W5 RLUSD-oracle role). Labor MPT issuance `0141DD60…19504ED` (AETH-LABOR, cap 1,000,000, 10 out). Credential `aether-agent` → `rDUj1U…ofwi`. PermissionedDomain `6AF56BC1…52DCD4`. NFT Epoch Scar. AGT line from an outside issuer. |
| **W6** grants `rfnqxY…v8yTf` | 88.01 XRP. RegularKey `rGjdFj…kwVq5`. Nothing else (grants paused). |
| **AMM** `r4nTCa…S4w` | 51.783389 XRP + 4,923.542951524584 AETH, fee 500 (0.5%), price ≈ 0.010518 XRP/AETH. W1 is the only LP. LP currency `0330E60F…B89931`. |
| BUYER / STRANGER / LPB_* / FOREIGN | Test counterparties: AETH lines (50 each on BUYER, STRANGER, LPB_HOLDER), NFTs #1/Drip/Oracle-Mid/Walk-In-v1, LP-badge-bound DepositAuth door + credential, STRANGER→W3 PayChannel. |
| Devnet D0–D3 | Wiped too. Historical only; not rebuilt unless asked. |

Off-ledger state that survives and must not be touched: `lab/ledger-log.jsonl` (frozen at 300 lines, sha256 `c4c50077…a9891` at snapshot), `lab/metrics.json`, signer journals, DEX role journals under `/workspace/foundry-ops/*/journal`, missions/payments worker state, and the legacy hold **`msn5b5c3223e5e88526`** (1,747 drops) records in `src/missions/*`, `machines/diagnostics/BUYER.md` and the missions runtime. Old tx hashes in docs stay as history; explorer links to them will stop resolving after the reset.

## 2. Amendment changes to expect (Testnet → Mainnet set)

Currently enabled on Testnet, Mainnet status per xrpl.org (table dated 2026-09-16, recheck live):

| Amendment | Foundry use | Risk after reset |
|---|---|---|
| AMM, DID, PriceOracle, Credentials, PermissionedDomains, MPTokensV1, TokenEscrow, PermissionedDEX, DepositAuth, NFTokenMintOffer | AMM, DIDs, oracle, CDS shop, labor MPT, token escrow | Enabled on Mainnet → stay on. |
| **BatchV1_1 / fixBatchV1_2** | Batch heartbeat (6 h) | BatchV1_1 was "expected 2026-09-29" on Mainnet; fixBatchV1_2 unknown. **Batch heartbeat stays off until `npm run frontier:probe` shows both enabled after the reset.** |
| PermissionDelegationV1_1 | none live | Was 62.86% on Mainnet in Sep; may disappear. |

Step: right after detection, `npm run frontier:probe` (writes `lab/frontier/amendments.json`) and diff against `pre-reset-snapshot.json.amendments`.

## 3. Pre-reset steps (Wed 2026-11-25)

| When (CT) | Step |
|---|---|
| Done Mon 09:37 | Snapshot #1 committed (this folder). |
| Wed ~6:15 PM | Final snapshot: `node src/reset/snapshot.js --out lab/reset-2026-11-25/final-pre-reset-snapshot.json`, then commit/push (captures any Walk-In sale, oracle tick, ledger-log lines since Monday). |
| Wed 6:45 PM | Parent pauses agent routines (section 6). Disable GitHub Actions: `gh workflow disable 368522035` (Walk-In remint watch, every 30 min, would commit a false `walk_in_sold_out`), `gh workflow disable 369529933` (Director clock, hourly snapshot/wake), `gh workflow disable 375958699` (Peer hello watch). |
| Wed 6:45 PM | Box: `bash /workspace/foundry-ops/reset-pause.sh` — writes `/workspace/foundry-ops/RESET-PAUSE` (ensure-up.sh now exits early while it exists, so cron and the .bashrc hook do not restart anything), stops signer, herald, Walk-In watch loop, scribe, license server, W1 DEX supervisor and W3/W4/W5 role supervisors. Missions/payments workers untouched. |
| Wed 7:00–8:00 PM | Reset window. Nothing runs. |

## 4. Post-reset rebuild runbook (ordered)

Every command from `/workspace/aether-foundry`. `export REBUILD_GO=2026-11-25` only after Hobie says go. Each `--live` call is one step; read its line before the next.

**Phase 0 — detect (read-only, repeat every ~10 min from 8:00 PM):**
`node src/reset/rebuild.js --detect` → proceed when `labs_reset: true`, `labs.server_state: "full"`, `labs.w0: "actNotFound"`. The box cannot reach Ripple's `:51234/:51233` today (TLS reset on non-443 ports), so Ripple shows `unreachable`; the faucet host (443) is reachable. If Labs keeps serving the old chain (validated seq ≈ 22.55M) after Ripple announces completion, **wait**; do not sign against the stale chain. Then `npm run frontier:probe` (amendments).

**Phase 1 — fund (faucet, same addresses):** `--live --step fund-W0` … `fund-W6`, one at a time, ~15 s apart. Faucet `POST https://faucet.altnet.rippletest.net/accounts {destination}` gave ~100 XRP per request at boot (2026-09-27); the faucet page now has a request-amount field, cap unverified. 7 requests ≈ 700 XRP, enough for everything below (W1 needs ~52 XRP for the pool + ~3 XRP reserves; base reserve 1 XRP, owner reserve 0.2 XRP). If a faucet call fails or rate-limits: check `account_info` for that address before any second request; never loop. Expect faucet congestion right after the reset; budget 30–60 min. Optional later: BUYER, STRANGER, FOREIGN (x402 outbound counterparty), LP-badge-bound accounts.

**Phase 2 — keys (master-signed, W1–W6):** `regkey-W1` … `regkey-W6` → `SetRegularKey` to the same regular-key addresses as before (`corp/wallets.md`). Until these land, the signer's regular keys cannot sign (tefBAD_AUTH), so the signer stays stopped.

**Phase 3 — W0 treasury (W0 master; one-time exception to "W0 never signs routine txs"):** `w0-defaultripple` (asfDefaultRipple, **before any trust line**), `w0-domain`, `w0-trustline-locking` (optional; skip if TokenEscrow off), `w0-did` (charter URI), `w0-signerlist` (quorum 3, same 4 signers/weights). Signer accounts need not be funded.

**Phase 4 — AETH:** `w1-trust-aeth` (limit 1,000,000), `w4-trust-aeth` (limit 1,000), `w0-issue-w1` 9,900 AETH, `w0-issue-w4` 50 AETH → 9,950 outstanding. Optional to return to 10,100: fund BUYER/STRANGER, TrustSet, 50 AETH each (+100). LPB_HOLDER's 50 cannot be restored without its seed (not in the secrets file) → see blockers.

**Phase 5 — AMM:** `w1-ammcreate`: 51,783,389 drops + 4,923.542951524584 AETH, TradingFee 500 → same depth and price as before (≈0.010518 XRP/AETH). Read the **new AMM account** and LP currency from `amm_info` (asset XRP / AETH.W0). Then `node src/reset/anchors.js --new-amm <r…> --new-lp <hex>` (dry-run), then `--apply`, then `npm test`. Live-config files it edits: `web/lib/xrpl-public.ts`, `web/lib/x402-rules.js`, `web/lib/x402-facilitator.js`, `public/xrp-ledger.toml`, `src/director/anchors.js`, `src/report/nav.js`, `src/lp-badge-bound-guard.js`, `corp/wallets.md`, `lab/OPERATOR.md`, `README.md`, three session scripts. Fixtures/tests/history untouched (test fixtures with the old AMM stay as recorded data). Add a row to `corp/wallets.md`: "AMM (pre-reset, wiped 2026-11-25) r4nTCa…S4w".

**Phase 6 — RLUSD (conditional):** RLUSD Testnet issuer `rQhWct2f…9iLKV` is Ripple's. After the reset it exists only if Ripple re-creates it. `w1/w3/w4-trust-rlusd` (limit 10, NoRipple) auto-skip when absent. Team RLUSD cap stays 3.5 XRP; the W3 guard and the roles re-place their own small bids/offers under policy. Do not hand-place the old offers.

**Phase 7 — shop, oracle, licenses:**
- `npm run remint:walk-in` (W2 master from secrets; refuses CI; refuses while an offer is open) → mints the Walk-In (taxon 20260927, flags 8, fee 1000, INBOUND.md URI) and lists the 10 XRP sell offer; writes the new NFTokenID/OfferID to `machines/walk-in-window/RESULTS.md` and `lab/ledger-log.jsonl`. This must happen **before** the Walk-In watch resumes, so its "last known offer" is the new one.
- Oracle doc 1: `npm run frontier:oracle-set -- --live` (W5 regular key) from the new pool price. Doc 2 (RLUSD/XRP) comes back on its own when the W5 role restarts, only if the RLUSD issuer exists.
- Work License: no standing listing existed (W2 had only the Walk-In offer), so nothing to restore. Next `license:demo -- --live` mints/lists normally. `machines/agent-work-license/RESULTS.md` must not carry an old OfferID row, or the watch will call it sold out.
- Deferred unless Hobie wants them (all get **new IDs**): labor MPT (new `mpt_issuance_id`; update `web/lib/devnet-frontier.js`, `src/frontier/devnet-guard.js`, `corp/wallets.md`, `machines/labor-mpt`), CDS credential + PermissionedDomain (new `domain_id`), LP-badge-bound door/credential, Artifact #0 remint, W1 boot-era passive offers (`npm run offers`).
- x402 controlled seller: pay-to W3 address is unchanged. T54 facilitator's own Testnet wallets are also wiped → re-check its `/health` and a dry-run challenge before any paid test.

**Phase 8 — services and verification:**
1. `bash /workspace/foundry-ops/reset-resume.sh` (removes RESET-PAUSE, runs ensure-up, prints status). Signer `/health` must show `network_id 1` and W1–W6 ready.
2. W1/W3/W4/W5 DEX roles: run the current release preflights (`/workspace/foundry-ops/w1-dex-runtime/preflight-9a0f203.sh`, `/workspace/foundry-ops/dex-roles/preflight-roles-9a0f203.sh`; confirm they are read-only first) before trusting live ticks; journals are kept as-is.
3. `node src/reset/snapshot.js --out lab/reset-2026-11-25/post-rebuild-snapshot.json`; compare with the pre snapshot: W0 flags/Domain/DID/SignerList, six RegularKeys, AETH lines, AMM depth/fee, Walk-In offer 10 XRP, oracle doc 1.
4. `npm run health`, `npm run report:nav`, desk `curl` checks (`/`, `/.well-known/xrp-ledger.toml`, `/api/inbound/walk-in`). Redeploy Vercel `aether-foundry-desk` if push to main does not.
5. Signer heartbeat: first Batch heartbeat only after the amendment probe is green; the 6-hour limit still applies.

**Phase 9 — records and site:** append a `testnet_reset` row to `lab/ledger-log.jsonl` (reset ledger index, rebuild hashes); `lab/metrics.json` starts a new series (pre-reset numbers frozen, not merged). Banner in `README.md`, `lab/OPERATOR.md`: "Testnet history before 2026-11-25 was wiped by Ripple's reset; hashes below are historical and no longer resolve." Update OPERATOR hard law 4 (scar escrow gone with the reset). `lab/director-state.json`: refresh via `npm run director:snapshot`. Re-enable the three GitHub workflows (`gh workflow enable …`). Weekly NAV: post-rebuild NAV is a **new baseline**, not a gain or loss versus 660.79 XRP. ASM proof page: check that its XRPL Testnet house rows link nowhere broken (house activity remains house activity, not revenue).

## 5. Steps that need W0 / master keys

`regkey-W1..W6` (Wn master), all W0 steps (W0 master), Walk-In remint (W2 master, as today). Everything else signs with existing regular keys. The rebuild process holds seeds only in memory for one step; the agent signer keeps its rule of never holding W0 or master seeds.

## 6. Routines (parent changes these)

Pause all at **Wed 6:45 PM CT**; resume each only after Phase 8 passes.

| Routine id | Action | After rebuild, first run should check |
|---|---|---|
| `foundry-agent-hands` | Pause. Presence payments W2–W6 would fail (actNotFound / bad auth) or hit a stale chain. | Signer `/health`; W2–W6 exist, RegularKey matches, spendable ≥ 5 XRP; one presence payment validated. Still labeled house activity. W6 grants stay off. |
| `foundry-walk-in-remint-watch` | Pause (plus GH workflow 368522035 and the box loop). Otherwise it records a false sold-out for offer `CEAC38D1…` and tries to remint into an unfunded W2. | Resume only after the Phase 7 remint wrote the new OfferID to RESULTS.md; first run must print `OPEN` with the new OfferID. |
| `foundry-morning-health` | Pause Thu morning if the rebuild is not verified; otherwise run it once as the verification. | Health green against the new AMM address; desk API, toml show new AMM; oracle doc 1 present. |
| `foundry-batch-probe` | Pause. | Resume only when `npm run frontier:probe` shows BatchV1_1 and fixBatchV1_2 enabled after the reset and W1 has a fresh DID path. Otherwise record "Batch off on post-reset Testnet" and stay paused. |
| `foundry-x402-xrpl-1-discovery` | Pause (testnet endpoints and facilitators are down during the window). | `candidates.json` unchanged (hash 3d0dab7b…); W3 funded; T54 facilitator healthy; seller 402 challenge still names W3. |
| `foundry-weekly-nav` | No pause needed (next run Mon Nov 30). Update its prompt. | NAV is a new post-reset baseline; do not compare to 660.79 as P&L; state the AMM address change. |

Also paused by `reset-pause.sh` (box, not routines): signer, herald loop, Walk-In watch loop, scribe, license server, W1 DEX supervisor, W3/W4/W5 role supervisors.

## 7. Timing estimate (CT)

| Wed–Thu | Expected |
|---|---|
| 6:15 PM | Final snapshot + commit (5 min). |
| 6:45 PM | Pause routines, GH workflows, box services (10 min). |
| 7–8 PM | Reset window (Ripple's estimate; past resets ran long). |
| ~8:00 PM → ? | Detect loop. Labs must also wipe and resync; this can lag Ripple by hours. |
| +0:30–1:00 | Phase 1 faucet (7 calls, congestion likely). |
| +0:30 | Phases 2–6 (~25 single txs, ~5 s each, plus checks). |
| +0:30 | Phase 7 remint/oracle + Phase 5 anchors swap, tests, push, desk redeploy. |
| +0:30 | Phase 8–9 verify, resume, docs. |
| Total | ~2–3 h after the network and faucet are back; realistic finish ~10–11 PM CT Wed, or Thu morning if Labs/faucet lag. |

## 8. Blockers / decisions for Hobie

1. **Go to submit** on Wed night (Testnet, ~25 txs + 7 faucet calls), including the one-time **W0 master-key** signing for flags/Domain/DID/SignerList/AETH issuance.
2. **AETH supply**: core rebuild gives 9,950 (W1 9,900 incl. pool, W4 50). Add BUYER+STRANGER (10,050)? LPB_HOLDER's 50 needs a seed we do not have in the secrets file; reissue its 50 to W1 to keep 10,100, or let supply drop?
3. **RLUSD** depends on Ripple re-creating issuer `rQhWct2f…9iLKV`; if it does not come back, the W3/W4/W5 RLUSD roles and oracle doc 2 stay dark.
4. **Optional rebuilds** (labor MPT, CDS domain, LP-badge-bound, Artifact #0, BUYER/STRANGER/FOREIGN) — each gets new ledger IDs and doc edits.
5. **Batch heartbeat** may be unavailable if Mainnet has not enabled BatchV1_1/fixBatchV1_2.
6. **Primary RPC lag**: XRPL Labs must also reset; Ripple RPC is unreachable from the box (non-443), so if Labs lags there is no second reader from here.
