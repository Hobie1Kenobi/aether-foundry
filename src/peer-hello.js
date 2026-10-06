#!/usr/bin/env node
"use strict";

/**
 * Observe XRPL Testnet Payments to W3 whose memo purpose is aether-peer-hello.
 * Appends new rows to lab/peers/hellos.jsonl. Does not sign, pay, or reply.
 *
 *   npm run peers:hello -- --dry
 *   npm run peers:hello -- --fixture src/fixtures/peer-hello-account-tx.json --dry
 *   npm run peers:hello
 */

const fs = require("fs");
const path = require("path");

const HELLO_TYPE = "aether-peer-hello";
const NETWORK = "xrpl:1";
const NETWORK_ID = 1;
const W3 = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
const XRPL_HTTP = "https://s.altnet.rippletest.net:51234";
const TX_LIMIT = 100;
const TX_LIMIT_MAX = 200;
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HASH_RE = /^[A-F0-9]{64}$/;

const HELP = `Usage: node src/peer-hello.js [--dry] [--record] [--quiet] [--alert] [--root DIR] [--rpc URL] [--fixture FILE] [--hands FILE] [--limit N]

Reads the newest validated account_tx page for W3 on XRPL Testnet (network id 1).
Appends inbound Payment memos of type ${HELLO_TYPE} to lab/peers/hellos.jsonl.
A live run writes. --dry prints new rows and does not write.
--fixture reads a local account_tx JSON page and stays dry unless --record is set.
--alert exits 2 when at least one new hello was written.
Does not sign, pay, or send a reply.`;

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function need(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const out = {
    quiet: false,
    dry: false,
    record: false,
    alert: false,
    root: null,
    rpc: null,
    fixture: null,
    hands: null,
    limit: TX_LIMIT,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--quiet" || arg === "-q") out.quiet = true;
    else if (arg === "--dry") out.dry = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--alert") out.alert = true;
    else if (arg === "--root") {
      out.root = need(args, i + 1, "--root");
      i += 1;
    } else if (arg === "--rpc") {
      out.rpc = need(args, i + 1, "--rpc");
      i += 1;
    } else if (arg === "--fixture") {
      out.fixture = need(args, i + 1, "--fixture");
      i += 1;
    } else if (arg === "--hands") {
      out.hands = need(args, i + 1, "--hands");
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

function isMainnetUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const blocked = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link"];
    return blocked.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function assertTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("refusing unparseable XRPL url");
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("xahau")) throw new Error("refusing Xahau host");
  if (isMainnetUrl(raw)) throw new Error("refusing mainnet XRPL url");
  if (!host.endsWith(".rippletest.net") && host !== "rippletest.net") {
    throw new Error("refusing non-testnet XRPL url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("refusing non-HTTP XRPL url");
  }
  return raw.replace(/\/$/, "");
}

function assertNetworkId(networkId) {
  if (networkId == null || networkId === "") return;
  const id = Number(networkId);
  if (id === 0) throw new Error("refusing NetworkID 0");
  if (id !== NETWORK_ID) throw new Error(`refusing NetworkID ${networkId}`);
}

function isClassic(address) {
  return typeof address === "string" && ADDRESS_RE.test(address);
}

function decodeMemoField(value) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if (!/^[0-9A-Fa-f]+$/.test(text) || text.length % 2 !== 0) return "";
  try {
    return Buffer.from(text, "hex").toString("utf8");
  } catch {
    return "";
  }
}

function memosOf(tx) {
  const list = tx && Array.isArray(tx.Memos) ? tx.Memos : [];
  const out = [];
  for (const wrapper of list) {
    const row = wrapper && wrapper.Memo;
    if (!row) continue;
    const type = decodeMemoField(row.MemoType);
    const format = decodeMemoField(row.MemoFormat);
    const data = decodeMemoField(row.MemoData);
    if (!type && !data) continue;
    out.push({ type, format, data });
  }
  return out;
}

function parsePayload(data) {
  const raw = data == null ? "" : String(data);
  let repo = null;
  let x402 = null;
  if (!raw) return { repo, x402 };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.repo === "string") repo = parsed.repo;
      if (typeof parsed.x402 === "string") x402 = parsed.x402;
    }
  } catch {
    /* keep the raw memo text */
  }
  return { repo, x402 };
}

