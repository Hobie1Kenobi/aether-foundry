#!/usr/bin/env node
"use strict";
/**
 * Aether Foundry post-reset rebuild (XRPL Testnet, network id 1).
 *
 *   node src/reset/rebuild.js --detect            read-only: has the 2026-11-25 reset happened?
 *   node src/reset/rebuild.js --plan              write unsigned step list to lab/reset-2026-11-25/rebuild-plan.json
 *   node src/reset/rebuild.js --live --step <id>  ONE step, only with REBUILD_GO=2026-11-25 (Hobie's go)
 *
 * Rules: testnet only; one step per invocation; never retries; refuses a step already
 * logged tesSUCCESS; refuses CI; seeds are read from the secrets file for that step only
 * and never printed. The log keeps hashes and engine results only.
 */
const fs = require("fs");
const path = require("path");
const hosts = require("../xrpl-hosts");
const A = require("./accounts");

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "lab", "reset-2026-11-25");
const PRE = path.join(DIR, "pre-reset-snapshot.json");
const LOG = path.join(DIR, "rebuild-log.jsonl");
const SECRETS = process.env.AETHER_SECRETS || "/workspace/aether-foundry-secrets/.env";
const FAUCET = "https://faucet.altnet.rippletest.net/accounts";
const RESET_MAX_LEDGER = 5000000; // pre-reset validated ledger was ~22.55M

const byId = Object.fromEntries([...A.HOUSE, ...A.AUX].map((a) => [a.id, a]));
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const AETH = (value) => ({ currency: A.AETH_HEX, issuer: byId.W0.address, value: String(value) });

function pre() {
  return JSON.parse(fs.readFileSync(PRE, "utf8"));
}

