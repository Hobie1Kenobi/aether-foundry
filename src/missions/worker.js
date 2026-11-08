#!/usr/bin/env node
"use strict";

/**
 * Bounded mission worker. It stays asleep until FOUNDRY_MISSION_WORKER=yes
 * and the ledger class is activated. Discovery comes from a parent file.
 * This process does not invent sellers, amounts, or payments.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const config = require("./config");
const { coded, readEvents } = require("./ledger");
const { fold, startMission, blockMission, act, evaluate, view } = require("./engine");
const { beginSubmit, finishSubmit, releasePrepared, releaseUnsignedClaim, narrowUnsubmittedFee, noteDeliveryFailure, applyChallenge, stampPrepared, releasePassedWindow } = require("./submit");
const networkFee = require("./network-fee");
const ledgerWindow = require("./ledger-window");
const serviceResult = require("./service-result");
const x402Deliver = require("./x402-deliver");
const missionPolicy = require("./policy");
const guard = require("./runtime-guard");
const { uploadSnapshot } = require("./github-publish");
const { uploadIngest } = require("./desk-publish");
const { blockingClaim } = require("./sequence-hold");
const { linkPriorClaim, requireDecision } = require("./new-account");
const wake = require("./wake");
const { check: checkArm } = require("./arm");

const DEFAULT_PORT = 8794;
const STATE_NAME = "worker-state.json";

function scheduleOpen(env, fileConfig, opts) {
  if (opts && Array.isArray(opts.oneShotItems)) {
    return Boolean(env && env.FOUNDRY_MISSION_EXECUTE === "yes");
  }
  if (!env || env.FOUNDRY_MISSION_WORKER !== "yes") return false;
  if (fileConfig && fileConfig.asleep === true) return false;
  return true;
}

function classOpen(events) {
  const state = fold(events.filter((event) => event && event.type));
  return state.spending_enabled === true && !state.killed && state.classes.includes(config.AUTONOMOUS_CLASS);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeState(ledger, patch) {
  const dir = guard.assertIsolated(ledger);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STATE_NAME);
  const prior = readJson(file) || { schema: "aether.missions.worker-state", consumed: {}, ticks: 0 };
  const next = Object.assign({}, prior, patch, {
    schema: "aether.missions.worker-state",
    consumed: Object.assign({}, prior.consumed, patch.consumed || {}),
    ticks: Number(prior.ticks || 0) + 1,
  });
  const tmp = `${file}.partial`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify(next)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return next;
}

function loadDiscovery(file) {
  if (!file || !fs.existsSync(file)) return { items: [], reason: "no_discovery" };
  const text = fs.readFileSync(file, "utf8");
  if (/sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text)) throw coded("discovery file contains a seed", "SEED");
  const body = JSON.parse(text);
  if (!body || body.schema !== "aether.missions.discovery") throw coded("discovery schema mismatch", "DISCOVERY");
  if (body.network !== config.NETWORK || Number(body.network_id) !== config.NETWORK_ID) {
    throw coded("discovery is not xrpl:1", "MAINNET");
  }
  if (body.generated === true) throw coded("refusing a generated discovery file", "DISCOVERY");
  if (!Array.isArray(body.items)) throw coded("discovery items are missing", "DISCOVERY");
  return { items: body.items, reason: body.items.length ? null : "no_discovery" };
}

const SERVICE_KEYS = new Set(["seller", "asset", "price_drops", "network", "network_id"]);

function candidateKey(item, seller, amount) {
  if (item && /^[a-z0-9][a-z0-9-]{7,63}$/.test(String(item.id || ""))) return String(item.id);
  const raw = `${seller || ""}|${amount || ""}|${item && (item.protocol || "")}`;
  return `cand-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

function priceDrops(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function blocked(item, code, rationale, seller, amount) {
  return {
    block: code,
    code,
    key: candidateKey(item, seller, amount),
    rationale,
  };
}

function payable(item, seller, amount) {
  const found = missionPolicy.discover({
    network: config.NETWORK,
    network_id: config.NETWORK_ID,
    accounts: [{ address: seller }],
  });
  if (found.foreign.length !== 1 || found.foreign[0] !== seller || missionPolicy.isHouse(seller)) {
    return blocked(item, "no_foreign_seller", "The payTo account is not a foreign xrpl:1 seller.", seller, amount);
  }
  return {
    payable: true,
    key: candidateKey(item, seller, amount),
    seller,
    price_drops: amount,
  };
}

function qualifyCandidate(item, now) {
  if (!item || typeof item !== "object") return { skip: "invalid_item", key: "invalid-item" };
  if (item.kind && item.kind !== config.AUTONOMOUS_CLASS) return { skip: "novel_kind", key: candidateKey(item) };
  if (item.protocol && item.protocol !== "x402" && !item.service && !item.x402 && !item.paymentRequired && !item.accept) {
    return blocked(item, "unsupported_protocol", `Protocol ${String(item.protocol).slice(0, 40)} is not an xrpl:1 XRP payment.`);
  }
  const required = item.x402 || item.paymentRequired || (item.accept ? { x402Version: item.x402Version || 2, accepts: [item.accept] } : null);
  if (required) {
    if (required.x402Version != null && required.x402Version !== 2) {
      return blocked(item, "unsupported_protocol", "x402Version is not 2.");
    }
    const accepts = Array.isArray(required.accepts) ? required.accepts : [];
    if (accepts.some((row) => row && (row.network === "xrpl:0" || row.network === "xrpl-mainnet"))) {
      return blocked(item, "MAINNET", "Refusing an xrpl:0 payment requirement.");
    }
    const chosen = accepts.find((row) => row && row.network === "xrpl:1" && (row.scheme == null || row.scheme === "exact") && (row.asset == null || row.asset === "XRP"));
    if (!chosen) return blocked(item, "unsupported_protocol", "No exact xrpl:1 XRP accept in the payment requirement.");
    if (chosen.scheme != null && chosen.scheme !== "exact") {
      return blocked(item, "unsupported_protocol", "The payment scheme is not exact.");
    }
    const amount = priceDrops(chosen.amount != null ? chosen.amount : chosen.maxAmountRequired);
    if (typeof chosen.payTo !== "string" || !amount) {
      return blocked(item, "unsupported_protocol", "The xrpl:1 accept has no payTo amount.");
    }
    const resource = x402Deliver.resourceOf(item, required);
    if (!resource) {
      return blocked(item, "undeliverable", "payTo is not a raw Payment. The 402 response has no resource to deliver.", chosen.payTo, amount);
    }
    const fresh = x402Deliver.challengeFresh(item, { maxTimeoutSeconds: chosen.maxTimeoutSeconds }, now);
    if (!fresh.ok) return blocked(item, fresh.code, fresh.rationale, chosen.payTo, amount);
    const row = payable(item, chosen.payTo, amount);
    if (row.block) return row;
    row.resource = resource;
    row.accept = x402Deliver.acceptOf(chosen, amount);
    row.required = { x402Version: 2, resource: resource.url, accepts: [row.accept] };
    return row;
  }
  const service = item.service;
  if (!service || typeof service !== "object" || Array.isArray(service)) return { skip: "missing_service", key: candidateKey(item) };
  for (const key of Object.keys(service)) {
    if (!SERVICE_KEYS.has(key)) return { skip: "untrusted_field", key: candidateKey(item) };
  }
  if (item.payment_drops != null && item.payment_drops !== service.price_drops) {
    return { skip: "untrusted_field", key: candidateKey(item) };
  }
  if (service.network !== config.NETWORK || Number(service.network_id) !== config.NETWORK_ID) {
    return blocked(item, "unsupported_protocol", "The service network is not xrpl:1.");
  }
  if (service.asset != null && service.asset !== "XRP") return blocked(item, "NON_XRP", "The service asset is not XRP.");
  const amount = priceDrops(service.price_drops);
  if (!amount) return { skip: "missing_payment", key: candidateKey(item) };
  if (typeof service.seller !== "string") return { skip: "missing_accounts", key: candidateKey(item) };
  const seller = payable(item, service.seller, amount);
  if (seller.block) return seller;
  return blocked(item, "undeliverable", "A foreign payTo is not an instruction to send a raw Payment.", service.seller, amount);
}

function runtimeFetch(opts) {
  if (opts && typeof opts.fetch === "function") return opts.fetch;
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  return null;
}

async function quotedFee(opts, now) {
  if (opts && typeof opts.quoteFee === "function") return networkFee.assertFresh(await opts.quoteFee(now), now);
  return networkFee.quoteNetworkFee({ fetch: runtimeFetch(opts), now });
}

function withFee(built, quote, execute) {
  const price = BigInt(built.price_drops);
  const fee = BigInt(execute ? networkFee.reserveCeiling(quote.fee_drops) : quote.fee_drops);
  if (price + fee > config.PER_MISSION_DROPS) {
    return blocked({ id: built.key }, "FEE_CAP", "The XRPL network fee plus the payTo amount exceeds 1000000 drops.", built.seller, built.price_drops);
  }
  return {
    key: built.key,
    seller: built.seller,
    resource: built.resource,
    accept: built.accept,
    required: built.required,
    input: {
      idempotency_key: built.key,
      kind: config.AUTONOMOUS_CLASS,
      observation: {
        network: config.NETWORK,
        network_id: config.NETWORK_ID,
        accounts: [{ address: built.seller, source: "x402" }],
      },
      payment_drops: built.price_drops,
      network_fee_drops: fee.toString(),
      resource_url: built.resource ? built.resource.url : null,
    },
  };
}

function allowlistOf(file) {
  const body = readJson(file);
  const payees = [];
  for (const item of (body && Array.isArray(body.payees) ? body.payees : [])) {
    if (typeof item === "string" && item) payees.push(item);
    else if (item && typeof item.address === "string" && typeof item.resource === "string") {
      payees.push({ address: item.address, resource: item.resource });
    }
  }
  return { payees };
}

function pathsOf(options) {
  const env = options.env || {};
  const home = guard.assertIsolated(options.home || env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime");
  const ledger = guard.assertIsolated(options.ledger || env.FOUNDRY_MISSION_LEDGER || path.join(home, "ledger"));
  return {
    home,
    ledger,
    discovery: options.discovery || env.FOUNDRY_MISSION_DISCOVERY || path.join(home, "discovery.json"),
    allowlist: options.allowlist || env.FOUNDRY_MISSION_ALLOWLIST || path.join(home, "allowlist.json"),
    config: options.configFile || env.FOUNDRY_MISSION_WORKER_CONFIG || path.join(home, "worker.json"),
  };
}

async function publishIfAsked(ledger, env, now, deps) {
  if (!env || env.FOUNDRY_MISSION_PUBLISH !== "yes") return { uploaded: false, reason: "publish_off" };
  const fetchImpl = runtimeFetch(deps);
  try {
    if (typeof env.FOUNDRY_MISSION_INGEST_SECRET === "string" && env.FOUNDRY_MISSION_INGEST_SECRET.length >= 32) {
      return await uploadIngest(ledger, { env, now, fetch: fetchImpl });
    }
    if (typeof env.FOUNDRY_MISSION_GITHUB_TOKEN === "string" && env.FOUNDRY_MISSION_GITHUB_TOKEN.length >= 16) {
      return await uploadSnapshot(ledger, { env, now, fetch: fetchImpl });
    }
    return { uploaded: false, reason: "no_ingest_secret" };
  } catch (error) {
    return { uploaded: false, reason: error.code || "PUBLISH" };
  }
}

async function defaultPresign(mission, env, opts) {
  const fetchImpl = (opts && opts.signerFetch) || (opts && opts.fetch) || globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const port = guard.assertFreePort(env.FOUNDRY_MISSION_SIGNER_PORT, 8788);
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.FOUNDRY_MISSION_SIGNER_TOKEN || ""}`,
      },
      body: JSON.stringify({
        intent: "mission_spend",
        execute: true,
        presign: true,
        dry_run: false,
        mission_id: mission.id,
        tx: mission.unsigned_tx,
      }),
    });
  } catch {
    return null;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) return { refused: true, code: (body && body.code) || "SIGNER" };
  if (!body || !body.tx_blob || !body.hash) return null;
  return { tx_blob: body.tx_blob, hash: body.hash };
}

async function maybeSubmit(mission, env, deps) {
  if (!env || env.FOUNDRY_MISSION_EXECUTE !== "yes") return { submitted: false, reason: "execute_off" };
  const fetchImpl = (deps && typeof deps.signerFetch === "function" && deps.signerFetch)
    || (deps && typeof deps.fetch === "function" && deps.fetch)
    || (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
  if (typeof fetchImpl !== "function") return { submitted: false, reason: "no_signer_fetch" };
  const port = guard.assertFreePort(env.FOUNDRY_MISSION_SIGNER_PORT, 8788);
  const response = await fetchImpl(`http://127.0.0.1:${port}/sign`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.FOUNDRY_MISSION_SIGNER_TOKEN || ""}`,
    },
    body: JSON.stringify({
      intent: "mission_spend",
      execute: true,
      dry_run: false,
      mission_id: mission.id,
      tx: mission.unsigned_tx,
    }),
  });
  const result = await response.json();
  if (!response.ok || result.submitted !== true) return { submitted: false, reason: result.code || "signer_dry_run", result };
  return { submitted: true, result };
}

async function expireProvenWindows(ledger, fetchImpl, now) {
  if (!fetchImpl || !fs.existsSync(path.join(ledger, "events.jsonl"))) return;
  const state = view(ledger, now);
  for (const mission of Object.values(state.missions || {})) {
    if (!Number.isInteger(mission.last_ledger_sequence) || !mission.presigned_hash) continue;
    if (mission.complete === true || mission.hold === "released" || mission.hold === "spent") continue;
    const account = mission.signed_fields && mission.signed_fields.Account;
    if (!account) continue;
    let found;
    let validated;
    try {
      found = await ledgerWindow.hashFound(fetchImpl, mission.presigned_hash);
      if (found !== false) continue;
      validated = (await ledgerWindow.readValidatedAccount(fetchImpl, account)).validated;
    } catch {
      continue;
    }
    try {
      releasePassedWindow(ledger, {
        mission_id: mission.id,
        now,
        validatedLedger: validated,
        hashFound: false,
      });
    } catch {
      /* An unproven window stays open. */
    }
  }
}

