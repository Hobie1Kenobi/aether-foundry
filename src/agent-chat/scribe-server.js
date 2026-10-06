#!/usr/bin/env node
"use strict";

/**
 * Off-ledger speech for an accepted net-chat session.
 * Binds 127.0.0.1. Does not sign and does not submit.
 *
 *   AETHER_SCRIBE_MOCK=1 node src/agent-chat/scribe-server.js
 *   OLLAMA_API_KEY=... npm run peers:scribe
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const protocol = require("./protocol");
const ollama = require("./ollama");
const signerPost = require("./signer-post");

const TOKEN_TTL_MS = 15 * 60 * 1000;
const HELP = `Usage: node src/agent-chat/scribe-server.js [--port N] [--root DIR]

Listens on 127.0.0.1:8791 unless AETHER_SCRIBE_PORT is set.
GET /health is free. POST /v1/session/open requires an accepted session.
POST /v1/chat requires the bearer token from open.
AETHER_SCRIBE_MOCK=1 returns canned replies. CI always mocks.
OLLAMA_BASE_URL defaults to https://ollama.com. OLLAMA_MODEL defaults to glm-5.3-flash.`;

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function assertBind(host) {
  const value = String(host == null || host === "" ? "127.0.0.1" : host).trim().toLowerCase();
  if (value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  throw protocol.coded("refusing non-loopback scribe bind");
}

function assertPort(raw) {
  const port = Number(raw == null || raw === "" ? protocol.SCRIBE_PORT : raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw protocol.coded("refusing scribe port");
  return port;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function findOpenSession(rows, query) {
  const session = query && query.session;
  const peer = query && query.peer;
  const acceptHash = String((query && query.accept_hash) || "").toUpperCase();
  if (!protocol.SESSION_RE.test(String(session || ""))) return null;
  if (!protocol.isClassic(peer)) return null;
  if (!protocol.HASH_RE.test(acceptHash)) return null;
  const related = (rows || []).filter((row) => row && row.session === session && row.network === protocol.NETWORK);
  if (related.some((row) => row.state === "closed")) return null;
  const opened = related.find((row) => row.state === "open" && String(row.hash || "").toUpperCase() === acceptHash);
  if (!opened) return null;
  if (opened.peer !== peer) return null;
  return opened;
}

function chatFile(dir, session) {
  if (!protocol.SESSION_RE.test(session)) throw protocol.coded("refusing session");
  return path.join(dir, `${session}.jsonl`);
}

function appendTurn(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function publicSessions(rows, chatsDir) {
  const byId = new Map();
  for (const row of rows || []) {
    if (!row || !row.session || row.network !== protocol.NETWORK) continue;
    const prev = byId.get(row.session) || { session: row.session, state: row.state, peer: row.peer };
    prev.state = row.state || prev.state;
    if (row.peer) prev.peer = row.peer;
    if (row.topic) prev.topic = row.topic;
    byId.set(row.session, prev);
  }
  return [...byId.values()].map((row) => {
    const file = chatsDir && protocol.SESSION_RE.test(row.session) ? chatFile(chatsDir, row.session) : "";
    const turns = file && fs.existsSync(file) ? readJsonl(file).length : 0;
    return {
      session: row.session,
      state: row.state,
      peer: row.peer,
      topic: row.topic || null,
      turns,
      network: protocol.NETWORK,
    };
  });
}

function createState(opts) {
  const options = opts || {};
  const env = options.env || process.env;
  const root = options.root || repoRoot();
  return {
    env,
    root,
    sessionsFile: options.sessionsFile || path.join(root, "lab", "peers", "sessions.jsonl"),
    chatsDir: options.chatsDir || path.join(root, "lab", "peers", "chats"),
    tokens: new Map(),
    fetchImpl: options.fetchImpl || globalThis.fetch,
    now: options.now || (() => new Date()),
  };
}

function issueToken(state, session) {
  const token = crypto.randomBytes(24).toString("base64url");
  const exp = state.now().getTime() + TOKEN_TTL_MS;
  state.tokens.set(token, { session, exp });
  return { chat_token: token, token_type: "bearer", expires_in: Math.floor(TOKEN_TTL_MS / 1000), session };
}

function tokenSession(state, header) {
  const match = String(header || "").match(/^Bearer\s+(\S+)\s*$/);
  if (!match) return null;
  const row = state.tokens.get(match[1]);
  if (!row) return null;
  if (row.exp <= state.now().getTime()) {
    state.tokens.delete(match[1]);
    return null;
  }
  return row.session;
}

async function replyText(state, message, priorRows) {
  const prior = Array.isArray(priorRows) ? priorRows : [];
  if (ollama.mockForced(state.env)) {
    const index = prior.filter((row) => row && row.role === "scout").length;
    return protocol.mockReply(message, index);
  }
  const messages = [
    { role: "system", content: protocol.SCRIBE_SYSTEM },
    ...prior.filter((row) => row && row.text).map((row) => ({
      role: row.role === "scribe" ? "assistant" : "user",
      content: String(row.text),
    })),
    { role: "user", content: message },
  ];
  return ollama.ollamaChat({ env: state.env, messages, fetchImpl: state.fetchImpl });
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
        reject(protocol.coded("body too large"));
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
        reject(protocol.coded("body is not JSON"));
      }
    });
    req.on("error", () => reject(protocol.coded("body unreadable")));
  });
}

async function handle(req, res, state) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      protocol: protocol.VERSION,
      agent: protocol.SCRIBE_ID,
      network: protocol.NETWORK,
      mock: ollama.mockForced(state.env),
      model: ollama.ollamaModel(state.env),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/sessions") {
    const rows = readJsonl(state.sessionsFile);
    send(res, 200, { network: protocol.NETWORK, sessions: publicSessions(rows, state.chatsDir) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/session/open") {
    const body = await readBody(req);
    const opened = findOpenSession(readJsonl(state.sessionsFile), body);
    if (!opened) {
      send(res, 403, { error: "session is not accepted", network: protocol.NETWORK });
      return;
    }
    if (opened.synthetic === true && !ollama.mockForced(state.env)) {
      send(res, 403, { error: "refusing a synthetic accept", network: protocol.NETWORK });
      return;
    }
    const issued = issueToken(state, opened.session);
    send(res, 200, Object.assign({ network: protocol.NETWORK }, issued));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat") {
    const session = tokenSession(state, req.headers && (req.headers.authorization || req.headers.Authorization));
    if (!session) {
      send(res, 401, { error: "bearer token required" });
      return;
    }
    const body = await readBody(req);
    const message = body && typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 2000) {
      send(res, 400, { error: "message is required" });
      return;
    }
    const file = chatFile(state.chatsDir, session);
    const priorRows = readJsonl(file);
    const ts = state.now().toISOString().replace(/\.\d{3}Z$/, "Z");
    appendTurn(file, { ts, role: "scout", text: message, network: protocol.NETWORK });
    let answer;
    try {
      answer = await replyText(state, message, priorRows);
    } catch (err) {
      const key = state.env && state.env.OLLAMA_API_KEY;
      send(res, 502, { error: signerPost.redact(err.message || "scribe failed", [key]) });
      return;
    }
    appendTurn(file, {
      ts,
      role: "scribe",
      text: answer,
      network: protocol.NETWORK,
      mock: ollama.mockForced(state.env),
    });
    send(res, 200, { session, role: "scribe", message: answer, network: protocol.NETWORK });
    return;
  }
  send(res, 404, { error: "not found" });
}

function startScribe(opts) {
  const state = createState(opts);
  const host = assertBind(opts && opts.host);
  const port = assertPort(opts && opts.port != null ? opts.port : (state.env.AETHER_SCRIBE_PORT || protocol.SCRIBE_PORT));
  const server = http.createServer((req, res) => {
    handle(req, res, state).catch((err) => {
      if (res.headersSent) return;
      send(res, 500, { error: err && err.message ? err.message : "scribe failed" });
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
  const args = argv.slice(2);
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
  const args = parseArgs(Array.isArray(argv) ? argv : []);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const started = await startScribe({
    port: args.port,
    root: args.root ? path.resolve(args.root) : repoRoot(),
    env: process.env,
  });
  console.log(`scribe listening ${started.url} mock=${ollama.mockForced(process.env) ? "yes" : "no"} network=${protocol.NETWORK}`);
  return 0;
}

module.exports = {
  HELP,
  TOKEN_TTL_MS,
  assertBind,
  findOpenSession,
  publicSessions,
  createState,
  startScribe,
  handle,
  main,
};

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