/** Ordered steps. tx templates omit Fee/Sequence/LastLedgerSequence (autofilled at submit). */
function steps() {
  const s = pre();
  const w0 = s.accounts.W0;
  const amm = s.amm;
  const list = [];
  const add = (o) => list.push(o);
  for (const id of ["W0", "W1", "W2", "W3", "W4", "W5", "W6"]) {
    add({ id: `fund-${id}`, phase: 1, kind: "faucet", target: id, address: byId[id].address, note: "faucet same address; ~100 XRP/request" });
  }
  for (const k of A.KEYS.filter((k) => k.of)) {
    add({ id: `regkey-${k.of}`, phase: 2, kind: "tx", signer: `${k.of}_SEED`, tx: { TransactionType: "SetRegularKey", Account: byId[k.of].address, RegularKey: k.address } });
  }
  add({ id: "w0-defaultripple", phase: 3, kind: "tx", signer: "W0_SEED", tx: { TransactionType: "AccountSet", Account: byId.W0.address, SetFlag: 8 } });
  add({ id: "w0-domain", phase: 3, kind: "tx", signer: "W0_SEED", tx: { TransactionType: "AccountSet", Account: byId.W0.address, Domain: w0.account_root.Domain || hex("aether-foundry-desk.vercel.app") } });
  if (w0.account_flags && w0.account_flags.allowTrustLineLocking) {
    add({ id: "w0-trustline-locking", phase: 3, kind: "tx", signer: "W0_SEED", optional: true, note: "asfAllowTrustLineLocking (TokenEscrow); skip if amendment off after reset", tx: { TransactionType: "AccountSet", Account: byId.W0.address, SetFlag: 17 } });
  }
  const did = (w0.objects || []).find((o) => o.LedgerEntryType === "DID");
  if (did) add({ id: "w0-did", phase: 3, kind: "tx", signer: "W0_SEED", tx: { TransactionType: "DIDSet", Account: byId.W0.address, URI: did.URI } });
  const sl = (w0.signer_lists || [])[0];
  if (sl) add({ id: "w0-signerlist", phase: 3, kind: "tx", signer: "W0_SEED", tx: { TransactionType: "SignerListSet", Account: byId.W0.address, SignerQuorum: sl.SignerQuorum, SignerEntries: sl.SignerEntries.map((e) => ({ SignerEntry: { Account: e.Account, SignerWeight: e.SignerWeight } })) } });

  add({ id: "w1-trust-aeth", phase: 4, kind: "tx", signer: "W1_REGULAR_SEED", tx: { TransactionType: "TrustSet", Account: byId.W1.address, LimitAmount: AETH(1000000) } });
  add({ id: "w4-trust-aeth", phase: 4, kind: "tx", signer: "W4_REGULAR_SEED", tx: { TransactionType: "TrustSet", Account: byId.W4.address, LimitAmount: AETH(1000) } });
  add({ id: "w0-issue-w1", phase: 4, kind: "tx", signer: "W0_SEED", note: "4976.457… held + 4923.543… for the pool = 9900", tx: { TransactionType: "Payment", Account: byId.W0.address, Destination: byId.W1.address, Amount: AETH(9900) } });
  add({ id: "w0-issue-w4", phase: 4, kind: "tx", signer: "W0_SEED", tx: { TransactionType: "Payment", Account: byId.W0.address, Destination: byId.W4.address, Amount: AETH(50) } });
  if (amm && amm.amount) {
    add({ id: "w1-ammcreate", phase: 5, kind: "tx", signer: "W1_REGULAR_SEED", note: `recreates pre-reset depth/price; new AMM account; pre ${A.OLD_AMM}`, tx: { TransactionType: "AMMCreate", Account: byId.W1.address, Amount: amm.amount, Amount2: AETH(amm.amount2.value), TradingFee: amm.trading_fee } });
  }
  for (const id of ["W1", "W3", "W4"]) {
    add({ id: `${id.toLowerCase()}-trust-rlusd`, phase: 6, kind: "tx", conditional: "rlusd_issuer_exists", signer: `${id}_REGULAR_SEED`, tx: { TransactionType: "TrustSet", Account: byId[id].address, LimitAmount: { currency: A.RLUSD.currency, issuer: A.RLUSD.issuer, value: "10" }, Flags: 0x00020000 } });
  }
  add({ id: "w2-walk-in-remint", phase: 7, kind: "command", command: "npm run remint:walk-in", note: "W2 mints taxon 20260927 flags 8 fee 1000 URI INBOUND.md and lists a 10 XRP sell offer" });
  add({ id: "w5-oracle-aeth", phase: 7, kind: "command", command: "npm run frontier:oracle-set -- --live", note: "W5 regular key; doc 1 AETH/XRP from new pool price" });
  add({ id: "services", phase: 8, kind: "command", command: "bash /workspace/scratch/restart-foundry-services.sh" });
  add({ id: "post-snapshot", phase: 8, kind: "command", command: "node src/reset/snapshot.js --out lab/reset-2026-11-25/post-rebuild-snapshot.json" });
  add({ id: "anchors", phase: 9, kind: "command", command: "node src/reset/anchors.js --new-amm <r...>  (dry-run first, then --apply)" });
  return list;
}

function logged() {
  if (!fs.existsSync(LOG)) return {};
  const out = {};
  for (const l of fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(l); out[r.step] = r; } catch {}
  }
  return out;
}

async function rpcHttp(url, method, params = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(15000) });
  return (await r.json()).result;
}

/** Labs (primary, reachable from the box) decides. Ripple :51234 is informational: the box cannot reach non-443 ports today. */
async function detect() {
  const res = {};
  for (const [name, url] of [["labs", hosts.LABS_HTTP], ["ripple", hosts.ALTNET_HTTP]]) {
    try {
      const si = (await rpcHttp(url, "server_info")).info;
      const ai = await rpcHttp(url, "account_info", { account: byId.W0.address, ledger_index: "validated" });
      const seq = si.validated_ledger ? si.validated_ledger.seq : null;
      res[name] = { network_id: si.network_id, build: si.build_version, server_state: si.server_state, validated_seq: seq, complete_ledgers: si.complete_ledgers, w0: ai.error || "exists" };
    } catch (e) {
      res[name] = { error: e.cause ? e.cause.code || e.message : e.message };
    }
  }
  const fresh = (r) => Boolean(r && !r.error && r.network_id === 1 && r.validated_seq && r.validated_seq < RESET_MAX_LEDGER);
  res.labs_reset = fresh(res.labs);
  res.ripple_reset = res.ripple.error ? "unreachable" : fresh(res.ripple);
  res.reset_done = res.labs_reset || res.ripple_reset === true;
  res.ok_to_submit = res.labs_reset && res.labs.server_state === "full" && res.ripple_reset !== false;
  return res;
}

