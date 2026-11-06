"use strict";

/**
 * One explicit purchase from a fresh isolated account. Wake cannot call
 * this. Startup cannot call this. A second call after a signature is refused.
 * The old claim is not released and the old candidate is not retried.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("node:child_process");
const { coded, readEvents } = require("./ledger");
const { view } = require("./engine");
const guard = require("./runtime-guard");
const policy = require("./policy");
const serviceResult = require("./service-result");
const { blockingClaim } = require("./sequence-hold");
const { requireDecision } = require("./new-account");
const { RETAINED_INVOICE } = require("./x402-deliver");
const { tick } = require("./worker");
const { readHistory, assertChain, openGeneration, generationUsed, seenInvoices, appendRecord } = require("./lease-chain");

const PHRASE = "EXECUTE-ONE-FRESH-PURCHASE";
const INVOICE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;

function purchaseKey(invoiceId) {
  const key = `buy-${crypto.createHash("sha256").update(invoiceId).digest("hex").slice(0, 24)}`;
  if (/cand-17|fee-retry/.test(key)) throw coded("refusing a renamed retry key", "NO_RETRY");
  return key;
}

function readLease(home) {
  const file = path.join(home, "execute.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function legacyUsed(home) {
  const lease = readLease(home);
  return Boolean(lease && Number(lease.ticks_used) >= 1);
}

function consumeGeneration(home, open, now, invoiceId) {
  const generation = open || appendRecord(home, {
    type: "lease.issued",
    lease_id: crypto.randomBytes(16).toString("hex"),
    issued_at: now,
    note: "initial one-shot",
    max_ticks: 1,
  });
  return appendRecord(home, {
    type: "lease.used",
    lease_id: generation.lease_id,
    used_at: now,
    ticks: 1,
    invoice_id: invoiceId,
  });
}

function challengeItem(doc, now) {
  if (!doc || doc.paid === true || doc.proof_sent === true || doc.http_status !== 402 || doc.x402Version !== 2) {
    throw coded("the purchase file is not an unpaid x402 version 2 challenge", "TX");
  }
  const resource = doc.resource_url_requested || doc.resource_url_in_body;
  if (doc.resource_url_exact_match !== true || !serviceResult.supportsResource(resource)) {
    throw coded("the purchase file is not the reviewed sanctions URL", "unsupported_delivery");
  }
  const row = doc.reviewed_row;
  if (!row || row.scheme !== "exact" || row.network !== "xrpl:1" || row.asset !== "XRP") {
    throw coded("the purchase file is not an exact xrpl:1 XRP accept", "MAINNET");
  }
  if (row.payTo !== "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs") {
    throw coded("the purchase file payTo is not the reviewed seller", "CLAIM");
  }
  const invoiceId = row.extra && row.extra.invoiceId;
  if (typeof invoiceId !== "string" || !INVOICE_RE.test(invoiceId)) throw coded("fresh invoice is missing", "TX");
  if (invoiceId === RETAINED_INVOICE) throw coded("the retained invoice is not a new purchase", "NO_RETRY");
  const retrieved = Date.parse(doc.retrieved_at);
  const timeout = Number(row.maxTimeoutSeconds);
  const age = Date.parse(now) - retrieved;
  if (!Number.isFinite(retrieved) || !Number.isInteger(timeout) || timeout < 1 || timeout > 600 || !Number.isFinite(age) || age < 0 || age > timeout * 1000) {
    throw coded("the challenge is outside its freshness window", "stale_challenge");
  }
  const key = purchaseKey(invoiceId);
  return {
    key,
    invoiceId,
    item: {
      id: key,
      kind: "foreign-xrpl1-purchase",
      observed_at: new Date(retrieved).toISOString(),
      resource: { url: resource, method: "GET" },
      x402: {
        x402Version: 2,
        resource,
        accepts: [row],
      },
    },
  };
}

function assertExecuteAuth(env) {
  guard.assertNoHouseSeeds(env);
  if (env.FOUNDRY_MISSION_EXECUTE_PHRASE === "WAKE-MISSION-CONTROL") {
    throw coded("wake is not a purchase", "AUTH");
  }
  if (env.override === "yes") throw coded("operator override does not release a signed claim", "NO_RETRY");
  const token = env.FOUNDRY_MISSION_EXECUTE_TOKEN;
  if (typeof token !== "string" || token.length < 32) throw coded("execute token is missing", "AUTH");
  if (env.FOUNDRY_MISSION_EXECUTE_PHRASE !== PHRASE) throw coded("execute phrase is missing", "AUTH");
}

async function signerReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function startSigner(env, home, ledger) {
  const port = guard.assertFreePort(env.FOUNDRY_MISSION_SIGNER_PORT, 8788);
  const child = spawn(process.execPath, [path.join("src", "missions", "signer.js")], {
    cwd: process.cwd(),
    env: Object.assign({}, env, {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_ACCOUNT_FILE: path.join(home, "account.json"),
      CI: "",
      GITHUB_ACTIONS: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, port };
}

async function executeOnce(env, opts) {
  const options = opts || {};
  const source = env || {};
  const now = options.now || new Date().toISOString();
  assertExecuteAuth(source);
  const home = guard.assertIsolated(source.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime");
  const ledger = guard.assertIsolated(source.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger"));
  const history = readHistory(home);
  assertChain(history);
  const open = openGeneration(history);
  if (!open && (legacyUsed(home) || generationUsed(history))) {
    throw coded("the one-shot purchase was already used", "NO_RETRY");
  }
  const held = blockingClaim(view(ledger, now), null);
  if (!held) throw coded("no unresolved claim is on file", "CLAIM");
  requireDecision(ledger, held.mission_id);
  const address = source.MISSION_XRPL_ADDRESS;
  if (!address || policy.isHouse(address)) throw coded("the new account is missing or is a house wallet", "W0");
  if (!held.account || held.account === address) {
    const error = coded("the new purchase must use a different isolated account", "SEQUENCE_HELD");
    error.hold = held;
    throw error;
  }
  const discoveryFile = path.join(home, "discovery.json");
  const discoveryBefore = fs.existsSync(discoveryFile) ? fs.readFileSync(discoveryFile) : null;
  const file = source.FOUNDRY_MISSION_CHALLENGE_FILE;
  if (!file) throw coded("fresh challenge file is missing", "TX");
  const challenge = challengeItem(JSON.parse(fs.readFileSync(file, "utf8")), now);
  const usedInvoice = readEvents(ledger).some((event) => event && event.type === "mission.upsert" && event.mission && event.mission.invoice_id === challenge.invoiceId);
  if (usedInvoice || seenInvoices(history).has(challenge.invoiceId)) throw coded("this invoice was already used", "NO_RETRY");
  let signer = null;
  const port = guard.assertFreePort(source.FOUNDRY_MISSION_SIGNER_PORT, 8788);
  if (options.spawnSigner !== false && !(await signerReady(port)) && fs.existsSync(path.join(home, "account.json"))) {
    signer = startSigner(source, home, ledger);
    const started = Date.now();
    while (!(await signerReady(port))) {
      if (Date.now() - started > 5000) throw coded("dedicated signer did not listen", "SIGNER");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    const result = await tick({
      env: Object.assign({}, source, {
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_WORKER: "yes",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: address,
      }),
      now,
      oneShotItems: [challenge.item],
      priorClaimId: held.mission_id,
      requireNewAccount: true,
      fetch: options.fetch,
      resourceFetch: options.fetch,
    });
    const signed = result.signed === true || result.complete === true || result.reason === "delivery_failed" || result.reason === "persistence_missing";
    if (signed) consumeGeneration(home, open, now, challenge.invoiceId);
    if (discoveryBefore) {
      const after = fs.existsSync(discoveryFile) ? fs.readFileSync(discoveryFile) : Buffer.from("");
      if (!after.equals(discoveryBefore)) throw coded("discovery was rewritten", "NO_RETRY");
    }
    return Object.assign({}, result, {
      purchase_key: challenge.key,
      prior_claim_id: held.mission_id,
      invoice_id: challenge.invoiceId,
      execute_lease_used: signed,
    });
  } finally {
    if (signer) signer.child.kill("SIGTERM");
  }
}

if (require.main === module) {
  executeOnce(process.env, { fetch: globalThis.fetch })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({
        reason: result.reason || null,
        code: result.code || null,
        complete: result.complete === true,
        signed: result.signed === true,
        submitted: result.submitted === true,
        mission_id: result.mission_id || null,
        prior_claim_id: result.prior_claim_id,
        purchase_key: result.purchase_key,
        execute_lease_used: result.execute_lease_used === true,
      })}\n`);
      if (result.complete !== true && result.signed !== true && result.reason !== "delivery_failed") process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "AUTH"}\n`);
      process.exit(1);
    });
}

module.exports = {
  PHRASE,
  purchaseKey,
  challengeItem,
  executeOnce,
};
