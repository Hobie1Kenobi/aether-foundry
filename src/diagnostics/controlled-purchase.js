"use strict";

/**
 * One opt-in Testnet payment against the loopback seller.
 * Preview only reads the shared mission ledger. The attempt lock is taken
 * after the challenge, the funded accounts, and the validated ledger are known.
 * The seller verifies and settles. This command then requires a matching
 * validated tx lookup before it marks the budget spent.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const { ExactXrplScheme } = require("@x402/xrpl/exact/facilitator");
const config = require("../missions/config");
const { coded, readEvents } = require("../missions/ledger");
const { view, startMission, act, observe } = require("../missions/engine");
const { applyChallenge, stampPrepared, beginSubmit, notePresign, finishSubmit } = require("../missions/submit");
const { invoiceIdField } = require("../missions/x402-deliver");
const policy = require("../missions/policy");
const { chicagoDay } = require("../missions/clock");
const guard = require("../missions/runtime-guard");
const { canonicalReconcileRpc, boundReconcileFetch } = require("../missions/reconcile-endpoint");
const { buildSignaturePayload } = require("../x402-outbound-guard");
const { SANCTIONS_PAYEE, BLOCKED_PORTS } = require("./controlled-seller");
const { inspectAccount, readHandover } = require("./account-file");

const PHRASE = "DIAGNOSTIC-ONE-XRPL1-PAYMENT";
const PERMANENT_HOLD = "msn5b5c3223e5e88526";
const LEGACY_DROPS = 1747n;
const ATTEMPT_FILE = "diagnostic-attempt.jsonl";
const LOCK_DIR = "diagnostic-attempt.lock";

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

function attemptPath(home) {
  return path.join(home, ATTEMPT_FILE);
}

function readAttempts(home) {
  const file = attemptPath(home);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (!text) return [];
  if (!text.endsWith("\n")) throw coded("diagnostic attempt file is ambiguous", "NO_RETRY");
  let prev = "";
  const records = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw coded("diagnostic attempt file is ambiguous", "NO_RETRY");
    }
    const hash = crypto.createHash("sha256").update(canonical(record)).digest("hex");
    if (!record || record.hash !== hash || record.prev_hash !== prev) {
      throw coded("diagnostic attempt file is ambiguous", "NO_RETRY");
    }
    prev = record.hash;
    records.push(record);
  }
  return records;
}

function appendAttempt(home, fields) {
  const records = readAttempts(home);
  const prev = records.length ? records[records.length - 1].hash : "";
  const record = Object.assign({}, fields, { prev_hash: prev });
  record.hash = crypto.createHash("sha256").update(canonical(record)).digest("hex");
  const fd = fs.openSync(attemptPath(home), "a");
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

function consumeAttempt(home, now) {
  const lock = path.join(home, LOCK_DIR);
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error && error.code === "EEXIST") throw coded("diagnostic attempt lock is held", "NO_RETRY");
    throw error;
  }
  if (attemptUsed(home)) throw coded("the diagnostic attempt was already used", "NO_RETRY");
  return appendAttempt(home, {
    type: "attempt.used",
    attempt: crypto.randomBytes(16).toString("hex"),
    used_at: now,
    max_ticks: 1,
  });
}

function workerAsleep(home) {
  const file = path.join(home, "worker.json");
  if (!fs.existsSync(file)) return false;
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  return Boolean(body && body.asleep === true);
}

function retainedLegacyDrops(dir) {
  let net = 0n;
  for (const event of readEvents(dir)) {
    if (!event || event.mission_id !== PERMANENT_HOLD || event.counted === false) continue;
    const drops = BigInt(event.drops || "0");
    if (event.type === "budget.uncertain") net += drops;
    if (event.type === "budget.settled" && (event.from == null || event.from === "uncertain")) net -= drops;
    if (event.type === "budget.unsigned_released" || event.type === "budget.ledger_expired") net -= drops;
  }
  return net;
}

function missionAccounts(state) {
  const found = new Set();
  for (const mission of Object.values((state && state.missions) || {})) {
    const values = [
      mission.account,
      mission.unsigned_tx && mission.unsigned_tx.Account,
      mission.claim && mission.claim.account,
      mission.signed_fields && mission.signed_fields.Account,
    ];
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) found.add(value);
    }
  }
  return found;
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
  if (String(raw).includes("stablecoingateways")) throw coded("refusing the existing seller", "HOST");
  if (url.pathname !== "/paid") throw coded("controlled seller path is not allowed", "HOST");
  if (!url.port || BLOCKED_PORTS.has(Number(url.port))) throw coded("refusing a port owned by an existing service", "BIND");
  return url;
}

function assertAccounts(buyer, seller, state) {
  const reserved = missionAccounts(state);
  if (!seller || policy.isHouse(seller)) throw coded("refusing a house wallet", "W0");
  if (seller === SANCTIONS_PAYEE) throw coded("refusing the sanctions payee", "CLAIM");
  if (reserved.has(seller)) throw coded("refusing a current or legacy mission account", "ACCOUNT");
  if (buyer == null) return;
  if (policy.isHouse(buyer)) throw coded("refusing a house wallet", "W0");
  if (buyer === seller || reserved.has(buyer)) throw coded("refusing a current or legacy mission account", "ACCOUNT");
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
  const retained = retainedLegacyDrops(ledger);
  if (!legacy || legacy.hold === "released" || legacy.hold === "spent" || retained < LEGACY_DROPS) {
    throw coded("legacy hold msn5b5c3223e5e88526 is not counting 1747 drops", "CAP");
  }
  const blocking = Object.values(state.missions).find(unreconciled);
  if (blocking) throw coded("a signed claim is still unreconciled", "NO_RETRY");
  if (fs.existsSync(path.join(home, LOCK_DIR)) || attemptUsed(home)) throw coded("the diagnostic attempt was already used", "NO_RETRY");
  const seller = sellerUrl(env.FOUNDRY_DIAGNOSTIC_SELLER);
  const payee = env.FOUNDRY_DIAGNOSTIC_PAYEE;
  if (typeof payee !== "string" || payee.length === 0) throw coded("authorized seller address is missing", "PAYEE");
  assertAccounts(null, payee, state);
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
    state,
    seller: seller.toString(),
    payee,
    payment: payment.toString(),
    fee: fee.toString(),
    budget: (payment + fee).toString(),
    used: used.toString(),
    day: chicagoDay(now),
    legacy,
    retained: retained.toString(),
    live: env.FOUNDRY_DIAGNOSTIC_LIVE === "yes",
  };
}

function officialScheme() {
  return { hook_source: "official_default", scheme: new ExactXrplScheme({}) };
}

function ledgerEndpoint(env) {
  return canonicalReconcileRpc(env && env.FOUNDRY_MISSION_RECONCILE_RPC);
}

async function rpc(endpoint, method, params, fetchImpl) {
  const bounded = boundReconcileFetch(fetchImpl);
  const response = await bounded(endpoint, {
    method: "POST",
    body: JSON.stringify({ method, params: [params] }),
  });
  const body = await response.json();
  return body && (body.result || body);
}

async function readChallenge(url, payment, payee, shape, fetchImpl) {
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
  if (accept.payTo !== payee) throw coded("challenge payee does not match the authorized seller", "CLAIM");
  if (accept.amount !== payment) throw coded("controlled challenge amount does not match the authorized payment", "CAP");
  const present = accept.extra && Object.prototype.hasOwnProperty.call(accept.extra, "areFeesSponsored");
  if (shape === "vendor" && present) throw coded("vendor challenge is not the missing-flag shape", "TX");
  if (shape === "official" && (!accept.extra || accept.extra.areFeesSponsored !== false)) {
    throw coded("official challenge does not already say areFeesSponsored false", "TX");
  }
  return accept;
}

async function readFacts(endpoint, buyer, seller, payment, fee, fetchImpl) {
  const info = await rpc(endpoint, "server_info", {}, fetchImpl);
  const validated = info && info.info && info.info.validated_ledger && info.info.validated_ledger.seq;
  if (info && info.info && info.info.network_id !== 1) throw coded("refusing a ledger that is not xrpl:1", "MAINNET");
  if (!Number.isInteger(validated) || validated <= 0) throw coded("validated ledger is missing", "LEDGER");
  const buyerInfo = await rpc(endpoint, "account_info", { account: buyer, ledger_index: "validated" }, fetchImpl);
  const sellerInfo = await rpc(endpoint, "account_info", { account: seller, ledger_index: "validated" }, fetchImpl);
  const funded = (row, who) => {
    if (!row || row.error === "actNotFound") throw coded(`${who} account is not funded`, "UNFUNDED");
    const data = row.account_data;
    if (!row.validated || !data || data.Account !== (who === "buyer" ? buyer : seller)) throw coded("validated account is missing", "LEDGER");
    return data;
  };
  const buyerData = funded(buyerInfo, "buyer");
  funded(sellerInfo, "seller");
  if (!Number.isInteger(buyerData.Sequence) || buyerData.Sequence <= 0) throw coded("validated account sequence is missing", "LEDGER");
  if (BigInt(buyerData.Balance) < BigInt(payment) + BigInt(fee)) throw coded("buyer balance cannot cover the payment and fee", "UNFUNDED");
  return { validated, sequence: buyerData.Sequence };
}

async function proveSettlement(hash, expected, fetchImpl, endpoint) {
  const result = await rpc(endpoint, "tx", { transaction: hash }, fetchImpl);
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
      attempt_consumed: false,
      vendor_signed: false,
      official_verify: "not_run",
      official_settle: "not_run",
      daily_used: plan.used,
      day: plan.day,
      budget_drops: plan.budget,
      legacy_hold: PERMANENT_HOLD,
      legacy_drops: plan.retained,
    });
  }
  const wallet = options.wallet || inspectAccount(env.FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE).wallet;
  const handover = readHandover(env.FOUNDRY_DIAGNOSTIC_HANDOVER);
  if (handover.buyer !== wallet.address || handover.seller !== plan.payee) {
    throw coded("handover addresses do not match the account and the authorized seller", "AUTH");
  }
  assertAccounts(wallet.address, plan.payee, plan.state);
  const fetchImpl = options.fetch || globalThis.fetch;
  const endpoint = ledgerEndpoint(env);
  await readChallenge(`${plan.seller}?shape=vendor`, plan.payment, plan.payee, "vendor", fetchImpl);
  const accept = await readChallenge(`${plan.seller}?shape=official`, plan.payment, plan.payee, "official", fetchImpl);
  const facts = await readFacts(endpoint, wallet.address, plan.payee, plan.payment, plan.fee, options.ledgerFetch || fetchImpl);
  const consumed = consumeAttempt(plan.home, now);
  let missionId = null;
  try {
    const opened = startMission(plan.ledger, {
      idempotency_key: `diag-${consumed.attempt.slice(0, 24)}`,
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: plan.payee }] },
      payment_drops: plan.payment,
      network_fee_drops: plan.fee,
      resource_url: plan.seller,
    }, { allowlist: { payees: [plan.payee] } });
    if (!opened.mission || opened.mission.status === "blocked" || opened.mission.seller !== plan.payee) {
      throw coded("diagnostic mission was not reserved for the authorized seller", "CAP");
    }
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
    stampPrepared(plan.ledger, { mission_id: missionId, now, sequence: facts.sequence, lastLedgerSequence: facts.validated + 20 });
    const begun = beginSubmit(plan.ledger, { mission_id: missionId, now });
    if (!begun.proceed) throw coded("diagnostic submit did not open", "NO_RETRY");
    if (options.beforeSign) await options.beforeSign(missionId);
    const signed = wallet.sign(begun.tx);
    const hash = xrpl.hashes.hashSignedTx(signed.tx_blob).toUpperCase();
    notePresign(plan.ledger, missionId, hash, { tx: begun.tx });
    const payload = buildSignaturePayload({ required: { resource: { url: plan.seller } }, accept, txBlob: signed.tx_blob });
    const posted = await fetchImpl(plan.seller, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64"),
        "user-agent": "aether-foundry-missions",
      },
      body: "{}",
    });
    const receipt = posted && typeof posted.json === "function" ? await posted.json() : {};
    const receiptHash = String(receipt && receipt.transaction || "").toUpperCase();
    const sellerPaid = posted && posted.status === 200 && receipt && receipt.paid === true && receiptHash === hash;
    const proof = sellerPaid
      ? await proveSettlement(hash, { destination: plan.payee, amount: plan.payment }, options.proofFetch || fetchImpl, endpoint)
      : { validated: false, reason: "seller_not_paid" };
    if (!proof.validated) {
      return assertPublic({
        live: true,
        signed: true,
        submitted: false,
        settled: false,
        attempt_consumed: true,
        vendor_signed: false,
        official_settle: "not_proven",
        reason: proof.reason,
        mission_id: missionId,
        legacy_hold: PERMANENT_HOLD,
        legacy_drops: plan.retained,
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
      network_boundary: "testnet",
      attempt_consumed: true,
      vendor_signed: false,
      official_settle: receipt.official_settle || "exact_xrpl_scheme",
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
  consumeAttempt,
  assertAccounts,
  proveSettlement,
  retainedLegacyDrops,
  ledgerEndpoint,
  runControlledPurchase,
};
