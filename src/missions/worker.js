#!/usr/bin/env node
"use strict";

/**
 * Bounded mission worker. It stays asleep until FOUNDRY_MISSION_WORKER=yes
 * and the ledger class is activated. Discovery comes from a parent file.
 * This process does not invent sellers, amounts, or payments.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const config = require("./config");
const { coded, readEvents } = require("./ledger");
const { fold, startMission, act, evaluate, view } = require("./engine");
const { beginSubmit, finishSubmit } = require("./submit");
const missionPolicy = require("./policy");
const guard = require("./runtime-guard");
const { uploadSnapshot } = require("./github-publish");
const { check: checkArm } = require("./arm");

const DEFAULT_PORT = 8794;
const STATE_NAME = "worker-state.json";

function scheduleOpen(env, fileConfig) {
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

const SERVICE_KEYS = new Set(["seller", "asset", "price_drops", "fee_drops", "network", "network_id"]);

function qualifyService(item) {
  if (!item || typeof item !== "object") return { skip: "invalid_item" };
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(String(item.id || ""))) return { skip: "invalid_id" };
  if (item.kind && item.kind !== config.AUTONOMOUS_CLASS) return { skip: "novel_kind" };
  const service = item.service;
  if (!service || typeof service !== "object" || Array.isArray(service)) return { skip: "missing_service" };
  for (const key of Object.keys(service)) {
    if (!SERVICE_KEYS.has(key)) return { skip: "untrusted_field" };
  }
  if (item.payment_drops != null && item.payment_drops !== service.price_drops) return { skip: "untrusted_field" };
  if (item.network_fee_drops != null && item.network_fee_drops !== service.fee_drops) return { skip: "untrusted_field" };
  if (service.network !== config.NETWORK || Number(service.network_id) !== config.NETWORK_ID) return { skip: "network" };
  if (service.asset != null && service.asset !== "XRP") return { skip: "NON_XRP" };
  if (typeof service.price_drops !== "string" || !/^[1-9][0-9]*$/.test(service.price_drops)) return { skip: "missing_payment" };
  if (typeof service.fee_drops !== "string" || !/^[0-9]+$/.test(service.fee_drops)) return { skip: "missing_fee" };
  if (typeof service.seller !== "string") return { skip: "missing_accounts" };
  const found = missionPolicy.discover({
    network: config.NETWORK,
    network_id: config.NETWORK_ID,
    accounts: [{ address: service.seller }],
  });
  if (found.foreign.length !== 1 || found.foreign[0] !== service.seller || missionPolicy.isHouse(service.seller)) {
    return { skip: "no_foreign_seller", code: "no_foreign_seller" };
  }
  return {
    input: {
      idempotency_key: item.id,
      kind: config.AUTONOMOUS_CLASS,
      observation: {
        network: config.NETWORK,
        network_id: config.NETWORK_ID,
        accounts: [{ address: service.seller, source: "service" }],
      },
      payment_drops: service.price_drops,
      network_fee_drops: service.fee_drops,
    },
  };
}

function allowlistOf(file) {
  const body = readJson(file);
  const payees = body && Array.isArray(body.payees) ? body.payees.filter((item) => typeof item === "string") : [];
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
  try {
    return await uploadSnapshot(ledger, { env, now, fetch: deps && deps.fetch });
  } catch (error) {
    return { uploaded: false, reason: error.code || "PUBLISH" };
  }
}

async function maybeSubmit(mission, env, deps) {
  if (!env || env.FOUNDRY_MISSION_EXECUTE !== "yes") return { submitted: false, reason: "execute_off" };
  const fetchImpl = deps && deps.fetch;
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

async function tick(options) {
  const opts = options || {};
  const env = opts.env || {};
  guard.assertNoHouseSeeds(env);
  const now = opts.now || new Date().toISOString();
  const files = pathsOf(opts);
  const fileConfig = readJson(files.config);
  const schedule = scheduleOpen(env, fileConfig);
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
    writeState(files.ledger, { last_tick_at: now, last_reason: base.reason });
    return base;
  }
  const state = readJson(path.join(files.ledger, STATE_NAME)) || { consumed: {} };
  let discovery;
  try {
    discovery = loadDiscovery(files.discovery);
  } catch (error) {
    writeState(files.ledger, { last_tick_at: now, last_reason: error.code || "DISCOVERY" });
    return Object.assign(base, { reason: error.code || "DISCOVERY" });
  }
  const pending = discovery.items.find((item) => item && !state.consumed[item.id]);
  if (!pending) {
    writeState(files.ledger, { last_tick_at: now, last_reason: discovery.reason || "idle" });
    return Object.assign(base, { reason: discovery.reason || "idle" });
  }
  const built = qualifyService(pending);
  if (built.skip) {
    writeState(files.ledger, {
      last_tick_at: now,
      last_reason: built.skip,
      consumed: { [String(pending.id || "invalid")]: { at: now, reason: built.skip } },
    });
    return Object.assign(base, { reason: built.skip, code: built.code || null, worked: false });
  }
  let mission;
  try {
    const started = startMission(files.ledger, Object.assign({ now }, built.input), { allowlist: allowlistOf(files.allowlist) });
    mission = started.mission;
    if (mission.status === "approved_ready") {
      if (!guard.present(env.MISSION_XRPL_ADDRESS)) {
        writeState(files.ledger, {
          last_tick_at: now,
          last_reason: "missing_account",
          consumed: { [pending.id]: { at: now, reason: "missing_account" } },
        });
        return Object.assign(base, { reason: "missing_account", mission_id: mission.id, worked: true });
      }
      mission = act(files.ledger, { mission_id: mission.id, now }, { wallet: { address: env.MISSION_XRPL_ADDRESS } }).mission;
    }
  } catch (error) {
    writeState(files.ledger, {
      last_tick_at: now,
      last_reason: error.code || "ERROR",
      consumed: { [pending.id]: { at: now, reason: error.code || "ERROR" } },
    });
    return Object.assign(base, { reason: error.code || "ERROR" });
  }
  let submitted = false;
  if (mission.status === "ready_for_signer" && env.FOUNDRY_MISSION_EXECUTE === "yes") {
    let begun;
    try {
      begun = beginSubmit(files.ledger, { mission_id: mission.id, now });
    } catch (error) {
      writeState(files.ledger, {
        last_tick_at: now,
        last_reason: error.code || "NO_RETRY",
        consumed: { [pending.id]: { at: now, reason: error.code || "NO_RETRY" } },
      });
      return Object.assign(base, { reason: error.code || "NO_RETRY", mission_id: mission.id, worked: true, submitted: false, complete: false });
    }
    if (begun.proceed) {
      let sent = { submitted: false, reason: "signer_uncertain" };
      try {
        sent = await maybeSubmit(begun.mission, env, opts);
      } catch {
        sent = { submitted: false, reason: "signer_uncertain" };
      }
      const finished = sent.submitted
        ? finishSubmit(files.ledger, { mission_id: mission.id, now, result: sent.result })
        : { mission: begun.mission, uncertain: true };
      mission = finished.mission;
      submitted = mission.submitted === true;
      if (submitted) {
        mission = evaluate(files.ledger, {
          mission_id: mission.id,
          now,
          payload: {
            qualified: true,
            seller: mission.seller,
            network: config.NETWORK,
            network_id: config.NETWORK_ID,
            hash: mission.proof_hash,
          },
        }).mission;
      }
    }
  } else if (mission.status === "ready_for_signer") {
    mission = evaluate(files.ledger, {
      mission_id: mission.id,
      now,
      payload: {
        qualified: true,
        seller: mission.seller,
        network: config.NETWORK,
        network_id: config.NETWORK_ID,
      },
    }).mission;
  }
  writeState(files.ledger, {
    last_tick_at: now,
    last_reason: mission.status,
    consumed: { [pending.id]: { at: now, reason: mission.status } },
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
