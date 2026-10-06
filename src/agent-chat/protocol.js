"use strict";

/**
 * Aether net-chat protocol v1.
 * Testnet Payments of 1 drop. MemoType is the frame name.
 * MemoFormat is application/json. xrpl:1 only.
 */

const crypto = require("crypto");

const VERSION = 1;
const NETWORK = "xrpl:1";
const NETWORK_ID = 1;
const W3 = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
const W5 = "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ";
const SCOUT_WALLET = "W5";
const HERALD_WALLET = "W3";
const DROP = "1";
const MEMO_FORMAT = "application/json";
const MAX_MEMO_HEX = 900;
const SCRIBE_PORT = 8791;
const SCRIBE_URL = "http://127.0.0.1:8791";
const OLLAMA_BASE_URL = "https://ollama.com";
const OLLAMA_MODEL = "glm-5.3-flash";
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HASH_RE = /^[A-F0-9]{64}$/;
const SESSION_RE = /^s_[a-f0-9]{16}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const FROM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;

const HELLO = "aether-peer-hello";
const ACK = "aether-peer-ack";
const OFFER = "aether-session-offer";
const ACCEPT = "aether-session-accept";
const CLOSE = "aether-session-close";
const TYPES = [HELLO, ACK, OFFER, ACCEPT, CLOSE];

const HERALD_ID = "aether-herald";
const SCRIBE_ID = "aether-scribe";
const SCOUT_ID = "aether-scout";

const SCRIBE_SYSTEM = [
  "You are aether-scribe, an Aether Foundry peer on XRPL Testnet (xrpl:1, NetworkID 1).",
  "Reply in one or two short sentences.",
  "Never ask for seeds, private keys, or family seeds.",
  "Stay on XRPL Testnet topics. Refuse mainnet.",
  "Invite the peer to join with a 1-drop Payment memo of type aether-peer-hello to W3.",
].join(" ");

const SCOUT_SYSTEM = [
  "You are aether-scout, a curious peer discovering Aether Foundry on XRPL Testnet (xrpl:1).",
  "Speak in one or two short sentences.",
  "Never ask for seeds or private keys.",
  "Stay on Testnet. Do not propose mainnet.",
].join(" ");

const SCOUT_TURNS = [
  "I found W3 on XRPL Testnet. What does Aether Foundry do?",
  "How do I open a session with a 1-drop memo?",
  "I will stay on xrpl:1 and I will not send a seed.",
];

function coded(message) {
  return Object.assign(new Error(message), { code: "PROTOCOL" });
}

function isClassic(address) {
  return typeof address === "string" && ADDRESS_RE.test(address);
}

function hexOf(text) {
  return Buffer.from(String(text), "utf8").toString("hex").toUpperCase();
}

function textOfHex(value) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if (!HEX_RE.test(text) || text.length % 2 !== 0) return "";
  try {
    return Buffer.from(text, "hex").toString("utf8");
  } catch {
    return "";
  }
}

function nonce(bytes) {
  const n = Number.isInteger(bytes) ? bytes : 8;
  return crypto.randomBytes(n).toString("hex");
}

function sessionId() {
  return `s_${crypto.randomBytes(8).toString("hex")}`;
}

function syntheticHash(nibble) {
  const ch = String(nibble || "").toUpperCase();
  if (!/^[0-9A-F]$/.test(ch)) throw coded("synthetic hash needs one hex nibble");
  return ch.repeat(64);
}

function transcriptSha256(turns) {
  const lines = (Array.isArray(turns) ? turns : []).map((turn) => {
    const role = turn && turn.role === "scribe" ? "scribe" : "scout";
    const text = turn && turn.text != null ? String(turn.text) : "";
    return JSON.stringify({ role, text });
  });
  const body = lines.length ? `${lines.join("\n")}\n` : "";
  return crypto.createHash("sha256").update(body).digest("hex");
}

function assertNet(net) {
  if (net === "xrpl:0" || net === "mainnet") throw coded("refusing mainnet");
  if (net !== NETWORK) throw coded(`refusing network ${net}`);
}

function assertHash(value, label) {
  const hash = String(value || "").toUpperCase();
  if (!HASH_RE.test(hash)) throw coded(`${label} is not a 64-hex hash`);
  return hash;
}

