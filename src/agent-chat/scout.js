#!/usr/bin/env node
"use strict";

/**
 * Scout opens a net-chat session as W5 (R&D) and talks to Scribe.
 * W5 already sends 1-drop memos to W3. W4 stays the escrow bond.
 * Seeds stay in the operator env. This file does not read them.
 * The localhost signer does, and only when --live is gated.
 *
 *   npm run peers:scout -- --dry
 *   npm run peers:scout -- --sim
 *   AETHER_NET_CHAT_LIVE=yes FOUNDRY_AGENT_SIGN=yes npm run peers:scout -- --live
 */

const fs = require("fs");
const path = require("path");
const hosts = require("../xrpl-hosts");
const protocol = require("./protocol");
const herald = require("./herald");
const scribe = require("./scribe-server");
const ollama = require("./ollama");
const signerPost = require("./signer-post");
const peerHello = require("../peer-hello");

const HELP = `Usage: node src/agent-chat/scout.js [--dry] [--sim] [--live] [--root DIR] [--out DIR] [--scribe URL]

--dry prints unsigned hello and offer Payments. It does not sign.
--sim runs the hello → ack → offer → accept → chat → close loop on synthetic hashes.
--live posts hello and offer through the localhost signer as W5, then polls W3.
Live requires FOUNDRY_AGENT_SIGN=yes, AETHER_NET_CHAT_LIVE=yes, and refuses CI and Vercel.
W5 is the scout because R&D already pays 1-drop memos to W3. W4 remains escrow.`;

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function need(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const out = {
    dry: false,
    sim: false,
    live: false,
    root: null,
    out: null,
    scribe: null,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry") out.dry = true;
    else if (arg === "--sim") out.sim = true;
    else if (arg === "--live") out.live = true;
    else if (arg === "--root") {
      out.root = need(args, i + 1, "--root");
      i += 1;
    } else if (arg === "--out") {
      out.out = need(args, i + 1, "--out");
      i += 1;
    } else if (arg === "--scribe") {
      out.scribe = need(args, i + 1, "--scribe");
      i += 1;
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown arg ${arg}`);
  }
  const modes = [out.dry, out.sim, out.live].filter(Boolean).length;
  if (!modes) out.dry = true;
  if (modes > 1) throw new Error("pass only one of --dry, --sim, or --live");
  return out;
}

function stamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runId(date) {
  return stamp(date).replace(/:/g, "-");
}

function helloBody(nonce) {
  return protocol.validateEnvelope({
    v: 1,
    t: protocol.HELLO,
    from: protocol.SCOUT_ID,
    net: protocol.NETWORK,
    nonce,
    repo: "https://github.com/Hobie1Kenobi/aether-foundry",
    x402: "https://aether-foundry-desk.vercel.app/api/x402",
  });
}

function offerBody(session, ackHash, nonce) {
  return protocol.validateEnvelope({
    v: 1,
    t: protocol.OFFER,
    from: protocol.SCOUT_ID,
    net: protocol.NETWORK,
    nonce,
    session,
    topic: "discover-foundry",
    max_drops: 10,
    tools: ["chat"],
    ack_hash: ackHash,
  });
}

function closeBody(session, transcriptHash, nonce) {
  return protocol.validateEnvelope({
    v: 1,
    t: protocol.CLOSE,
    from: protocol.SCOUT_ID,
    net: protocol.NETWORK,
    nonce,
    session,
    reason: "done",
    transcript_sha256: transcriptHash,
  });
}

function unsignedPair(ids) {
  const hello = helloBody(ids.nonce());
  const ackHash = protocol.syntheticHash("2");
  const offer = offerBody("s_0000000000000002", ackHash, ids.nonce());
  return {
    network: protocol.NETWORK,
    wallet: protocol.SCOUT_WALLET,
    account: protocol.W5,
    destination: protocol.W3,
    signed: false,
    submitted: false,
    key_loaded: false,
    hello: protocol.paymentTx({ account: protocol.W5, destination: protocol.W3, body: hello }),
    offer: protocol.paymentTx({ account: protocol.W5, destination: protocol.W3, body: offer }),
    note: "Unsigned. --dry does not call the signer. The offer session id is a placeholder until an ack arrives.",
  };
}

function entryFor(hash, ledger, account, destination, body) {
  return {
    synthetic: true,
    hash,
    ledger_index: ledger,
    validated: true,
    meta: { TransactionResult: "tesSUCCESS" },
    tx_json: protocol.paymentTx({ account, destination, body }),
  };
}

function simBundle(ids, ep) {
  const helloHash = protocol.syntheticHash("1");
  const ackHash = protocol.syntheticHash("2");
  const offerHash = protocol.syntheticHash("3");
  const acceptHash = protocol.syntheticHash("4");
  const session = ids.session || "s_a11ce00000000001";
  const hello = helloBody(ids.helloNonce || "simnonce01");
  const ack = protocol.validateEnvelope({
    v: 1,
    t: protocol.ACK,
    from: protocol.HERALD_ID,
    net: protocol.NETWORK,
    nonce: ids.ackNonce || "simnonce02",
    session,
    challenge: "abcdef0123456789",
    ep,
    hello_hash: helloHash,
  });
  const offer = offerBody(session, ackHash, ids.offerNonce || "simnonce03");
  const accept = protocol.validateEnvelope({
    v: 1,
    t: protocol.ACCEPT,
    from: protocol.HERALD_ID,
    net: protocol.NETWORK,
    nonce: ids.acceptNonce || "simnonce04",
    session,
    ep,
    ttl: 900,
    chat_nonce: "fedcba9876543210",
    offer_hash: offerHash,
  });
  return {
    session,
    helloHash,
    ackHash,
    offerHash,
    acceptHash,
    hello,
    ack,
    offer,
    accept,
    entries: [
      entryFor(helloHash, 91001, protocol.W5, protocol.W3, hello),
      entryFor(ackHash, 91002, protocol.W3, protocol.W5, ack),
      entryFor(offerHash, 91003, protocol.W5, protocol.W3, offer),
      entryFor(acceptHash, 91004, protocol.W3, protocol.W5, accept),
    ],
  };
}

async function scoutLines(env, fetchImpl) {
  if (ollama.mockForced(env) || !(env && env.OLLAMA_API_KEY)) return protocol.SCOUT_TURNS.slice();
  const prompts = [
    "Introduce yourself as a curious XRPL Testnet peer and ask what Aether Foundry is. One or two sentences. Do not ask for secrets.",
    "Ask how to open a session with a 1-drop memo on xrpl:1. One or two sentences.",
    "Say you will stay on Testnet and will not send a seed. One sentence.",
  ];
  const lines = [];
  for (const prompt of prompts) {
    const text = await ollama.ollamaChat({
      env,
      fetchImpl,
      messages: [
        { role: "system", content: protocol.SCOUT_SYSTEM },
        { role: "user", content: prompt },
      ],
    });
    lines.push(text);
  }
  return lines;
}

async function postJson(url, body, headers, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", accept: "application/json" }, headers || {}),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "not JSON" };
  }
  if (!response.ok) {
    throw protocol.coded(parsed.error || `scribe HTTP ${response.status}`);
  }
  return parsed;
}

async function chatLoop(opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const opened = await postJson(`${opts.scribeUrl}/v1/session/open`, {
    session: opts.session,
    peer: opts.peer,
    accept_hash: opts.acceptHash,
  }, {}, fetchImpl);
  if (!opened.chat_token) throw protocol.coded("scribe did not issue a chat token");
  const lines = opts.lines || protocol.SCOUT_TURNS;
  const turns = [];
  for (const line of lines) {
    const reply = await postJson(`${opts.scribeUrl}/v1/chat`, { message: line }, {
      authorization: `Bearer ${opened.chat_token}`,
    }, fetchImpl);
    turns.push({ role: "scout", text: line });
    turns.push({ role: "scribe", text: reply.message });
  }
  return { turns, transcript_sha256: protocol.transcriptSha256(turns) };
}

function writeDemo(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const transcript = doc.turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), transcript);
  const md = doc.turns.map((turn) => `## ${turn.role}\n\n${turn.text}\n`).join("\n");
  fs.writeFileSync(path.join(dir, "transcript.md"), md);
  fs.writeFileSync(path.join(dir, "frames.json"), `${JSON.stringify(doc.frames, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(doc.meta, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "README.md"), doc.readme);
  return dir;
}

function demoReadme(meta) {
  return [
    "# Net chat sim",
    "",
    "Zero-chain run of hello, ack, offer, accept, three chat turns, and close.",
    "Every hash below is synthetic. None of them are ledger claims.",
    "",
    `- Network: ${meta.network}`,
    `- Scout wallet: ${meta.scout_wallet} ${meta.scout_address}`,
    `- Herald inbox: W3 ${meta.w3}`,
    `- Scribe: ${meta.scribe}`,
    `- Session: ${meta.session}`,
    `- Transcript sha256: ${meta.transcript_sha256}`,
    "",
    "Live hashes appear only after a signer returns tesSUCCESS. This folder is not that.",
    "",
  ].join("\n");
}

async function runSim(opts) {
  const options = opts || {};
  const env = Object.assign({}, options.env || {});
  if (options.mock === true) env.AETHER_SCRIBE_MOCK = "1";
  const now = options.now ? options.now() : new Date();
  const root = options.root || repoRoot();
  const dir = options.outDir || path.join(root, "lab", "peers", "demo", runId(now));
  fs.mkdirSync(dir, { recursive: true });
  const sessionsFile = path.join(dir, "sessions.jsonl");
  const framesFile = path.join(dir, "frames.jsonl");
  const chatsDir = path.join(dir, "chats");
  const started = await scribe.startScribe({
    host: "127.0.0.1",
    port: 0,
    env,
    root: dir,
    sessionsFile,
    chatsDir,
    fetchImpl: options.fetchImpl,
    now: options.now || (() => now),
  });
  try {
    const bundle = simBundle({ session: options.session }, started.url);
    const frames = protocol.collectFrames(bundle.entries, { synthetic: true });
    herald.archiveFrames(framesFile, frames, now);
    herald.archiveSessions(sessionsFile, frames, now);
    const lines = await scoutLines(env, options.fetchImpl || started.state.fetchImpl);
    const chat = await chatLoop({
      scribeUrl: started.url,
      session: bundle.session,
      peer: protocol.W5,
      acceptHash: bundle.acceptHash,
      lines,
      fetchImpl: globalThis.fetch,
    });
    const closeHash = protocol.syntheticHash("5");
    const close = closeBody(bundle.session, chat.transcript_sha256, "simnonce05");
    const closeEntry = entryFor(closeHash, 91005, protocol.W5, protocol.W3, close);
    const closeFrame = protocol.collectFrames([closeEntry], { synthetic: true })[0];
    herald.archiveFrames(framesFile, [closeFrame], now);
    herald.archiveSessions(sessionsFile, [closeFrame], now);
    const all = herald.readJsonl(framesFile);
    const meta = {
      schema: "aether-foundry/net-chat-demo@1",
      mode: "sim",
      synthetic: true,
      ledger_claim: false,
      network: protocol.NETWORK,
      scribe: ollama.mockForced(env) ? "mock" : ollama.ollamaModel(env),
      model: ollama.mockForced(env) ? "mock" : ollama.ollamaModel(env),
      scout_wallet: protocol.SCOUT_WALLET,
      scout_address: protocol.W5,
      w3: protocol.W3,
      session: bundle.session,
      accept_hash: bundle.acceptHash,
      transcript_sha256: chat.transcript_sha256,
      note: "Hashes in frames.json are synthetic. They are not XRPL transaction hashes.",
    };
    writeDemo(dir, {
      turns: chat.turns,
      frames: all,
      meta,
      readme: demoReadme(meta),
    });
    return { dir, meta, turns: chat.turns };
  } finally {
    await started.close();
  }
}

async function pollFrame(opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const preferred = peerHello.assertTestnetUrl(opts.rpc || peerHello.XRPL_HTTP);
  const deadline = Date.now() + (opts.timeoutMs || 90000);
  const interval = opts.intervalMs || 4000;
  while (Date.now() < deadline) {
    const hit = await hosts.withFailover(preferred, async (url) => {
      const rpc = peerHello.assertTestnetUrl(url);
      const info = await rpcCall(rpc, "server_info", {}, fetchImpl);
      peerHello.assertNetworkId(info.info && info.info.network_id);
      const page = await rpcCall(rpc, "account_tx", peerHello.accountTxParams(opts.limit || 50), fetchImpl);
      const frames = protocol.collectFrames(page.transactions || [], { synthetic: false });
      return frames.find(opts.match) || null;
    });
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw protocol.coded("timed out waiting for a ledger frame");
}

async function rpcCall(http, method, params, fetchImpl) {
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

async function runLive(opts) {
  const options = opts || {};
  const env = options.env || process.env;
  signerPost.assertLiveEnv(env);
  if (ollama.mockForced(env)) throw protocol.coded("refusing live chat while AETHER_SCRIBE_MOCK=1 or CI");
  if (!env.OLLAMA_API_KEY) throw protocol.coded("OLLAMA_API_KEY is required for live scout");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sign = options.sign || ((payload) => signerPost.postSign(env, payload, fetchImpl));
  const poll = options.poll || ((match) => pollFrame({
    match,
    fetchImpl,
    rpc: options.rpc || hosts.resolveHttp(env),
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
  }));
  const scribeUrl = options.scribeUrl || env.AETHER_SCRIBE_EP || protocol.SCRIBE_URL;
  const health = await fetchImpl(`${scribeUrl}/health`);
  if (!health.ok) throw protocol.coded("scribe health failed. Start peers:scribe on 127.0.0.1");
  const hello = helloBody(protocol.nonce());
  const helloTx = protocol.paymentTx({ account: protocol.W5, destination: protocol.W3, body: hello });
  const helloSubmit = await sign({ wallet: protocol.SCOUT_WALLET, intent: protocol.HELLO, tx: helloTx });
  if (!helloSubmit || helloSubmit.result !== "tesSUCCESS" || !protocol.HASH_RE.test(String(helloSubmit.hash || "").toUpperCase())) {
    throw protocol.coded("hello did not return tesSUCCESS");
  }
  const helloHash = String(helloSubmit.hash).toUpperCase();
  const ack = await poll((frame) => frame.t === protocol.ACK && frame.body && frame.body.hello_hash === helloHash);
  const offer = offerBody(ack.body.session, ack.hash, protocol.nonce());
  const offerTx = protocol.paymentTx({ account: protocol.W5, destination: protocol.W3, body: offer });
  const offerSubmit = await sign({ wallet: protocol.SCOUT_WALLET, intent: protocol.OFFER, tx: offerTx });
  if (!offerSubmit || offerSubmit.result !== "tesSUCCESS") throw protocol.coded("offer did not return tesSUCCESS");
  const offerHash = String(offerSubmit.hash).toUpperCase();
  const accept = await poll((frame) => frame.t === protocol.ACCEPT && frame.body && frame.body.offer_hash === offerHash);
  const lines = await scoutLines(env, fetchImpl);
  const chat = await chatLoop({
    scribeUrl,
    session: accept.body.session,
    peer: protocol.W5,
    acceptHash: accept.hash,
    lines,
    fetchImpl,
  });
  const close = closeBody(accept.body.session, chat.transcript_sha256, protocol.nonce());
  const closeTx = protocol.paymentTx({ account: protocol.W5, destination: protocol.W3, body: close });
  const closeSubmit = await sign({ wallet: protocol.SCOUT_WALLET, intent: protocol.CLOSE, tx: closeTx });
  return {
    network: protocol.NETWORK,
    hello_hash: helloHash,
    ack_hash: ack.hash,
    offer_hash: offerHash,
    accept_hash: accept.hash,
    close_hash: closeSubmit && closeSubmit.hash ? String(closeSubmit.hash).toUpperCase() : null,
    session: accept.body.session,
    turns: chat.turns,
    transcript_sha256: chat.transcript_sha256,
    ledger_claim: true,
  };
}

function assertPublic(text) {
  if (/sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) throw protocol.coded("refusing to print a seed");
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
  try {
    if (args.dry) {
      const body = unsignedPair({ nonce: (io && io.nonce) || (() => "drynonce01") });
      const text = JSON.stringify(body, null, 2);
      assertPublic(text);
      log(text);
      return 0;
    }
    if (args.sim) {
      const result = await runSim({
        mock: true,
        env: Object.assign({}, env, { AETHER_SCRIBE_MOCK: "1" }),
        root: args.root ? path.resolve(args.root) : repoRoot(),
        outDir: args.out ? path.resolve(args.out) : undefined,
        fetchImpl: io && io.fetchImpl,
        now: io && io.now,
      });
      log(`scout sim dir=${result.dir} turns=${result.turns.length} synthetic=yes`);
      return 0;
    }
    const live = await runLive({
      env,
      fetchImpl: io && io.fetchImpl,
      sign: io && io.sign,
      poll: io && io.poll,
      scribeUrl: args.scribe,
      rpc: env.FOUNDRY_XRPL_HTTP,
    });
    const text = JSON.stringify(live, null, 2);
    assertPublic(text);
    log(text);
    if (args.out) {
      const dir = path.resolve(args.out);
      writeDemo(dir, {
        turns: live.turns,
        frames: [
          { hash: live.hello_hash, t: protocol.HELLO, ledger_claim: true, synthetic: false },
          { hash: live.ack_hash, t: protocol.ACK, ledger_claim: true, synthetic: false },
          { hash: live.offer_hash, t: protocol.OFFER, ledger_claim: true, synthetic: false },
          { hash: live.accept_hash, t: protocol.ACCEPT, ledger_claim: true, synthetic: false },
        ].concat(live.close_hash ? [{ hash: live.close_hash, t: protocol.CLOSE, ledger_claim: true, synthetic: false }] : []),
        meta: {
          schema: "aether-foundry/net-chat-demo@1",
          mode: "live",
          synthetic: false,
          ledger_claim: true,
          network: protocol.NETWORK,
          scribe: ollama.ollamaModel(env),
          model: ollama.ollamaModel(env),
          scout_wallet: protocol.SCOUT_WALLET,
          scout_address: protocol.W5,
          w3: protocol.W3,
          session: live.session,
          accept_hash: live.accept_hash,
          close_hash: live.close_hash,
          transcript_sha256: live.transcript_sha256,
          note: "Hashes are the tesSUCCESS values returned by the signer. They were not invented in this file.",
        },
        readme: [
          "# Net chat live",
          "",
          "Hashes in meta.json came from signer tesSUCCESS results.",
          "This file does not contain a seed.",
          "",
        ].join("\n"),
      });
    }
    return 0;
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }
}

module.exports = {
  HELP,
  parseArgs,
  helloBody,
  offerBody,
  unsignedPair,
  simBundle,
  chatLoop,
  runSim,
  runLive,
  run,
  runId,
};

if (require.main === module) {
  run(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
