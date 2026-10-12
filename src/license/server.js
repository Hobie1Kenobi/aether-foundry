#!/usr/bin/env node
"use strict";

/**
 * Loopback redeem endpoint. Does not sign and does not submit.
 *
 *   node src/license/server.js [--port N] [--root DIR]
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const anchors = require("../director/anchors");
const redeemHandler = require("./redeem");
const catalog = require("./catalog");

const HELP = `Usage: node src/license/server.js [--port N] [--root DIR]

Listens on 127.0.0.1:8793 unless AETHER_LICENSE_PORT is set.
Scribe uses 8792 on the Foundry box. Do not bind the redeem server there.
POST /v1/license/challenge issues a nonce. POST /v1/license/redeem verifies it.
This process never loads a seed.`;

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function assertBind(host) {
  const value = String(host == null || host === "" ? "127.0.0.1" : host).trim().toLowerCase();
  if (value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  throw catalog.coded("refusing non-loopback license bind", "BIND");
}

const DEFAULT_PORT = 8793;

function assertPort(raw) {
  const port = Number(raw == null || raw === "" ? DEFAULT_PORT : raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw catalog.coded("refusing license port", "BIND");
  }
  return port;
}

function statusFor(code) {
  if (code === "REPLAY" || code === "USED_UP") return 409;
  if (code === "HOLDER" || code === "MAINNET" || code === "BIND") return 403;
  if (code === "SIGNATURE") return 401;
  if (code === "RPC") return 503;
  return 400;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  if (/sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "refusing to print a seed" }));
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        reject(catalog.coded("body too large", "TX"));
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
        reject(catalog.coded("body is not JSON", "TX"));
      }
    });
    req.on("error", () => reject(catalog.coded("body unreadable", "TX")));
  });
}

function activatedRoot(root) {
  const file = path.join(root, "machines", "governance-board", "activated.json");
  if (root && fs.existsSync(file)) return root;
  return anchors.repoRoot();
}

function createState(opts) {
  const options = opts || {};
  const root = options.root || repoRoot();
  return {
    root,
    now: options.now || (() => new Date()),
    nonces: new Set(),
    allowDrySignature: options.allowDrySignature === true,
    regularKeys: options.regularKeys || anchors.loadActivated(activatedRoot(root)).regular_keys,
    accountNfts: options.accountNfts,
    nfts: options.nfts,
    accountInfo: options.accountInfo,
    accountObjects: options.accountObjects,
    ledgerIndex: options.ledgerIndex,
    readAccount: options.readAccount,
    scribe: options.scribe,
    scribeUrl: options.scribeUrl,
    fetchImpl: options.fetchImpl,
  };
}

async function dispatch(body, state, pathname) {
  if (pathname === "/v1/license/challenge") {
    return {
      status: 200,
      body: await redeemHandler.issueChallenge({
        account: body.account,
        nftokenId: body.nftoken_id || body.nftokenId,
        job: body.job || body.job_type,
        now: state.now(),
      }),
    };
  }
  if (pathname === "/v1/license/redeem") {
    const result = await redeemHandler.redeem({
      root: state.root,
      now: state.now(),
      nonces: state.nonces,
      allowDrySignature: state.allowDrySignature,
      regularKeys: state.regularKeys,
      account: body.account,
      nftokenId: body.nftoken_id || body.nftokenId,
      challenge: body.challenge,
      signature: body.signature,
      publicKey: body.public_key || body.publicKey,
      accountNfts: state.accountNfts,
      nfts: state.nfts,
      accountInfo: state.accountInfo,
      accountObjects: state.accountObjects,
      ledgerIndex: state.ledgerIndex,
      readAccount: state.readAccount,
      scribe: state.scribe,
      scribeUrl: state.scribeUrl,
      fetchImpl: state.fetchImpl,
    });
    return {
      status: 200,
      body: {
        ok: true,
        network_id: 1,
        nftoken_id: result.receipt.nftoken_id,
        job_type: result.receipt.job_type,
        uses_consumed: result.uses_consumed,
        uses_allowed: result.uses_allowed,
        summary: result.summary,
        summary_source: result.summary_source,
        report: result.report,
        settle: result.settle,
        burn_tx: result.burn_tx,
      },
    };
  }
  return { status: 404, body: { error: "not found" } };
}

function startServer(opts) {
  const options = opts || {};
  const state = createState(options);
  const host = assertBind(options.host);
  const port = assertPort(options.port != null ? options.port : (options.env || process.env).AETHER_LICENSE_PORT);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, machine: "agent-work-license", network_id: 1, signing: false });
      return;
    }
    if (req.method !== "POST") {
      send(res, 404, { error: "not found" });
      return;
    }
    readBody(req)
      .then((body) => dispatch(body, state, url.pathname))
      .then((out) => send(res, out.status, out.body))
      .catch((error) => {
        const code = error && error.code ? error.code : "TX";
        send(res, statusFor(code), { error: error && error.message ? error.message : "redeem failed", code });
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        state,
        port: bound,
        url: `http://127.0.0.1:${bound}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function parseArgs(argv) {
  const out = { help: false, port: null, root: null };
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--port") {
      out.port = args[i + 1];
      i += 1;
    } else if (arg === "--root") {
      out.root = args[i + 1];
      i += 1;
    } else throw new Error(`unknown arg ${arg}`);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const started = await startServer({
    port: args.port,
    root: args.root ? path.resolve(args.root) : repoRoot(),
  });
  console.log(`license redeem listening ${started.url} network_id=1 signing=no`);
  return 0;
}

module.exports = {
  HELP,
  DEFAULT_PORT,
  assertBind,
  assertPort,
  startServer,
  createState,
  dispatch,
  main,
};

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
