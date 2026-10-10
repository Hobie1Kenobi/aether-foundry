#!/usr/bin/env node
"use strict";

/**
 * Herald watches W3 for net-chat frames and appends lab/peers logs.
 * Default is observe. Live ack/accept posts to the localhost signer.
 *
 *   npm run peers:herald -- --dry
 *   npm run peers:herald -- --fixture src/fixtures/agent-chat-account-tx.json --dry
 *   npm run peers:herald
 *   AETHER_NET_CHAT_LIVE=yes FOUNDRY_AGENT_SIGN=yes npm run peers:herald -- --live-ack
 */

const fs = require("fs");
const path = require("path");
const hosts = require("../xrpl-hosts");
const peerHello = require("../peer-hello");
const protocol = require("./protocol");
const signerPost = require("./signer-post");

const TX_LIMIT = peerHello.TX_LIMIT;
const TX_LIMIT_MAX = peerHello.TX_LIMIT_MAX;

const HELP = `Usage: node src/agent-chat/herald.js [--observe] [--live-ack] [--dry] [--record] [--quiet] [--root DIR] [--rpc URL] [--fixture FILE] [--limit N]

Reads one validated account_tx page for W3 on XRPL Testnet (network id 1).
Appends hello, ack, offer, accept, and close frames to lab/peers/frames.jsonl
and session rows to lab/peers/sessions.jsonl.
--observe is the default. It does not sign.
--fixture reads a local page and stays dry unless --record. Fixture hashes are synthetic.
--live-ack requires FOUNDRY_AGENT_SIGN=yes and AETHER_NET_CHAT_LIVE=yes, plus a signer on 127.0.0.1.
It refuses CI, GITHUB_ACTIONS, and VERCEL. It archives a reply only after tesSUCCESS.`;

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function peersDir(root) {
  return path.join(root, "lab", "peers");
}

function framesPath(root) {
  return path.join(peersDir(root), "frames.jsonl");
}

function sessionsPath(root) {
  return path.join(peersDir(root), "sessions.jsonl");
}