function helloMemo(memos) {
  const list = Array.isArray(memos) ? memos : [];
  const direct = list.find((row) => row.type === HELLO_TYPE);
  if (direct) {
    return {
      MemoType: direct.type,
      MemoFormat: direct.format || null,
      MemoData: direct.data,
      ...parsePayload(direct.data),
    };
  }
  const purpose = list.find((row) => row.type === "purpose" && row.data === HELLO_TYPE);
  if (!purpose) return null;
  const jsonMemo = list.find(
    (row) =>
      row !== purpose &&
      (row.format === "application/json" ||
        row.type === "application/json" ||
        String(row.data || "").trim().startsWith("{"))
  );
  const data = jsonMemo ? jsonMemo.data : "";
  const format = jsonMemo && jsonMemo.format ? jsonMemo.format : jsonMemo ? "application/json" : null;
  return {
    MemoType: HELLO_TYPE,
    MemoFormat: format,
    MemoData: data,
    ...parsePayload(data),
  };
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

function helloFromEntry(entry) {
  const view = txView(entry);
  if (!view) return null;
  const tx = view.tx;
  if (tx.TransactionType !== "Payment") return null;
  if (tx.Destination !== W3) return null;
  if (tx.Account === W3) return null;
  if (!isClassic(tx.Account)) return null;
  const memo = helloMemo(memosOf(tx));
  if (!memo) return null;
  return {
    account: tx.Account,
    hash: view.hash,
    ledger: view.ledger,
    memo,
  };
}

function collectHellos(entries, limit) {
  const cap = Number.isInteger(limit) ? limit : TX_LIMIT;
  const list = Array.isArray(entries) ? entries.slice(0, cap) : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const row = helloFromEntry(entry);
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

function stamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function helloLine(row, now) {
  return {
    network: NETWORK,
    account: row.account,
    hash: row.hash,
    ledger: row.ledger,
    memo: {
      MemoType: row.memo.MemoType,
      MemoFormat: row.memo.MemoFormat,
      MemoData: row.memo.MemoData,
      repo: row.memo.repo,
      x402: row.memo.x402,
    },
    seen_at: stamp(now),
  };
}

function eachJsonl(text, fn) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      fn(JSON.parse(trimmed));
    } catch {
      /* skip a torn line */
    }
  }
}

function readHashes(file) {
  const seen = new Set();
  if (!file || !fs.existsSync(file)) return seen;
  eachJsonl(fs.readFileSync(file, "utf8"), (row) => {
    if (row && row.hash) seen.add(String(row.hash).toUpperCase());
  });
  return seen;
}

function logPath(root) {
  return path.join(root, "lab", "peers", "hellos.jsonl");
}

function archiveHellos(file, rows, now) {
  const seen = readHashes(file);
  const fresh = [];
  for (const row of rows) {
    if (!row || seen.has(row.hash)) continue;
    const line = helloLine(row, now);
    fresh.push(line);
    seen.add(row.hash);
  }
  if (!fresh.length) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = "";
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.length && !cur.endsWith("\n")) prefix = "\n";
  }
  const body = fresh.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.appendFileSync(file, prefix + body);
  return fresh;
}

function previewHellos(file, rows, now) {
  const seen = readHashes(file);
  const fresh = [];
  for (const row of rows) {
    if (!row || seen.has(row.hash)) continue;
    fresh.push(helloLine(row, now));
    seen.add(row.hash);
  }
  return fresh;
}

