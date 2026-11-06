#!/usr/bin/env node
"use strict";

/**
 * Dedicated loopback signer for the isolated mission account.
 * It does not load W0–W7 seeds, does not read a secrets file, and does not bind 8787.
 */

const crypto = require("crypto");
const http = require("http");
const policy = require("../runtime/policy");
const guard = require("./runtime-guard");
const { coded } = require("./ledger");

const DEFAULT_PORT = 8788;
const DEFAULT_WS = "wss://testnet.xrpl-labs.com";
const ALLOWED_WS = new Set([DEFAULT_WS, "wss://s.altnet.rippletest.net:51233"]);

function assertWs(raw) {
  const value = String(raw || DEFAULT_WS);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw coded("mission signer websocket is not a URL", "HOST");
  }
  if (url.username || url.password) throw coded("mission signer refuses credentials in the websocket URL", "HOST");
  const normalized = `${url.protocol}//${url.host}`;
  if (!ALLOWED_WS.has(normalized)) throw coded("mission signer refuses that websocket", "HOST");
  return normalized;
}

function assertToken(token) {
  if (typeof token !== "string" || token.length < 16) throw coded("refusing empty mission signer token", "TOKEN");
  return token;
}

function bearerOk(header, token) {
  const match = String(header || "").match(/^Bearer\s+(\S+)\s*$/);
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function health(env, port) {
  const source = env || {};
  guard.assertNoHouseSeeds(source);
  const address = typeof source.MISSION_XRPL_ADDRESS === "string" ? source.MISSION_XRPL_ADDRESS : "";
  const seedPresent = guard.present(source.MISSION_XRPL_SEED);
  return {
    role: "mission-signer",
    bind: "127.0.0.1",
    port,
    network_id: 1,
    asset: "XRP",
    evm_gas: "not_authorized",
    signing: false,
    ordinary_signer: false,
    mission_spend: Boolean(address && seedPresent),
    execute_armed: source.FOUNDRY_MISSION_EXECUTE === "yes",
    mission_account_configured: Boolean(address),
    house_seeds: "refused",
  };
}

async function submitPrepared(tx, env, deps) {
  const options = deps || {};
  const xrpl = options.xrpl || require("xrpl");
  const seed = env.MISSION_XRPL_SEED;
  let wallet;
  try {
    wallet = options.openWallet ? options.openWallet(seed) : xrpl.Wallet.fromSeed(seed);
  } catch (error) {
    if (error && error.code) throw error;
    throw coded("MISSION_XRPL_SEED is not a usable seed", "NO_SEED");
  }
  const classic = wallet.classicAddress || wallet.address;
  if (classic !== env.MISSION_XRPL_ADDRESS) throw coded("isolated key does not match MISSION_XRPL_ADDRESS", "WALLET");
  if (options.submit) return options.submit(tx, { classicAddress: classic, sign: (body) => wallet.sign(body) });
  const ws = assertWs(env.FOUNDRY_MISSION_XRPL_WS);
  const client = options.client || new xrpl.Client(ws);
  try {
    await client.connect();
    const prepared = await client.autofill(tx);
    policy.assertMissionSpend(prepared, env);
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const result = (submitted && submitted.result) || {};
    const meta = result.meta || {};
    return {
      hash: result.hash,
      engine_result: meta.TransactionResult,
      network_id: 1,
    };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function evaluate(body, env, deps) {
  const source = env || {};
  const options = deps || {};
  guard.assertNoHouseSeeds(source);
  policy.assertNotCi(source);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw coded("refusing empty body", "ARGS");
  if (body.intent !== "mission_spend") throw coded("mission signer intent mismatch", "TX");
  policy.assertNoSeedFields(body);
  policy.assertMissionSpend(body.tx, source);
  const execute = source.FOUNDRY_MISSION_EXECUTE === "yes" && body.execute === true && body.dry_run !== true && options.dry !== true;
  if (!execute) {
    return {
      dry_run: true,
      intent: "mission_spend",
      key_loaded: false,
      signed: false,
      submitted: false,
      live: false,
      network_id: 1,
      account: source.MISSION_XRPL_ADDRESS || null,
      tx: body.tx,
    };
  }
  if (!guard.present(source.MISSION_XRPL_SEED)) throw coded("MISSION_XRPL_SEED is not loaded. Refusing to sign.", "NO_SEED");
  if (options.io && options.io.readFileSync) throw coded("mission signer does not read a secrets file", "SEED");
  const submitted = await submitPrepared(body.tx, source, options);
  const text = JSON.stringify(submitted || {});
  if (source.MISSION_XRPL_SEED && text.includes(source.MISSION_XRPL_SEED)) throw coded("refusing to return a seed", "SEED");
  if (!submitted || submitted.engine_result !== "tesSUCCESS") {
    throw coded("mission submit did not validate", "SUBMIT");
  }
  return {
    dry_run: false,
    intent: "mission_spend",
    key_loaded: true,
    signed: true,
    submitted: true,
    live: true,
    network_id: 1,
    hash: String(submitted.hash || "").toUpperCase(),
    engine_result: submitted.engine_result,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        reject(coded("body too large", "ARGS"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(coded("body is not JSON", "ARGS"));
      }
    });
    req.on("error", () => reject(coded("body unreadable", "ARGS")));
  });
}

function startServer(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  guard.assertNoHouseSeeds(env);
  const token = assertToken(env.FOUNDRY_MISSION_SIGNER_TOKEN);
  const host = guard.assertLoopback(opts.host || env.FOUNDRY_MISSION_SIGNER_BIND);
  const port = opts.port === 0 ? 0 : guard.assertFreePort(opts.port || env.FOUNDRY_MISSION_SIGNER_PORT, DEFAULT_PORT);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let body;
      let status = 200;
      if (req.method === "GET" && url.pathname === "/health") {
        body = health(env, server.address() ? server.address().port : port);
      } else if (req.method === "POST" && (url.pathname === "/sign" || url.pathname === "/dry-run")) {
        if (!bearerOk(req.headers && (req.headers.authorization || req.headers.Authorization), token)) {
          throw coded("refusing mission signer token", "TOKEN");
        }
        const incoming = await readBody(req);
        body = await evaluate(incoming, env, Object.assign({}, opts, { dry: url.pathname === "/dry-run" || incoming.dry_run === true }));
      } else {
        status = 404;
        body = { error: "not found", code: "PATH" };
      }
      const text = JSON.stringify(body);
      policy.assertPrintSafe(text);
      if (text.includes(token) || (env.MISSION_XRPL_SEED && text.includes(env.MISSION_XRPL_SEED))) {
        throw coded("refusing to echo a secret", "SEED");
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(text);
    } catch (error) {
      const code = error && error.code ? error.code : "FATAL";
      const message = policy.redact(error && error.message ? error.message : "mission signer failed", [token, env.MISSION_XRPL_SEED]);
      const httpStatus = code === "TOKEN" ? 401 : 400;
      res.writeHead(httpStatus, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message, code }));
    }
  });
  server.listen(port, host);
  return server;
}

if (require.main === module) {
  try {
    const server = startServer({ env: process.env });
    server.on("listening", () => {
      const port = server.address().port;
      process.stdout.write(`${JSON.stringify(health(process.env, port))}\n`);
    });
  } catch (error) {
    process.stderr.write(`${error.code || "FATAL"}\n`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_WS,
  assertWs,
  health,
  evaluate,
  startServer,
};