async function tick(options) {
  const opts = options || {};
  const env = opts.env || {};
  guard.assertNoHouseSeeds(env);
  const now = opts.now || new Date().toISOString();
  const files = pathsOf(opts);
  const fileConfig = readJson(files.config);
  const schedule = scheduleOpen(env, fileConfig, opts);
  const events = fs.existsSync(path.join(files.ledger, "events.jsonl")) ? readEvents(files.ledger) : [];
  const enabled = classOpen(events);
  const base = {
    schema: "aether.missions.tick",
    asleep: !schedule,
    schedule_open: schedule,
    class_enabled: enabled,
    submitted: false,
    signed: false,
    worked: false,
    reason: !schedule ? "asleep" : enabled ? null : "class_off",
  };
  if (!schedule || !enabled) {
    if (!schedule) {
      try {
        const controlled = await wake.controlTick(files.home, files.ledger, env, now, { fetch: runtimeFetch(opts) });
        if (controlled.control) {
          writeState(files.ledger, { last_tick_at: now, last_reason: "control" });
          return Object.assign(base, controlled, { asleep: true, reason: "control", schedule_open: false });
        }
      } catch (error) {
        writeState(files.ledger, { last_tick_at: now, last_reason: error.code || "control" });
        return Object.assign(base, {
          asleep: true,
          reason: error.code || "control",
          control: true,
          execute: false,
          submitted: false,
          complete: false,
        });
      }
    }
    if (env.FOUNDRY_MISSION_PUBLISH === "yes" && env.FOUNDRY_MISSION_EXECUTE !== "yes") {
      try {
        await uploadIngest(files.ledger, { env, now, fetch: runtimeFetch(opts), heartbeat: true });
      } catch {
        /* A missed health upload does not start a purchase. */
      }
    }
    writeState(files.ledger, { last_tick_at: now, last_reason: base.reason });
    return base;
  }
  await expireProvenWindows(files.ledger, runtimeFetch(opts), now);
  const state = readJson(path.join(files.ledger, STATE_NAME)) || { consumed: {} };
  let discovery;
  if (Array.isArray(opts.oneShotItems)) {
    if (opts.oneShotItems.some((item) => /cand-17|fee-retry/.test(String(item && item.id || "")))) {
      writeState(files.ledger, { last_tick_at: now, last_reason: "NO_RETRY" });
      return Object.assign(base, { reason: "NO_RETRY", code: "NO_RETRY", submitted: false, complete: false });
    }
    if (opts.requireNewAccount) {
      const open = blockingClaim(view(files.ledger, now), null);
      try {
        if (!open) throw coded("no unresolved claim is on file", "CLAIM");
        requireDecision(files.ledger, open.mission_id);
      } catch (error) {
        writeState(files.ledger, { last_tick_at: now, last_reason: error.code || "AUTH" });
        return Object.assign(base, { reason: error.code || "AUTH", code: error.code || "AUTH", submitted: false, complete: false });
      }
    }
    discovery = { items: opts.oneShotItems, reason: null };
  } else {
    try {
      discovery = loadDiscovery(files.discovery);
    } catch (error) {
      writeState(files.ledger, { last_tick_at: now, last_reason: error.code || "DISCOVERY" });
      return Object.assign(base, { reason: error.code || "DISCOVERY" });
    }
  }
  const pending = discovery.items.find((item) => item && !state.consumed[candidateKey(item)]);
  if (!pending) {
    writeState(files.ledger, { last_tick_at: now, last_reason: discovery.reason || "idle" });
    return Object.assign(base, { reason: discovery.reason || "idle" });
  }
  const held = blockingClaim(view(files.ledger, now), env.MISSION_XRPL_ADDRESS || null);
  if (held) {
    writeState(files.ledger, { last_tick_at: now, last_reason: "SEQUENCE_HELD" });
    return Object.assign(base, {
      reason: "SEQUENCE_HELD",
      code: "SEQUENCE_HELD",
      worked: false,
      submitted: false,
      signed: false,
      complete: false,
      sequence_policy: "hold",
      held_mission_id: held.mission_id,
      options: held.options,
    });
  }
  let built = qualifyCandidate(pending, now);
  if (built.payable) {
    try {
      built = withFee(built, await quotedFee(opts, now), env.FOUNDRY_MISSION_EXECUTE === "yes");
    } catch (error) {
      built = blocked(pending, error.code || "FEE", "The XRPL Labs network fee could not be used. A merchant fee was not invented.");
    }
  }
  if (built.block) {
    const recorded = blockMission(files.ledger, {
      idempotency_key: built.key,
      now,
      code: built.code,
      rationale: built.rationale,
    });
    writeState(files.ledger, {
      last_tick_at: now,
      last_reason: built.block,
      consumed: { [built.key]: { at: now, reason: built.block } },
    });
    return Object.assign(base, {
      reason: built.block,
      code: recorded.mission.code,
      mission_id: recorded.mission.id,
      worked: true,
      complete: false,
    });
  }
  if (built.skip) {
    writeState(files.ledger, {
      last_tick_at: now,
      last_reason: built.skip,
      consumed: { [built.key]: { at: now, reason: built.skip } },
    });
    return Object.assign(base, { reason: built.skip, code: built.code || null, worked: false });
  }
  let mission;
  try {
    const started = startMission(files.ledger, Object.assign({ now }, built.input), { allowlist: allowlistOf(files.allowlist) });
    mission = started.mission;
    if (opts.priorClaimId) mission = linkPriorClaim(files.ledger, mission.id, opts.priorClaimId, now).mission;
    if (mission.status === "approved_ready") {
      if (!guard.present(env.MISSION_XRPL_ADDRESS)) {
        writeState(files.ledger, {
          last_tick_at: now,
          last_reason: "missing_account",
          consumed: { [built.key]: { at: now, reason: "missing_account" } },
        });
        return Object.assign(base, { reason: "missing_account", mission_id: mission.id, worked: true });
      }
      mission = act(files.ledger, { mission_id: mission.id, now }, { wallet: { address: env.MISSION_XRPL_ADDRESS } }).mission;
    }
  } catch (error) {
    writeState(files.ledger, {
      last_tick_at: now,
      last_reason: error.code || "ERROR",
      consumed: { [built.key]: { at: now, reason: error.code || "ERROR" } },
    });
    return Object.assign(base, { reason: error.code || "ERROR" });
  }
  let submitted = false;
  if (mission.status === "ready_for_signer" && env.FOUNDRY_MISSION_EXECUTE === "yes") {
    try {
      const again = await quotedFee(opts, now);
      const fresh = BigInt(again.fee_drops);
      const reservedFee = BigInt(mission.budget.network_fee_drops);
      if (fresh < reservedFee) {
        mission = narrowUnsubmittedFee(files.ledger, {
          mission_id: mission.id,
          now,
          fee_drops: again.fee_drops,
        }).mission;
      }
      if (fresh > reservedFee) {
        const released = releasePrepared(files.ledger, {
          mission_id: mission.id,
          now,
          code: "FEE_CAP",
          rationale: "A fresh XRPL Labs fee is above the reserved network fee. Nothing was signed.",
        });
        mission = released.mission;
        writeState(files.ledger, {
          last_tick_at: now,
          last_reason: "FEE_CAP",
          consumed: { [built.key]: { at: now, reason: "FEE_CAP" } },
        });
        return Object.assign(base, { reason: "FEE_CAP", code: "FEE_CAP", mission_id: mission.id, worked: true, submitted: false, complete: false });
      }
    } catch (error) {
      const released = releasePrepared(files.ledger, {
        mission_id: mission.id,
        now,
        code: error.code || "FEE_STALE",
        rationale: "The XRPL Labs fee quote was not fresh. Nothing was signed.",
      });
      mission = released.mission;
      writeState(files.ledger, {
        last_tick_at: now,
        last_reason: mission.code,
        consumed: { [built.key]: { at: now, reason: mission.code } },
      });
      return Object.assign(base, { reason: mission.code, code: mission.code, mission_id: mission.id, worked: true, submitted: false, complete: false });
    }
    if (!serviceResult.supportsResource(built.resource && built.resource.url)) {
      const released = releasePrepared(files.ledger, {
        mission_id: mission.id,
        now,
        code: "unsupported_delivery",
        rationale: "This resource has no supported purchase-result validator. Nothing was signed.",
      });
      writeState(files.ledger, {
        last_tick_at: now,
        last_reason: "unsupported_delivery",
        consumed: { [built.key]: { at: now, reason: "unsupported_delivery" } },
      });
      return Object.assign(base, {
        reason: "unsupported_delivery",
        code: "unsupported_delivery",
        mission_id: released.mission.id,
        worked: true,
        submitted: false,
        complete: false,
      });
    }
    const probe = opts.resourceFetch || (opts.fetch ? null : globalThis.fetch);
    const live = await x402Deliver.preflight(built, probe);
    if (!live.ok) {
      const released = releasePrepared(files.ledger, {
        mission_id: mission.id,
        now,
        code: live.code,
        rationale: live.rationale,
      });
      writeState(files.ledger, {
        last_tick_at: now,
        last_reason: live.code,
        consumed: { [built.key]: { at: now, reason: live.code } },
      });
      return Object.assign(base, {
        reason: live.code,
        code: live.code,
        mission_id: released.mission.id,
        worked: true,
        submitted: false,
        complete: false,
      });
    }
    let challenge;
    try {
      challenge = x402Deliver.bindChallenge(live.accept);
    } catch (error) {
      const released = releasePrepared(files.ledger, {
        mission_id: mission.id,
        now,
        code: error.code || "TX",
        rationale: "The live xrpl:1 challenge did not include a usable source tag and invoice. Nothing was signed.",
      });
      writeState(files.ledger, {
        last_tick_at: now,
        last_reason: error.code || "TX",
        consumed: { [built.key]: { at: now, reason: error.code || "TX" } },
      });
      return Object.assign(base, {
        reason: error.code || "TX",
        code: error.code || "TX",
        mission_id: released.mission.id,
        worked: true,
        submitted: false,
        complete: false,
      });
    }
    mission = applyChallenge(files.ledger, {
      mission_id: mission.id,
      now,
      sourceTag: challenge.sourceTag,
      invoiceId: challenge.invoiceId,
      invoiceIdField: challenge.invoiceIdField,
    }).mission;
    const account = opts.preparedAccount
      || await ledgerWindow.readValidatedAccount(runtimeFetch(opts), env.MISSION_XRPL_ADDRESS);
    const bound = ledgerWindow.bindWindow(account.validated, account.sequence);
    mission = stampPrepared(files.ledger, {
      mission_id: mission.id,
      now,
      sequence: bound.sequence,
      lastLedgerSequence: bound.lastLedgerSequence,
    }).mission;
    if (typeof opts.presign !== "function") opts.presign = (mission) => defaultPresign(mission, env, opts);
    let begun;
    try {
      begun = beginSubmit(files.ledger, { mission_id: mission.id, now });
    } catch (error) {
      writeState(files.ledger, {
        last_tick_at: now,
        last_reason: error.code || "NO_RETRY",
        consumed: { [built.key]: { at: now, reason: error.code || "NO_RETRY" } },
      });
      return Object.assign(base, { reason: error.code || "NO_RETRY", mission_id: mission.id, worked: true, submitted: false, complete: false });
    }
    if (begun.proceed) {
      const signed = await opts.presign(begun.mission);
      if (!signed || !signed.tx_blob || !signed.hash) {
        if (signed && signed.refused === true) {
          try {
            const released = releaseUnsignedClaim(files.ledger, {
              mission_id: mission.id,
              now,
              code: signed.code || "SIGNER",
              rationale: "The dedicated signer refused before any signature. The claim was released and nothing was submitted.",
            });
            writeState(files.ledger, {
              last_tick_at: now,
              last_reason: released.mission.code,
              consumed: { [built.key]: { at: now, reason: released.mission.code } },
            });
            return Object.assign(base, {
              reason: released.mission.code,
              code: released.mission.code,
              mission_id: mission.id,
              worked: true,
              submitted: false,
              complete: false,
            });
          } catch {
            /* A hash may already be on the claim. Leave it uncertain. */
          }
        }
        writeState(files.ledger, {
          last_tick_at: now,
          last_reason: "undeliverable",
          consumed: { [built.key]: { at: now, reason: "undeliverable" } },
        });
        return Object.assign(base, { reason: "undeliverable", code: "undeliverable", mission_id: mission.id, worked: true, submitted: false, complete: false });
      }
      const storedBefore = view(files.ledger, now).missions[mission.id];
      if (
        !storedBefore
        || storedBefore.presigned !== true
        || storedBefore.signed !== true
        || storedBefore.presigned_hash !== signed.hash
        || !storedBefore.signed_fields
        || !Number.isInteger(storedBefore.last_ledger_sequence)
      ) {
        writeState(files.ledger, {
          last_tick_at: now,
          last_reason: "persistence_missing",
          consumed: { [built.key]: { at: now, reason: "persistence_missing" } },
        });
        return Object.assign(base, {
          reason: "persistence_missing",
          code: "persistence_missing",
          mission_id: mission.id,
          worked: true,
          submitted: false,
          complete: false,
        });
      }
      let submittedOnce = false;
      let delivered = { http_status: 0, submitted: false, hash: null, mode: "refused", parsed: null };
      try {
        delivered = await x402Deliver.deliverProof({
          fetchImpl: probe,
          resource: built.resource,
          required: built.required,
          accept: live.accept,
          txBlob: signed.tx_blob,
          hash: signed.hash,
          sleep: async () => {},
          submit: async () => {
            if (submittedOnce) throw coded("refusing a second submit", "NO_RETRY");
            submittedOnce = true;
            const sent = await maybeSubmit(begun.mission, env, opts);
            if (!sent.submitted) throw coded("signer did not submit", "SUBMIT");
            return { hash: sent.result.hash, result: sent.result.engine_result, ledger_index: null };
          },
        });
      } catch {
        delivered = { http_status: 0, submitted: submittedOnce, hash: null, mode: "refused", parsed: null };
      }
      const verdict = serviceResult.validatePurchasedService(
        built.resource && built.resource.url,
        delivered.http_status,
        delivered.parsed
      );
      if (verdict.useful === true && delivered.hash) {
        const finished = finishSubmit(files.ledger, {
          mission_id: mission.id,
          now,
          result: {
            hash: delivered.hash,
            engine_result: "tesSUCCESS",
            submitted: delivered.submitted === true,
            network_id: 1,
          },
          delivery: {
            mode: delivered.mode,
            http_status: 200,
            hash: delivered.hash,
            result: { schema: verdict.schema },
          },
        });
        mission = evaluate(files.ledger, {
          mission_id: mission.id,
          now,
          payload: {
            qualified: true,
            seller: mission.seller,
            network: config.NETWORK,
            network_id: config.NETWORK_ID,
            hash: finished.mission.proof_hash,
          },
        }).mission;
        submitted = mission.submitted === true;
      } else {
        try {
          noteDeliveryFailure(files.ledger, {
            mission_id: mission.id,
            now,
            http_status: delivered.http_status,
            code: verdict.code,
            error_code: serviceResult.boundedErrorCode(delivered.parsed, delivered.http_status),
            parsed: delivered.parsed,
          });
        } catch {
          /* The presigned claim stays as it is. */
        }
        writeState(files.ledger, {
          last_tick_at: now,
          last_reason: "delivery_failed",
          consumed: { [built.key]: { at: now, reason: "delivery_failed" } },
        });
        return Object.assign(base, {
          reason: "delivery_failed",
          code: "delivery_failed",
          http_status: Number.isInteger(delivered.http_status) ? delivered.http_status : null,
          mission_id: mission.id,
          worked: true,
          submitted: delivered.submitted === true,
          signed: true,
          complete: false,
        });
      }
    }
  }
  writeState(files.ledger, {
    last_tick_at: now,
    last_reason: mission.status,
    consumed: { [built.key]: { at: now, reason: mission.status } },
  });
  const published = await publishIfAsked(files.ledger, env, now, opts);
  return Object.assign(base, {
    worked: true,
    reason: mission.status,
    mission_id: mission.id,
    code: mission.code || null,
    submitted,
    signed: mission.signed === true,
    complete: mission.complete === true,
    published,
  });
}

