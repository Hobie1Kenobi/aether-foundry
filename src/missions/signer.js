#!/usr/bin/env node
"use strict";

/**
 * Dedicated loopback signer for the isolated mission account.
 * It does not load W0–W7 seeds, does not read a secrets file, and does not bind 8787.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const policy = require("../runtime/policy");
const guard = require("./runtime-guard");
const { coded } = require("./ledger");
const { acceptClaim, notePresign } = require("./submit");
const ledgerWindow = require("./ledger-window");

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

function accountFile(env) {
  if (!env || !env.FOUNDRY_MISSION_ACCOUNT_FILE) return null;
  if (guard.present(env.MISSION_XRPL_SEED)) throw coded("refusing an environment seed beside the account file", "SEED");
  const home = env.FOUNDRY_MISSION_HOME || "/workspace/foundry-ops/missions-runtime";
  const resolved = path.resolve(env.FOUNDRY_MISSION_ACCOUNT_FILE);
  const expected = path.resolve(home, "account.json");
  if (resolved !== expected) throw coded("refusing an account file outside the mission runtime home", "WALLET");
  guard.assertIsolated(resolved);
  const stat = fs.statSync(resolved);
  if ((stat.mode & 0o777) !== 0o600) throw coded("account file must be mode 0600", "WALLET");
  const body = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!body || typeof body.address !== "string" || typeof body.seed !== "string") {
    throw coded("account file is missing the isolated address", "WALLET");
  }
  if (env.MISSION_XRPL_ADDRESS && body.address !== env.MISSION_XRPL_ADDRESS) {
    throw coded("account file does not match the mission address", "WALLET");
  }
  return { address: body.address, seed: body.seed };
}

function signerArmed(env) {
  const source = env || {};
  if (source.FOUNDRY_MISSION_EXECUTE !== "yes") return false;
  if (source.FOUNDRY_MISSION_ACCOUNT_FILE) {
    try {
      return Boolean(accountFile(source));
    } catch {
      return false;
    }
  }
  return guard.present(source.MISSION_XRPL_ADDRESS) && guard.present(source.MISSION_XRPL_SEED);
}

function health(env, port) {
  const source = env || {};
  guard.assertNoHouseSeeds(source);
  const address = typeof source.MISSION_XRPL_ADDRESS === "string" ? source.MISSION_XRPL_ADDRESS : "";
  const armed = signerArmed(source);
  return {
    role: "mission-signer",
    bind: "127.0.0.1",
    port,
    network_id: 1,
    asset: "XRP",
    evm_gas: "not_authorized",
    ordinary_signing: false,
    mission_signer_armed: armed,
    mission_spend: armed,
    signing_disabled: !armed,
    execute_armed: source.FOUNDRY_MISSION_EXECUTE === "yes",
    mission_account_configured: Boolean(address) || armed,
    house_seeds: "refused",
  };
}

async function signOnly(tx, env, deps) {
  const options = deps || {};
  const xrpl = options.xrpl || require("xrpl");
  const loaded = accountFile(env);
  const seed = loaded ? loaded.seed : env.MISSION_XRPL_SEED;
  const expected = (loaded && loaded.address) || env.MISSION_XRPL_ADDRESS;
  const wallet = options.openWallet ? options.openWallet(seed) : xrpl.Wallet.fromSeed(seed);
  const classic = wallet.classicAddress || wallet.address;
  if (classic !== expected) throw coded("isolated key does not match MISSION_XRPL_ADDRESS", "WALLET");
  policy.assertMissionSpend(tx, Object.assign({}, env, { MISSION_XRPL_ADDRESS: expected }));
  const account = options.validatedAccount
    || await ledgerWindow.readValidatedAccount(options.fetch || globalThis.fetch, tx.Account);
  const fields = ledgerWindow.assertPrepared(tx, account);
  const signed = wallet.sign(tx);
  const hash = String(signed.hash || "").toUpperCase();
  if (!signed.tx_blob || !hash) throw coded("presign did not produce a blob", "SUBMIT");
  return { hash, tx_blob: signed.tx_blob, fields };
}

async function submitPrepared(tx, env, deps) {
  const options = deps || {};
  const xrpl = options.xrpl || require("xrpl");
  const loaded = accountFile(env);
  const seed = loaded ? loaded.seed : env.MISSION_XRPL_SEED;
  const expected = (loaded && loaded.address) || env.MISSION_XRPL_ADDRESS;
  let wallet;
  try {
    wallet = options.openWallet ? options.openWallet(seed) : xrpl.Wallet.fromSeed(seed);
  } catch (error) {
    if (error && error.code) throw error;
    throw coded("MISSION_XRPL_SEED is not a usable seed", "NO_SEED");
  }
  const classic = wallet.classicAddress || wallet.address;
  if (classic !== expected) throw coded("isolated key does not match MISSION_XRPL_ADDRESS", "WALLET");
  const account = options.validatedAccount
    || await ledgerWindow.readValidatedAccount(options.fetch || globalThis.fetch, tx.Account);
  const fields = ledgerWindow.assertPrepared(tx, account);
  if (options.submit) return options.submit(tx, { classicAddress: classic, sign: (body) => wallet.sign(body) });
  const ws = assertWs(env.FOUNDRY_MISSION_XRPL_WS);
  const client = options.client || new xrpl.Client(ws);
  try {
    await client.connect();
    const prepared = await client.autofill(tx);
    if (
      prepared.Sequence !== fields.Sequence
      || prepared.LastLedgerSequence !== fields.LastLedgerSequence
      || prepared.NetworkID != null
    ) {
      throw coded("autofill changed the bounded payment", "LEDGER");
    }
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
  if (options.io && options.io.readFileSync) throw coded("mission signer does not read a secrets file", "SEED");
  if (!source.FOUNDRY_MISSION_LEDGER) throw coded("mission signer has no ledger claim", "CLAIM");
  if (!signerArmed(source)) throw coded("MISSION_XRPL_SEED is not loaded. Refusing to sign.", "NO_SEED");
  if (body.presign === true) {
    const signed = await signOnly(body.tx, source, options);
    notePresign(source.FOUNDRY_MISSION_LEDGER, body.mission_id, signed.hash, { tx: body.tx });
    return {
      dry_run: false,
      presigned: true,
      intent: "mission_spend",
      key_loaded: true,
      signed: true,
      submitted: false,
      live: false,
      network_id: 1,
      hash: signed.hash,
      tx_blob: signed.tx_blob,
    };
  }
  acceptClaim(source.FOUNDRY_MISSION_LEDGER, body.mission_id, body.tx);
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
  accountFile,
  signerArmed,
  health,
  evaluate,
  startServer,
};
