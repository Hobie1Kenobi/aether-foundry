"use strict";

/**
 * One opt-in Testnet payment against the loopback seller.
 * Budget, uncertainty, and settlement use the existing mission ledger.
 * The sanctions lease file is not read or written. The worker is not started.
 * Without FOUNDRY_DIAGNOSTIC_LIVE=yes this command only reports the cap.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const { ExactXrplScheme } = require("@x402/xrpl/exact/facilitator");
const config = require("../missions/config");
const { coded } = require("../missions/ledger");
const { view, startMission, act, observe } = require("../missions/engine");
const { applyChallenge, stampPrepared, beginSubmit, notePresign, finishSubmit } = require("../missions/submit");
const { invoiceIdField } = require("../missions/x402-deliver");
const policy = require("../missions/policy");
const { chicagoDay } = require("../missions/clock");
const guard = require("../missions/runtime-guard");
const { canonicalReconcileRpc, boundReconcileFetch } = require("../missions/reconcile-endpoint");
const { buildSignaturePayload } = require("../x402-outbound-guard");
const { SANCTIONS_PAYEE } = require("./controlled-seller");

const PHRASE = "DIAGNOSTIC-ONE-XRPL1-PAYMENT";
const PERMANENT_HOLD = "msn5b5c3223e5e88526";
const LEGACY_DROPS = 1747n;
const ATTEMPT_FILE = "diagnostic-attempt.jsonl";

function assertPublic(report) {
  const text = JSON.stringify(report);
  if (/sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text) || text.includes("signedTxBlob") || text.includes("PAYMENT-SIGNATURE")) {
    throw coded("diagnostic report contains a signed blob or secret", "REDACT");
  }
  return report;
}

function canonical(record) {
  const copy = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "hash") continue;
    copy[key] = record[key];
  }
  return JSON.stringify(copy);
}

function readAttempts(home) {
  const file = path.join(home, ATTEMPT_FILE);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function appendAttempt(home, fields) {
  const records = readAttempts(home);
  let prev = "";
  for (const record of records) {
    const hash = crypto.createHash("sha256").update(canonical(record)).digest("hex");
    if (record.hash !== hash || record.prev_hash !== prev) throw coded("diagnostic attempt chain is broken", "TAMPER");
    prev = record.hash;
  }
  const record = Object.assign({}, fields, { prev_hash: prev });
  record.hash = crypto.createHash("sha256").update(canonical(record)).digest("hex");
  const fd = fs.openSync(path.join(home, ATTEMPT_FILE), "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

function attemptUsed(home) {
  return readAttempts(home).some((row) => row && row.type === "attempt.used");
}

function workerAsleep(home) {
  const file = path.join(home, "worker.json");
  if (!fs.existsSync(file)) return false;
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  return Boolean(body && body.asleep === true);
}

function legacyUncertain(state) {
  let uncertain = 0n;
  for (const bucket of Object.values(state.days || {})) uncertain += BigInt((bucket && bucket.uncertain) || "0");
  return uncertain;
}

function heldAccount(mission) {
  if (!mission) return null;
  if (mission.account) return mission.account;
  if (mission.unsigned_tx && mission.unsigned_tx.Account) return mission.unsigned_tx.Account;
  if (mission.claim && mission.claim.account) return mission.claim.account;
  return null;
}

function unreconciled(mission) {
  if (!mission || mission.id === PERMANENT_HOLD) return false;
  if (mission.complete === true || mission.hold === "released" || mission.hold === "spent") return false;
  return Boolean(mission.presigned_hash || mission.signed === true || mission.submitted === true || mission.submit_state || mission.signer_accepted === true || mission.hold === "uncertain");
}

function sellerUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    throw coded("controlled seller URL is missing", "HOST");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.hash) throw coded("controlled seller URL is not allowed", "HOST");
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") throw coded("controlled seller must be loopback", "HOST");
  if (host === "api.stablecoingateways.com" || String(raw).includes("stablecoingateways")) {
    throw coded("refusing the existing seller", "HOST");
  }
  if (url.pathname !== "/paid") throw coded("controlled seller path is not allowed", "HOST");
  return url;
}

function preflight(env, now) {
  guard.assertNoHouseSeeds(env || {});
  if (!env || env.FOUNDRY_MISSION_EXECUTE === "yes") throw coded("the mission execute flag is not this command", "AUTH");
  if (env.FOUNDRY_DIAGNOSTIC_PHRASE !== PHRASE) throw coded("diagnostic phrase is missing", "AUTH");
  const token = env.FOUNDRY_DIAGNOSTIC_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("diagnostic token is missing", "AUTH");
  if (token === env.FOUNDRY_MISSION_EXECUTE_TOKEN || token === env.FOUNDRY_MISSION_AUTHORIZE_TOKEN) {
    throw coded("diagnostic token must be distinct", "AUTH");
  }
  const home = guard.assertIsolated(env.FOUNDRY_MISSION_HOME);
  const ledger = guard.assertIsolated(env.FOUNDRY_MISSION_LEDGER);
  if (!workerAsleep(home)) throw coded("the worker is not asleep", "ASLEEP");
  const state = view(ledger, now);
  if (!state.spending_enabled) throw coded("spending is not activated", "SPENDING_DISABLED");
  const legacy = state.missions[PERMANENT_HOLD];
  if (!legacy || legacy.hold === "released" || legacy.hold === "spent") throw coded("legacy hold is not counting", "CAP");
  if (legacyUncertain(state) < LEGACY_DROPS) throw coded("legacy 1747 drops are not in the day accounting", "CAP");
  const blocking = Object.values(state.missions).find(unreconciled);
  if (blocking) throw coded("a signed claim is still unreconciled", "NO_RETRY");
  if (attemptUsed(home)) throw coded("the diagnostic attempt was already used", "NO_RETRY");
  const seller = sellerUrl(env.FOUNDRY_DIAGNOSTIC_SELLER);
  const payment = BigInt(env.FOUNDRY_DIAGNOSTIC_PAYMENT_DROPS || "10");
  const fee = BigInt(env.FOUNDRY_DIAGNOSTIC_FEE_DROPS || "10");
  if (payment <= 0n || fee <= 0n || fee > 10000n || payment + fee > config.PER_MISSION_DROPS) {
    throw coded("payment exceeds the mission cap", "CAP");
  }
  const used = policy.dayUsed(state, chicagoDay(now));
  if (used + payment + fee > config.DAILY_DROPS) throw coded("Chicago-day cap would be exceeded", "CAP");
  return {
    home,
    ledger,
    seller: seller.toString(),
    payment: payment.toString(),
    fee: fee.toString(),
    budget: (payment + fee).toString(),
    used: used.toString(),
    legacy,
    live: env.FOUNDRY_DIAGNOSTIC_LIVE === "yes",
  };
}

function officialScheme() {
  return { hook_source: "official_default", scheme: new ExactXrplScheme({}) };
}

function loadWallet(env, override) {
  if (override) return override;
  const file = env.FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE;
  if (!file) throw coded("diagnostic account file is missing", "AUTH");
  const resolved = path.resolve(file);
  if (resolved.startsWith("/workspace/aether-foundry/")) throw coded("refusing an account file inside the checkout", "ISOLATED");
  const body = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const wallet = xrpl.Wallet.fromSeed(body.seed);
  if (wallet.address !== body.address) throw coded("diagnostic account file does not match", "AUTH");
  return wallet;
}

async function readChallenge(url, payment, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { accept: "application/json", "user-agent": "aether-foundry-missions" },
  });
  if (!response || response.status !== 402 || response.redirected === true) throw coded("controlled seller did not return a challenge", "TX");
  const encoded = typeof response.headers.get === "function" ? response.headers.get("payment-required") : null;
  const parsed = JSON.parse(Buffer.from(String(encoded || ""), "base64").toString("utf8"));
  const accept = parsed && Array.isArray(parsed.accepts) ? parsed.accepts[0] : null;
  if (!accept || accept.scheme !== "exact" || accept.network !== "xrpl:1" || accept.asset !== "XRP") {
    throw coded("controlled challenge is not exact xrpl:1 XRP", "MAINNET");
  }
  if (accept.payTo === SANCTIONS_PAYEE) throw coded("refusing the sanctions payee", "CLAIM");
  if (accept.amount !== payment) throw coded("controlled challenge amount does not match the authorized payment", "CAP");
  if (!accept.extra || accept.extra.areFeesSponsored !== false) {
    throw coded("live attempt requires the issued challenge to already say areFeesSponsored false", "TX");
  }
  return accept;
}

async function proveSettlement(hash, expected, fetchImpl) {
  const endpoint = canonicalReconcileRpc(undefined);
  const bounded = boundReconcileFetch(fetchImpl);
  const response = await bounded(endpoint, {
    method: "POST",
    body: JSON.stringify({ method: "tx", params: [{ transaction: hash }] }),
  });
  const body = await response.json();
  const result = body && (body.result || body);
  if (!result || result.validated !== true || result.error) return { validated: false, reason: "not_validated" };
  const tx = result.tx_json || result;
  const meta = result.meta || {};
  if (String(result.hash || tx.hash || "").toUpperCase() !== hash) return { validated: false, reason: "hash_mismatch" };
  if (meta.TransactionResult !== "tesSUCCESS") return { validated: false, reason: "not_success" };
  if (tx.Destination !== expected.destination || String(tx.Amount) !== expected.amount) return { validated: false, reason: "payment_mismatch" };
  return { validated: true, reason: null };
}

function park(ledger, missionId, now) {
  const mission = view(ledger, now).missions[missionId];
  if (!mission || mission.hold !== "unsubmitted") return;
  observe(ledger, { mission_id: missionId, now, observe_key: `diag-park-${missionId}`, report: {} });
}

async function runControlledPurchase(env, opts) {
  const options = opts || {};
  const now = options.now || new Date().toISOString();
  const plan = preflight(env, now);
  if (!plan.live) {
    return assertPublic({
      live: false,
      signed: false,
      submitted: false,
      settled: false,
      official_verify: "not_run",
      official_settle: "not_run",
      daily_used: plan.used,
      budget_drops: plan.budget,
      legacy_hold: PERMANENT_HOLD,
    });
  }
  const wallet = loadWallet(env, options.wallet);
  if (policy.isHouse(wallet.address) || wallet.address === heldAccount(plan.legacy)) {
    throw coded("the diagnostic account is a house wallet or the held mission account", "W0");
  }
  const attempt = crypto.randomBytes(16).toString("hex");
  appendAttempt(plan.home, { type: "attempt.used", attempt, used_at: now, max_ticks: 1 });
  let missionId = null;
  try {
    const fetchImpl = options.fetch || globalThis.fetch;
    const accept = await readChallenge(`${plan.seller}?shape=official`, plan.payment, fetchImpl);
    const validated = options.validatedLedger;
    const sequence = options.sequence;
    if (!Number.isSafeInteger(validated) || !Number.isSafeInteger(sequence)) {
      throw coded("validated ledger facts are missing", "LEDGER");
    }
    const opened = startMission(plan.ledger, {
      idempotency_key: `diag-${attempt.slice(0, 24)}`,
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: accept.payTo }] },
      payment_drops: plan.payment,
      network_fee_drops: plan.fee,
      resource_url: plan.seller,
    }, { allowlist: { payees: [accept.payTo] } });
    if (!opened.mission || opened.mission.status === "blocked") throw coded("diagnostic mission was not reserved", "CAP");
    missionId = opened.mission.id;
    if (options.afterReserve) await options.afterReserve(missionId);
    act(plan.ledger, { mission_id: missionId, now }, { wallet: { address: wallet.address } });
    applyChallenge(plan.ledger, {
      mission_id: missionId,
      now,
      sourceTag: accept.extra.sourceTag,
      invoiceId: accept.extra.invoiceId,
      invoiceIdField: invoiceIdField(accept.extra.invoiceId),
    });
    stampPrepared(plan.ledger, { mission_id: missionId, now, sequence, lastLedgerSequence: validated + 20 });
    const begun = beginSubmit(plan.ledger, { mission_id: missionId, now });
    if (!begun.proceed) throw coded("diagnostic submit did not open", "NO_RETRY");
    if (options.beforeSign) await options.beforeSign(missionId);
    const selected = options.scheme || officialScheme();
    if (!selected || selected.hook_source !== "official_default" || !selected.scheme || typeof selected.scheme.settle !== "function") {
      throw coded("injected verifier cannot settle", "VERIFY");
    }
    const signed = wallet.sign(begun.tx);
    const hash = xrpl.hashes.hashSignedTx(signed.tx_blob).toUpperCase();
    notePresign(plan.ledger, missionId, hash, { tx: begun.tx });
    const payload = buildSignaturePayload({ required: { resource: { url: plan.seller } }, accept, txBlob: signed.tx_blob });
    const settled = await selected.scheme.settle(payload, accept);
    const settledHash = String(settled && settled.transaction || "").toUpperCase();
    const proof = settled && settled.success === true && settledHash === hash
      ? await proveSettlement(hash, { destination: accept.payTo, amount: plan.payment }, options.proofFetch || fetchImpl)
      : { validated: false, reason: "facilitator_not_proven" };
    if (!proof.validated) {
      return assertPublic({
        live: true,
        signed: true,
        submitted: false,
        settled: false,
        official_settle: "not_proven",
        reason: proof.reason,
        mission_id: missionId,
        legacy_hold: PERMANENT_HOLD,
      });
    }
    finishSubmit(plan.ledger, {
      mission_id: missionId,
      now,
      delivery: { mode: "shop-settle", http_status: 200, hash, result: { source: "ledger_tx" } },
      result: { hash, engine_result: "tesSUCCESS", network_id: 1, submitted: true },
    });
    return assertPublic({
      live: true,
      signed: true,
      submitted: true,
      settled: true,
      official_settle: options.scheme ? "supplied_scheme" : "exact_xrpl_scheme",
      ledger_proof: "validated",
      mission_id: missionId,
      legacy_hold: PERMANENT_HOLD,
    });
  } catch (error) {
    if (missionId) park(plan.ledger, missionId, now);
    throw error;
  }
}

if (require.main === module) {
  runControlledPurchase(process.env).then((result) => {
    process.stdout.write(`${JSON.stringify(assertPublic(result))}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || "DIAGNOSTIC"}\n`);
    process.exit(1);
  });
}

module.exports = {
  PHRASE,
  PERMANENT_HOLD,
  officialScheme,
  preflight,
  runControlledPurchase,
};