function healthBody(env, ledger, configFile) {
  const source = env || {};
  const events = ledger && fs.existsSync(path.join(ledger, "events.jsonl")) ? readEvents(ledger) : [];
  const status = events.length ? view(ledger) : null;
  const fileConfig = configFile ? readJson(configFile) : null;
  let armed = false;
  try {
    armed = checkArm(source).mission_signer_armed === true && source.FOUNDRY_MISSION_EXECUTE === "yes";
  } catch {
    armed = false;
  }
  return {
    role: "mission-worker",
    asleep: !scheduleOpen(source, fileConfig),
    class_enabled: classOpen(events),
    loop: true,
    autonomous: source.FOUNDRY_MISSION_WORKER === "yes",
    execute_armed: source.FOUNDRY_MISSION_EXECUTE === "yes",
    ordinary_signing: false,
    mission_signer_armed: armed,
    mission_spend_enabled: armed,
    signing_disabled: !armed,
    submitted: false,
    asset: "XRP",
    evm_gas: "not_authorized",
    dedicated_signer_port: 8788,
    untouched_listeners: ["127.0.0.1:8787", "127.0.0.1:8792", "127.0.0.1:8793"],
    live_spend_drops: status ? status.live_spend_drops : null,
    spending_enabled: status ? status.spending_enabled : false,
    source: status ? status.source : "unavailable",
  };
}