function need(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const out = {
    observe: true,
    liveAck: false,
    dry: false,
    record: false,
    quiet: false,
    root: null,
    rpc: null,
    fixture: null,
    limit: TX_LIMIT,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--observe") out.observe = true;
    else if (arg === "--live-ack") out.liveAck = true;
    else if (arg === "--dry") out.dry = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--quiet" || arg === "-q") out.quiet = true;
    else if (arg === "--root") {
      out.root = need(args, i + 1, "--root");
      i += 1;
    } else if (arg === "--rpc") {
      out.rpc = need(args, i + 1, "--rpc");
      i += 1;
    } else if (arg === "--fixture") {
      out.fixture = need(args, i + 1, "--fixture");
      i += 1;
    } else if (arg === "--limit") {
      const raw = need(args, i + 1, "--limit");
      i += 1;
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > TX_LIMIT_MAX) {
        throw new Error(`--limit must be an integer from 1 to ${TX_LIMIT_MAX}`);
      }
      out.limit = limit;
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown arg ${arg}`);
  }
  return out;
}

function stamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
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
      /* skip a torn line */
    }
  }
  return rows;
}

function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = "";
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.length && !cur.endsWith("\n")) prefix = "\n";
  }
  fs.appendFileSync(file, prefix + rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function frameLine(frame, now) {
  return {
    network: protocol.NETWORK,
    hash: frame.hash,
    ledger: frame.ledger,
    account: frame.account,
    destination: frame.destination,
    peer: frame.peer,
    t: frame.t,
    body: frame.body,
    legacy: frame.legacy === true,
    synthetic: frame.synthetic === true,
    ledger_claim: frame.ledger_claim === true,
    seen_at: stamp(now),
  };
}

function sessionLine(frame, now) {
  const row = protocol.sessionEvent(frame);
  row.seen_at = stamp(now);
  return row;
}

function archiveNew(file, rows, keyFn) {
  const seen = new Set(readJsonl(file).map(keyFn));
  const fresh = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    fresh.push(row);
    seen.add(key);
  }
  appendJsonl(file, fresh);
  return fresh;
}

function archiveFrames(file, frames, now) {
  const lines = frames.map((frame) => frameLine(frame, now));
  return archiveNew(file, lines, (row) => String(row.hash || "").toUpperCase());
}

function archiveSessions(file, frames, now) {
  const lines = frames.map((frame) => sessionLine(frame, now));
  return archiveNew(file, lines, (row) => `${String(row.hash || "").toUpperCase()}:${row.state}`);
}

function loadFixturePage(file) {
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  const transactions = Array.isArray(body)
    ? body
    : body && Array.isArray(body.transactions)
      ? body.transactions
      : body && body.result && Array.isArray(body.result.transactions)
        ? body.result.transactions
        : null;
  if (!transactions) throw new Error("fixture has no transactions array");
  return { transactions, synthetic: true };
}

function scribeEp(env) {
  const raw = (env && (env.AETHER_SCRIBE_EP || env.AETHER_SCRIBE_URL)) || protocol.SCRIBE_URL;
  return protocol.validateEnvelope({
    v: 1,
    t: protocol.ACK,
    from: protocol.HERALD_ID,
    net: protocol.NETWORK,
    nonce: "epcheck01",
    session: "s_0000000000000001",
    challenge: "0123456789abcdef",
    ep: raw,
    hello_hash: protocol.syntheticHash("0"),
  }).ep;
}

function planReplies(frames) {
  const list = frames.slice().sort((a, b) => (a.ledger || 0) - (b.ledger || 0));
  const acked = new Set();
  const accepted = new Set();
  for (const frame of list) {
    const body = frame.body || {};
    if (frame.t === protocol.ACK && body.hello_hash) acked.add(String(body.hello_hash).toUpperCase());
    if (frame.t === protocol.ACCEPT && body.offer_hash) accepted.add(String(body.offer_hash).toUpperCase());
  }
  const replies = [];
  for (const frame of list) {
    if (frame.synthetic === true || frame.ledger_claim === false) continue;
    if (frame.t === protocol.HELLO && !acked.has(frame.hash)) {
      replies.push({ kind: "ack", frame });
    } else if (frame.t === protocol.OFFER && !accepted.has(frame.hash)) {
      const session = frame.body && frame.body.session;
      const ack = list.find((row) => row.t === protocol.ACK && row.body && row.body.session === session);
      if (!ack || ack.destination !== frame.account) continue;
      replies.push({ kind: "accept", frame, ack });
    }
  }
  return replies;
}

function buildReply(kind, frame, env, ids) {
  const ep = scribeEp(env);
  if (kind === "ack") {
    return protocol.validateEnvelope({
      v: 1,
      t: protocol.ACK,
      from: protocol.HERALD_ID,
      net: protocol.NETWORK,
      nonce: ids.nonce(),
      session: ids.sessionId(),
      challenge: ids.nonce(8).slice(0, 16),
      ep,
      hello_hash: frame.hash,
    });
  }
  return protocol.validateEnvelope({
    v: 1,
    t: protocol.ACCEPT,
    from: protocol.HERALD_ID,
    net: protocol.NETWORK,
    nonce: ids.nonce(),
    session: frame.body.session,
    ep,
    ttl: 900,
    chat_nonce: ids.nonce(8),
    offer_hash: frame.hash,
  });
}

async function submitReply(env, body, destination, fetchImpl) {
  const tx = protocol.paymentTx({
    account: protocol.W3,
    destination,
    body,
  });
  const submitted = await signerPost.postSign(env, {
    wallet: protocol.HERALD_WALLET,
    intent: body.t,
    tx,
  }, fetchImpl);
  return {
    network: protocol.NETWORK,
    hash: submitted.hash,
    ledger: submitted.ledger_index,
    account: protocol.W3,
    destination,
    peer: destination,
    amount: protocol.DROP,
    t: body.t,
    body,
    legacy: false,
    synthetic: false,
    ledger_claim: true,
  };
}

async function run(argv, io) {
  const log = (io && io.log) || console.log;
  const error = (io && io.error) || console.error;
  const env = (io && io.env) || process.env;
  let args;
  try {
    args = parseArgs(Array.isArray(argv) ? argv : []);
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }
  if (args.help) {
    log(HELP);
    return 0;
  }
  if (args.dry && args.record) {
    error("pass only one of --dry or --record");
    return 1;
  }
  if (args.liveAck && (args.dry || args.fixture)) {
    error("refusing --live-ack with --dry or --fixture");
    return 1;
  }

  const root = path.resolve(args.root || repoRoot());
  const now = io && io.now ? io.now() : new Date();
  let entries;
  let synthetic = false;
  try {
    if (args.fixture) {
      const page = loadFixturePage(path.resolve(args.fixture));
      entries = page.transactions;
      synthetic = true;
    } else {
      const preferred = peerHello.assertTestnetUrl(args.rpc || hosts.resolveHttp(env));
      const fetchImpl = (io && io.fetchImpl) || globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error("no fetch implementation");
      entries = await hosts.withFailover(preferred, async (url) => {
        const rpc = peerHello.assertTestnetUrl(url);
        const info = await peerHelloRpc(rpc, "server_info", {}, fetchImpl);
        const networkId = info.info && info.info.network_id;
        peerHello.assertNetworkId(networkId);
        const page = await peerHelloRpc(rpc, "account_tx", peerHello.accountTxParams(args.limit), fetchImpl);
        if (page.validated === false) throw new Error("account_tx was not validated");
        return Array.isArray(page.transactions) ? page.transactions : [];
      });
    }
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }

  const found = protocol.collectFrames(entries, { synthetic, limit: args.limit });
  const write = Boolean(args.record || (!args.fixture && !args.dry));
  const framesFile = framesPath(root);
  const sessionsFile = sessionsPath(root);
  let freshFrames = [];
  let freshSessions = [];
  if (write) {
    freshFrames = archiveFrames(framesFile, found, now);
    freshSessions = archiveSessions(sessionsFile, found, now);
  } else {
    const seenF = new Set(readJsonl(framesFile).map((row) => String(row.hash || "").toUpperCase()));
    freshFrames = found.filter((frame) => !seenF.has(frame.hash)).map((frame) => frameLine(frame, now));
    const seenS = new Set(readJsonl(sessionsFile).map((row) => `${String(row.hash || "").toUpperCase()}:${row.state}`));
    freshSessions = found
      .map((frame) => sessionLine(frame, now))
      .filter((row) => !seenS.has(`${row.hash}:${row.state}`));
  }

  let liveFrames = [];
  if (args.liveAck) {
    try {
      signerPost.assertLiveEnv(env);
      const known = readJsonl(framesFile).map(lineToFrame);
      const replies = planReplies(known);
      const fetchImpl = (io && io.fetchImpl) || globalThis.fetch;
      const ids = {
        nonce: (io && io.nonce) || protocol.nonce,
        sessionId: (io && io.sessionId) || protocol.sessionId,
      };
      for (const reply of replies) {
        const body = buildReply(reply.kind, reply.frame, env, ids);
        const frame = await submitReply(env, body, reply.frame.peer, fetchImpl);
        liveFrames.push(frame);
        archiveFrames(framesFile, [frame], now);
        archiveSessions(sessionsFile, [frame], now);
      }
    } catch (err) {
      error(err.message || String(err));
      return 1;
    }
  }

  if (!args.quiet) {
    log(
      `herald scanned=${Math.min(entries.length, args.limit)} matched=${found.length} new_frames=${freshFrames.length} new_sessions=${freshSessions.length} write=${write ? "yes" : "no"} mode=${args.liveAck ? "live-ack" : "observe"}`
    );
    if (!write) {
      for (const row of freshFrames) log(JSON.stringify(row));
    }
    if (liveFrames.length) {
      log(`herald signed=${liveFrames.length}`);
      for (const frame of liveFrames) log(JSON.stringify({ t: frame.t, hash: frame.hash, ledger_claim: true }));
    }
  }
  return 0;
}

function lineToFrame(row) {
  if (!row || typeof row !== "object") return null;
  return {
    hash: String(row.hash || "").toUpperCase(),
    ledger: row.ledger,
    account: row.account,
    destination: row.destination,
    peer: row.peer,
    t: row.t,
    body: row.body,
    synthetic: row.synthetic === true,
    ledger_claim: row.ledger_claim === true,
  };
}

async function peerHelloRpc(http, method, params, fetchImpl) {
  const response = await fetchImpl(http, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  const body = await response.json();
  const result = (body && body.result) || body || {};
  if (result.error) throw new Error(result.error_message || result.error);
  return result;
}

module.exports = {
  HELP,
  TX_LIMIT,
  parseArgs,
  framesPath,
  sessionsPath,
  readJsonl,
  archiveFrames,
  archiveSessions,
  loadFixturePage,
  planReplies,
  buildReply,
  submitReply,
  frameLine,
  sessionLine,
  run,
};

if (require.main === module) {
  run(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
