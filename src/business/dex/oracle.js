"use strict";

/**
 * W5 official RLUSD/XRP oracle. Dry-run is the default.
 * A live tick posts OracleSet from W5, fees only, at most every 30 minutes.
 * Document 1 stays the AETH oracle. This publisher uses document 2.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../../director/anchors");
const math = require("../../frontier/oracle-math");
const bounds = require("./bounds");
const rlusd = require("./rlusd");
const book = require("./book");
const signer = require("./signer");
const { connectRole } = require("./live");

const INTERVAL_MS = 30 * 60 * 1000;
const DOCUMENT_ID = 2;
const PHRASE = "ACTIVATE-W5-RLUSD-ORACLE";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function liveGate(env) {
  const source = env || {};
  return source.FOUNDRY_W5_ORACLE_LIVE === "yes"
    && source.FOUNDRY_DEX_EXECUTE === "yes"
    && source.FOUNDRY_DEX_NETWORK === "xrpl:1"
    && source.FOUNDRY_DEX_AXELAR_DROPS === "0"
    && source.FOUNDRY_W5_ORACLE_ACTIVATE === PHRASE;
}

function xrpPerRlusd(pool) {
  const exact = pool && pool.exact;
  if (!exact || exact.coeff <= 0n || pool.xrp <= 0n) return null;
  const scale = 8n;
  let num = pool.xrp * (10n ** scale);
  let den = exact.coeff;
  const exp = BigInt(exact.exp + 6);
  if (exp >= 0n) den *= 10n ** exp;
  else num *= 10n ** (-exp);
  if (den <= 0n) return null;
  const scaled = num / den;
  if (scaled <= 0n) return null;
  const digits = scaled.toString().padStart(Number(scale) + 1, "0");
  const whole = digits.slice(0, digits.length - Number(scale));
  const frac = digits.slice(digits.length - Number(scale)).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function buildTx(pool, now) {
  const quote = xrpPerRlusd(pool);
  if (!quote) throw coded("RLUSD pool is not priced", "VALUATION");
  const encoded = math.encodeQuote(quote);
  return {
    TransactionType: "OracleSet",
    Account: anchors.WALLETS.W5.address,
    OracleDocumentID: DOCUMENT_ID,
    Provider: math.providerHex(),
    AssetClass: math.assetClassHex(),
    LastUpdateTime: math.unixSeconds(now),
    PriceDataSeries: [
      {
        PriceData: {
          BaseAsset: rlusd.CURRENCY,
          QuoteAsset: "XRP",
          AssetPrice: encoded.asset_price_hex,
          Scale: encoded.scale,
        },
      },
    ],
  };
}

function readJournal(dir) {
  if (!dir) return [];
  const file = path.join(dir, "decisions.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function countsTowardRateLimit(row) {
  if (!row || row.role !== "W5") return false;
  if (row.submitted !== true && row.attempted !== true && row.validated !== true) return false;
  return row.decision === "publish" || row.decision === "submitted";
}

function tooSoon(dir, now) {
  const rows = readJournal(dir);
  const clock = Date.parse(now);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!countsTowardRateLimit(row)) continue;
    const stamp = Date.parse(row.at || "");
    if (!Number.isFinite(stamp)) continue;
    return clock - stamp < INTERVAL_MS;
  }
  return false;
}

function reportFailure(error, dir, stderr) {
  let message = String(error && error.message ? error.message : "oracle tick failed");
  message = message.replace(/sEd[1-9A-HJ-NP-Za-km-z]{10,}/g, "[redacted]");
  message = message.replace(/\b[0-9A-F]{64}\b/gi, "[hash]");
  if (/seed|secret|tx_blob|private/i.test(message)) message = "oracle tick failed";
  const record = {
    schema: "aether.business.rlusd-oracle",
    at: new Date().toISOString(),
    decision: "error",
    role: "W5",
    learning: false,
    signed: false,
    submitted: false,
    attempted: false,
    validated: false,
    error_code: (error && error.code) || "FATAL",
    rationale: message.slice(0, 240),
  };
  const line = `${JSON.stringify(record)}\n`;
  const write = stderr || ((text) => process.stderr.write(text));
  write(line);
  try {
    writePublic(dir, record);
  } catch (err) {
    write(`${JSON.stringify({ decision: "error", role: "W5", learning: false, rationale: "oracle error could not be journaled" })}\n`);
  }
  return record;
}

function locked(dir, fn) {
  if (!dir) return fn();
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "lock");
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (Date.now() - start > 8000) throw coded("oracle journal lock timed out", "LOCK");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function freshUpdate(now) {
  const stamped = math.unixSeconds(now);
  const wall = math.unixSeconds(new Date());
  return Math.abs(wall - stamped) > 300 ? wall : stamped;
}

function writePublic(dir, record) {
  if (!dir) return record;
  const text = JSON.stringify(record);
  if (/seed|secret|tx_blob|private/i.test(text)) throw coded("oracle record is not public", "SECRET");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "decisions.jsonl"), `${text}\n`);
  return record;
}

async function tick(env, input, clients) {
  const body = input || {};
  const now = body.now || new Date().toISOString();
  const source = env || {};
  if (source.FOUNDRY_DEX_AXELAR_DROPS != null && source.FOUNDRY_DEX_AXELAR_DROPS !== "0") {
    throw coded("Axelar budget is not zero", "BRIDGE");
  }
  const dry = !liveGate(source);
  const paused = locked(body.journal, () => tooSoon(body.journal, now));
  if (paused) {
    return {
      decision: "research",
      role: "W5",
      learning: false,
      signed: false,
      dry_run: dry,
      traded: false,
      fee_only: true,
      rationale: "The RLUSD oracle posted within the last 30 minutes.",
    };
  }
  let pool = body.pool || null;
  let shot = null;
  if (clients && clients.ledger && (!pool || !dry)) {
    const loaded = await book.load(clients.ledger, anchors.WALLETS.W5.address, book.REGULAR.W5);
    shot = loaded.shot;
    if (!pool) pool = loaded.pool;
    pool.network_id = loaded.shot.networkId;
  }
  if (!pool) throw coded("RLUSD pool is not priced", "VALUATION");
  if (Number(pool.network_id) !== 1) throw coded("refusing network id", "MAINNET");
  const tx = buildTx(pool, now);
  if (!dry) tx.LastUpdateTime = freshUpdate(now);
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  if (!dry) {
    if (!shot) throw coded("oracle live transaction is not autofilled", "TX");
    tx.Fee = shot.fee.toString();
    tx.Sequence = shot.sequence;
    tx.LastLedgerSequence = shot.validatedLedger + bounds.LEDGER_WINDOW;
  }
  const row = {
    schema: "aether.business.rlusd-oracle",
    at: now,
    decision: dry ? "dry-run" : "publish",
    role: "W5",
    learning: false,
    signed: false,
    submitted: false,
    traded: false,
    dry_run: dry,
    fee_only: true,
    key_loaded: false,
    wallet: "W5",
    interval_minutes: 30,
    quote_xrp_per_rlusd: xrpPerRlusd(pool),
    tx,
  };
  const admitted = locked(body.journal, () => {
    if (tooSoon(body.journal, now)) return false;
    if (dry) writePublic(body.journal, row);
    return true;
  });
  if (!admitted) {
    return {
      decision: "research",
      role: "W5",
      learning: false,
      signed: false,
      dry_run: dry,
      traded: false,
      fee_only: true,
      rationale: "The RLUSD oracle posted within the last 30 minutes.",
    };
  }
  if (dry) return row;
  if (tx.Fee == null || tx.Sequence == null || tx.LastLedgerSequence == null) {
    throw coded("oracle live transaction is not autofilled", "TX");
  }
  if (!clients || typeof clients.sign !== "function") throw coded("W5 oracle signer is not configured", "SIGNER");
  const signed = await signer.sign(tx, {
    role: "W5",
    type: "OracleSet",
    account: anchors.WALLETS.W5.address,
    sequence: tx.Sequence,
    last: tx.LastLedgerSequence,
    fee: tx.Fee,
  }, clients.sign);
  row.signed = true;
  row.key_loaded = true;
  row.signed_hash = signed.hash;
  let submitted = false;
  if (typeof clients.submit === "function") {
    await clients.submit(signed.tx_blob);
    submitted = true;
  }
  row.submitted = submitted;
  row.attempted = submitted;
  row.validated = false;
  if (!submitted) return row;
  return writePublic(body.journal, row);
}

function main(argv, deps) {
  const options = deps || {};
  const env = options.env || {};
  const supervise = Array.isArray(argv) && argv.includes("--supervise");
  if (supervise && env.FOUNDRY_W5_ORACLE_SUPERVISOR !== "yes") {
    const write = options.stdout || (() => {});
    write(`${JSON.stringify({ role: "w5-rlusd-oracle", dormant: true, learning: false, dry_run: true })}\n`);
    return Promise.resolve(0);
  }
  const once = async () => {
    const input = options.input || { journal: env.FOUNDRY_W5_ORACLE_JOURNAL, now: options.now };
    if (options.clients || !liveGate(env)) return tick(env, input, options.clients);
    const opened = await connectRole(env, "W5", options.deps);
    try {
      await opened.openKey();
      return await tick(env, input, opened.clients);
    } finally {
      await opened.close();
    }
  };
  const journal = env.FOUNDRY_W5_ORACLE_JOURNAL || (options.input && options.input.journal);
  const report = (error) => reportFailure(error, journal, options.stderr);
  if (!supervise) return once().then(() => 0);
  return once().catch(report).then(() => new Promise((resolve) => {
    const timer = setInterval(() => {
      once().catch(report);
    }, INTERVAL_MS);
    if (options.stop) options.stop(() => {
      clearInterval(timer);
      resolve(0);
    });
  }));
}

if (require.main === module) {
  main(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code)).catch(() => process.exit(1));
}

module.exports = {
  INTERVAL_MS,
  DOCUMENT_ID,
  PHRASE,
  liveGate,
  buildTx,
  xrpPerRlusd,
  tick,
  main,
  reportFailure,
  tooSoon,
};