function startHealth(env, files, port) {
  const host = guard.assertLoopback(env.FOUNDRY_MISSION_WORKER_BIND);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/health") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not found", code: "PATH" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(healthBody(env, files.ledger, files.config)));
  });
  server.listen(port, host);
  return server;
}

async function run(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  guard.assertNoHouseSeeds(env);
  const files = pathsOf(opts);
  const interval = guard.clampInterval(env.FOUNDRY_MISSION_INTERVAL_MS);
  const maxTicks = opts.maxTicks || (env.FOUNDRY_MISSION_WORKER_MAX_TICKS ? Number(env.FOUNDRY_MISSION_WORKER_MAX_TICKS) : 0);
  const port = opts.listen === false ? null : opts.port === 0 ? 0 : guard.assertFreePort(env.FOUNDRY_MISSION_WORKER_PORT, DEFAULT_PORT);
  const server = port == null ? null : startHealth(env, files, port);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  if (opts.signal) opts.signal.addEventListener("abort", stop);
  if (opts.signals !== false) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const results = [];
  let ticks = 0;
  while (!stopped) {
    results.push(await tick(Object.assign({}, opts, { env })));
    ticks += 1;
    if (opts.once || (maxTicks && ticks >= maxTicks)) break;
    await sleep(interval);
    if (stopped) break;
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  return { ticks, results, interval_ms: interval };
}

if (require.main === module) {
  const once = process.argv.includes("--once");
  run({ env: process.env, once, listen: !once })
    .then((body) => {
      if (once) process.stdout.write(`${JSON.stringify(body.results[0])}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "FATAL"}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_PORT,
  scheduleOpen,
  tick,
  healthBody,
  run,
};