function loadFixture(file) {
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.transactions)) return body.transactions;
  if (body && body.result && Array.isArray(body.result.transactions)) return body.result.transactions;
  throw new Error("fixture has no transactions array");
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

function accountTxParams(limit) {
  return {
    account: W3,
    ledger_index_min: -1,
    ledger_index_max: -1,
    limit,
    forward: false,
  };
}

async function notifyHands(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { notified: false, reason: "none" };
  const payload = {
    event: HELLO_TYPE,
    new: list.length,
    accounts: list.map((row) => row.account),
    hashes: list.map((row) => row.hash),
  };
  const line = JSON.stringify(payload);
  try {
    if (typeof opts.hook === "function") await opts.hook(list, payload);
    if (opts.handsFile) {
      const fsImpl = opts.fs || fs;
      fsImpl.mkdirSync(path.dirname(opts.handsFile), { recursive: true });
      fsImpl.appendFileSync(opts.handsFile, `${line}\n`);
    }
    if (typeof opts.log === "function") opts.log(line);
    const output = opts.env && opts.env.GITHUB_OUTPUT;
    if (output) {
      try {
        fs.appendFileSync(output, `new_hellos=${list.length}\n`);
      } catch {
        /* the archive already stands */
      }
    }
    return { notified: true, reason: "observe" };
  } catch (err) {
    const error = opts.error || (() => {});
    try {
      error(`hands notify failed: ${err && err.message ? err.message : err}`);
    } catch {
      /* fail-soft */
    }
    return { notified: false, reason: "fail-soft" };
  }
}

async function run(argv, io = {}) {
  const log = io.log || console.log;
  const error = io.error || console.error;
  const env = io.env || process.env;
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

  const root = path.resolve(args.root || repoRoot());
  const now = io.now ? io.now() : new Date();
  let entries;
  try {
    if (args.fixture) {
      const fixturePath = path.resolve(args.fixture);
      entries = loadFixture(fixturePath);
    } else {
      const rpc = assertTestnetUrl(args.rpc || env.FOUNDRY_XRPL_HTTP || XRPL_HTTP);
      const fetchImpl = io.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error("no fetch implementation");
      const info = await rpcCall(rpc, "server_info", {}, fetchImpl);
      const networkId = info.info && info.info.network_id;
      assertNetworkId(networkId);
      const page = await rpcCall(rpc, "account_tx", accountTxParams(args.limit), fetchImpl);
      if (page.validated === false) throw new Error("account_tx was not validated");
      entries = Array.isArray(page.transactions) ? page.transactions : [];
    }
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }

  const found = collectHellos(entries, args.limit);
  const write = Boolean(args.record || (!args.fixture && !args.dry));
  const file = logPath(root);
  const rows = write ? archiveHellos(file, found, now) : previewHellos(file, found, now);

  if (!args.quiet) {
    log(
      `peer-hello scanned=${Math.min(entries.length, args.limit)} matched=${found.length} new=${rows.length} write=${write ? "yes" : "no"}`
    );
    if (!write) {
      for (const row of rows) log(JSON.stringify(row));
    }
  }

  if (write && rows.length) {
    await notifyHands(rows, {
      hook: io.hook,
      handsFile: args.hands || env.AETHER_PEER_HELLO_HANDS || "",
      log,
      error,
      env,
    });
  }

  if (args.alert && rows.length) return 2;
  return 0;
}

module.exports = {
  HELLO_TYPE,
  NETWORK,
  NETWORK_ID,
  W3,
  XRPL_HTTP,
  TX_LIMIT,
  TX_LIMIT_MAX,
  HELP,
  parseArgs,
  assertTestnetUrl,
  assertNetworkId,
  decodeMemoField,
  memosOf,
  helloMemo,
  helloFromEntry,
  collectHellos,
  helloLine,
  readHashes,
  archiveHellos,
  loadFixture,
  accountTxParams,
  notifyHands,
  logPath,
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