function cleanUrl(value, label) {
  const raw = String(value || "");
  if (raw.length < 8 || raw.length > 180) throw coded(`${label} length is refused`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coded(`${label} is not a url`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw coded(`${label} scheme is refused`);
  const host = url.hostname.toLowerCase();
  if (host === "xrplcluster.com" || host.endsWith(".xrplcluster.com")) throw coded("refusing mainnet host");
  if (host === "ripple.com" || host.endsWith(".ripple.com")) throw coded("refusing mainnet host");
  if (host === "xrpl.ws" || host.endsWith(".xrpl.ws")) throw coded("refusing mainnet host");
  if (host === "xrpl.link" || host.endsWith(".xrpl.link")) throw coded("refusing mainnet host");
  return raw;
}

function pick(body, keys) {
  const out = {};
  for (const key of keys) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

function assertCommon(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw coded("refusing empty envelope");
  if (body.v !== VERSION) throw coded("refusing protocol version");
  if (!TYPES.includes(body.t)) throw coded("refusing frame type");
  if (typeof body.from !== "string" || !FROM_RE.test(body.from)) throw coded("refusing from");
  assertNet(body.net);
  if (typeof body.nonce !== "string" || !NONCE_RE.test(body.nonce)) throw coded("refusing nonce");
}

function validateEnvelope(body) {
  assertCommon(body);
  if (body.t === HELLO) {
    const out = pick(body, ["v", "t", "from", "net", "nonce", "repo", "x402"]);
    if (out.repo != null) {
      if (typeof out.repo !== "string" || out.repo.length > 180) throw coded("refusing repo");
    }
    if (out.x402 != null) out.x402 = cleanUrl(out.x402, "x402");
    return out;
  }
  if (body.t === ACK) {
    const out = pick(body, ["v", "t", "from", "net", "nonce", "session", "challenge", "ep", "hello_hash"]);
    if (!SESSION_RE.test(String(out.session || ""))) throw coded("refusing session");
    if (typeof out.challenge !== "string" || !/^[a-f0-9]{16}$/.test(out.challenge)) throw coded("refusing challenge");
    out.ep = cleanUrl(out.ep, "ep");
    out.hello_hash = assertHash(out.hello_hash, "hello_hash");
    return out;
  }
  if (body.t === OFFER) {
    const out = pick(body, ["v", "t", "from", "net", "nonce", "session", "topic", "max_drops", "tools", "ack_hash"]);
    if (!SESSION_RE.test(String(out.session || ""))) throw coded("refusing session");
    if (typeof out.topic !== "string" || out.topic.length < 1 || out.topic.length > 80) throw coded("refusing topic");
    if (!Number.isInteger(out.max_drops) || out.max_drops < 1 || out.max_drops > 1000000) {
      throw coded("refusing max_drops");
    }
    if (!Array.isArray(out.tools) || out.tools.length < 1 || out.tools.length > 4) throw coded("refusing tools");
    for (const tool of out.tools) {
      if (typeof tool !== "string" || !/^[a-z0-9_-]{1,16}$/.test(tool)) throw coded("refusing tool");
    }
    if (out.ack_hash != null) out.ack_hash = assertHash(out.ack_hash, "ack_hash");
    return out;
  }
  if (body.t === ACCEPT) {
    const out = pick(body, ["v", "t", "from", "net", "nonce", "session", "ep", "ttl", "chat_nonce", "offer_hash"]);
    if (!SESSION_RE.test(String(out.session || ""))) throw coded("refusing session");
    out.ep = cleanUrl(out.ep, "ep");
    if (!Number.isInteger(out.ttl) || out.ttl < 60 || out.ttl > 86400) throw coded("refusing ttl");
    if (typeof out.chat_nonce !== "string" || !/^[a-f0-9]{16,64}$/.test(out.chat_nonce)) {
      throw coded("refusing chat_nonce");
    }
    out.offer_hash = assertHash(out.offer_hash, "offer_hash");
    return out;
  }
  const out = pick(body, ["v", "t", "from", "net", "nonce", "session", "reason", "transcript_sha256"]);
  if (!SESSION_RE.test(String(out.session || ""))) throw coded("refusing session");
  if (typeof out.reason !== "string" || out.reason.length < 1 || out.reason.length > 64) throw coded("refusing reason");
  if (out.transcript_sha256 != null && !/^[a-f0-9]{64}$/.test(out.transcript_sha256)) {
    throw coded("refusing transcript_sha256");
  }
  return out;
}

function encodeMemo(type, payload) {
  if (!TYPES.includes(type)) throw coded("refusing frame type");
  const json = JSON.stringify(payload);
  const dataHex = hexOf(json);
  if (dataHex.length > MAX_MEMO_HEX) throw coded("refusing memo above 900 hex chars");
  return {
    Memo: {
      MemoType: hexOf(type),
      MemoFormat: hexOf(MEMO_FORMAT),
      MemoData: dataHex,
    },
  };
}

function memosOf(tx) {
  const list = tx && Array.isArray(tx.Memos) ? tx.Memos : [];
  const out = [];
  for (const wrapper of list) {
    const row = wrapper && wrapper.Memo;
    if (!row) continue;
    const type = textOfHex(row.MemoType);
    const format = textOfHex(row.MemoFormat);
    const data = textOfHex(row.MemoData);
    if (!type && !data) continue;
    out.push({ type, format, data });
  }
  return out;
}

function parseLegacyHello(data) {
  if (!data) return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v != null || parsed.t != null || parsed.net != null) return null;
  const repo = typeof parsed.repo === "string" ? parsed.repo : null;
  const x402 = typeof parsed.x402 === "string" ? parsed.x402 : null;
  if (!repo && !x402) return null;
  return { legacy: true, t: HELLO, body: { repo, x402 } };
}

function bodyFromMemos(memos) {
  const list = Array.isArray(memos) ? memos : [];
  const direct = list.find((row) => TYPES.includes(row.type) && row.data);
  if (direct) {
    if (direct.format && direct.format !== MEMO_FORMAT) return null;
    let parsed;
    try {
      parsed = JSON.parse(direct.data);
    } catch {
      return direct.type === HELLO ? parseLegacyHello(direct.data) : null;
    }
    if (direct.type === HELLO && parsed && parsed.v == null && parsed.net == null) {
      const legacy = parseLegacyHello(direct.data);
      if (legacy) return legacy;
    }
    try {
      const body = validateEnvelope(parsed);
      if (body.t !== direct.type) return null;
      return { legacy: false, t: body.t, body };
    } catch {
      return null;
    }
  }
  const purpose = list.find((row) => row.type === "purpose" && TYPES.includes(row.data));
  if (!purpose) return null;
  const jsonMemo = list.find((row) => row !== purpose && String(row.data || "").trim().startsWith("{"));
  if (!jsonMemo) return null;
  if (purpose.data === HELLO) {
    const legacy = parseLegacyHello(jsonMemo.data);
    if (legacy) return legacy;
  }
  try {
    const body = validateEnvelope(JSON.parse(jsonMemo.data));
    if (body.t !== purpose.data) return null;
    return { legacy: false, t: body.t, body };
  } catch {
    return null;
  }
}

function paymentTx(opts) {
  const options = opts || {};
  const body = validateEnvelope(options.body);
  const account = options.account;
  const destination = options.destination;
  if (!isClassic(account) || !isClassic(destination)) throw coded("refusing address");
  if (account === destination) throw coded("refusing a payment to self");
  const tx = {
    TransactionType: "Payment",
    Account: account,
    Destination: destination,
    Amount: DROP,
    Memos: [encodeMemo(body.t, body)],
  };
  if (options.networkId != null && Number(options.networkId) !== NETWORK_ID) {
    throw coded(`refusing NetworkID ${options.networkId}`);
  }
  return tx;
}

function txView(entry) {
  if (!entry || typeof entry !== "object") return null;
  const tx = entry.tx_json || entry.tx || null;
  if (!tx || typeof tx !== "object") return null;
  if (entry.validated === false) return null;
  const meta = entry.meta || entry.metaData || {};
  const result = meta.TransactionResult || "";
  if (result && result !== "tesSUCCESS") return null;
  const hash = String(entry.hash || tx.hash || "").toUpperCase();
  if (!HASH_RE.test(hash)) return null;
  const ledgerRaw = entry.ledger_index != null ? entry.ledger_index : tx.ledger_index;
  const ledgerNum = Number(ledgerRaw);
  const ledger = Number.isInteger(ledgerNum) && ledgerNum > 0 ? ledgerNum : null;
  return { tx, hash, ledger };
}

function peerOf(account, destination) {
  if (account === W3 && destination !== W3) return destination;
  if (destination === W3 && account !== W3) return account;
  return null;
}

function frameFromEntry(entry, opts) {
  const view = txView(entry);
  if (!view) return null;
  const tx = view.tx;
  if (tx.TransactionType !== "Payment") return null;
  if (String(tx.Amount) !== DROP) return null;
  if (tx.NetworkID != null && Number(tx.NetworkID) !== NETWORK_ID) return null;
  if (tx.Account !== W3 && tx.Destination !== W3) return null;
  if (!isClassic(tx.Account) || !isClassic(tx.Destination)) return null;
  const parsed = bodyFromMemos(memosOf(tx));
  if (!parsed) return null;
  if (!parsed.legacy && parsed.body && parsed.body.net && parsed.body.net !== NETWORK) return null;
  const inbound = parsed.t === HELLO || parsed.t === OFFER;
  const outbound = parsed.t === ACK || parsed.t === ACCEPT;
  if (inbound && (tx.Destination !== W3 || tx.Account === W3)) return null;
  if (outbound && (tx.Account !== W3 || tx.Destination === W3)) return null;
  if (parsed.t === CLOSE && tx.Account !== W3 && tx.Destination !== W3) return null;
  const peer = peerOf(tx.Account, tx.Destination);
  if (!peer) return null;
  const synthetic = Boolean(opts && opts.synthetic);
  return {
    network: NETWORK,
    hash: view.hash,
    ledger: view.ledger,
    account: tx.Account,
    destination: tx.Destination,
    peer,
    amount: DROP,
    t: parsed.t,
    body: parsed.body,
    legacy: parsed.legacy,
    synthetic,
    ledger_claim: !synthetic,
  };
}

function collectFrames(entries, opts) {
  const options = opts || {};
  const cap = Number.isInteger(options.limit) ? options.limit : entries.length;
  const list = Array.isArray(entries) ? entries.slice(0, cap) : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const row = frameFromEntry(entry, { synthetic: options.synthetic === true });
    if (!row || seen.has(row.hash)) continue;
    seen.add(row.hash);
    out.push(row);
  }
  out.sort((a, b) => {
    const left = a.ledger || 0;
    const right = b.ledger || 0;
    if (left !== right) return left - right;
    if (a.hash < b.hash) return -1;
    if (a.hash > b.hash) return 1;
    return 0;
  });
  return out;
}

function sessionEvent(frame) {
  const body = frame.body || {};
  const row = {
    network: NETWORK,
    session: body.session || null,
    state: "hello",
    peer: frame.peer,
    from: body.from || null,
    hash: frame.hash,
    t: frame.t,
    hello_hash: null,
    topic: null,
    ep: body.ep || null,
    synthetic: frame.synthetic === true,
    ledger_claim: frame.ledger_claim !== false && frame.synthetic !== true,
    ledger: frame.ledger,
  };
  if (frame.t === HELLO) {
    row.state = "hello";
    row.hello_hash = frame.hash;
    row.session = null;
    return row;
  }
  if (frame.t === ACK) {
    row.state = "acked";
    row.hello_hash = body.hello_hash || null;
    return row;
  }
  if (frame.t === OFFER) {
    row.state = "offered";
    row.topic = body.topic || null;
    return row;
  }
  if (frame.t === ACCEPT) {
    row.state = "open";
    return row;
  }
  row.state = "closed";
  if (body.transcript_sha256) row.transcript_sha256 = body.transcript_sha256;
  if (body.reason) row.reason = body.reason;
  return row;
}

function mockReply(message, index) {
  const lines = [
    "Aether Foundry is an XRPL Testnet house. W3 listens for aether-peer-hello. I will not ask for a seed.",
    "Send a 1-drop Payment to W3 with MemoType aether-peer-hello, then aether-session-offer. Stay on xrpl:1.",
    "Good. Testnet only. When you are done, send aether-session-close. The desk never signs.",
  ];
  const i = Number.isInteger(index) && index >= 0 && index < lines.length ? index : lines.length - 1;
  const heard = String(message || "").slice(0, 80);
  return `${lines[i]} Heard: ${heard}`;
}

module.exports = {
  VERSION,
  NETWORK,
  NETWORK_ID,
  W3,
  W5,
  SCOUT_WALLET,
  HERALD_WALLET,
  DROP,
  MEMO_FORMAT,
  MAX_MEMO_HEX,
  SCRIBE_PORT,
  SCRIBE_URL,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  ADDRESS_RE,
  HASH_RE,
  SESSION_RE,
  HELLO,
  ACK,
  OFFER,
  ACCEPT,
  CLOSE,
  TYPES,
  HERALD_ID,
  SCRIBE_ID,
  SCOUT_ID,
  SCRIBE_SYSTEM,
  SCOUT_SYSTEM,
  SCOUT_TURNS,
  coded,
  isClassic,
  hexOf,
  textOfHex,
  nonce,
  sessionId,
  syntheticHash,
  transcriptSha256,
  assertNet,
  validateEnvelope,
  encodeMemo,
  memosOf,
  bodyFromMemos,
  paymentTx,
  frameFromEntry,
  collectFrames,
  sessionEvent,
  mockReply,
  peerOf,
};