async function rlusdExists() {
  const client = await hosts.openClient(hosts.resolveWs(process.env));
  try { await client.request({ command: "account_info", account: A.RLUSD.issuer, ledger_index: "validated" }); return true; } catch { return false; } finally { await client.disconnect(); }
}

function seedFor(name) {
  const line = fs.readFileSync(SECRETS, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`missing ${name} in secrets file`);
  return line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "");
}

function append(row) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
}

async function live(stepId) {
  if (process.env.CI || process.env.GITHUB_ACTIONS) throw new Error("refusing live under CI");
  if (process.env.REBUILD_GO !== "2026-11-25") throw new Error("refusing live: REBUILD_GO=2026-11-25 not set (needs Hobie's go)");
  const step = steps().find((s) => s.id === stepId);
  if (!step) throw new Error(`unknown step ${stepId}`);
  if (step.kind === "command") throw new Error(`step ${stepId} is a command: ${step.command}`);
  const prior = logged()[stepId];
  if (prior && (prior.result === "tesSUCCESS" || prior.result === "funded")) { console.log(`already done: ${stepId} ${prior.hash || ""}`); return 0; }
  if (prior && prior.result === "submitted_unknown") throw new Error(`step ${stepId} has an unresolved attempt ${prior.hash}; check it by hash, do not resubmit`);
  const d = await detect();
  if (!d.ok_to_submit) throw new Error(`refusing: reset not confirmed on Labs ${JSON.stringify({ labs: d.labs.validated_seq || d.labs.error, ripple: d.ripple_reset })}`);
  if (step.kind === "faucet") {
    const r = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination: step.address }) });
    const body = await r.json().catch(() => ({}));
    const ok = r.ok && body && (body.account || body.amount);
    append({ step: stepId, result: ok ? "funded" : `faucet_http_${r.status}`, hash: body.transactionHash || body.hash || null, amount: body.amount || null });
    console.log(`${stepId} ${ok ? "funded" : "faucet failed " + r.status} ${body.amount || ""}`);
    return ok ? 0 : 1;
  }
  if (step.conditional === "rlusd_issuer_exists" && !(await rlusdExists())) { console.log(`skip ${stepId}: RLUSD issuer absent after reset`); append({ step: stepId, result: "skipped_no_issuer" }); return 0; }
  const xrpl = require("xrpl");
  const wallet = xrpl.Wallet.fromSeed(seedFor(step.signer));
  const client = await hosts.openClient(hosts.resolveWs(process.env), { networkId: 1 });
  let hash = null;
  try {
    const prepared = await client.autofill({ ...step.tx });
    if (Number(prepared.NetworkID || 1) !== 1 && prepared.NetworkID !== undefined) throw new Error("bad NetworkID");
    const signed = wallet.sign(prepared);
    hash = signed.hash;
    append({ step: stepId, result: "submitted_unknown", hash });
    const r = await client.submitAndWait(signed.tx_blob);
    const result = r.result.meta && r.result.meta.TransactionResult;
    append({ step: stepId, result, hash, ledger_index: r.result.ledger_index });
    console.log(`${stepId} ${result} ${hash}`);
    return result === "tesSUCCESS" ? 0 : 1;
  } finally {
    await client.disconnect();
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--detect")) { console.log(JSON.stringify(await detect(), null, 2)); return; }
  if (args.includes("--live")) { const i = args.indexOf("--step"); process.exitCode = await live(args[i + 1]); return; }
  const plan = { generated_at: new Date().toISOString(), from: path.relative(ROOT, PRE), unsigned: true, steps: steps() };
  fs.writeFileSync(path.join(DIR, "rebuild-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  for (const s of plan.steps) console.log(`${s.phase} ${s.id.padEnd(22)} ${s.kind === "tx" ? `${s.tx.TransactionType} as ${s.signer}` : s.kind === "faucet" ? `faucet ${s.address}` : s.command}${s.optional ? " (optional)" : ""}${s.conditional ? ` (if ${s.conditional})` : ""}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
