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

function tooSoon(dir, now) {
  const rows = readJournal(dir);
  const clock = Date.parse(now);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.role !== "W5" || row.decision === "research") continue;
    const stamp = Date.parse(row.at || "");
    if (!Number.isFinite(stamp)) continue;
    return clock - stamp < INTERVAL_MS;
  }
  return false;
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
  if (tooSoon(body.journal, now)) {
    return {
      decision: "research",
      role: "W5",
      learning: false,
      signed: false,
      dry_run: !liveGate(source),
      traded: false,
      fee_only: true,
      rationale: "The RLUSD oracle posted within the last 30 minutes.",
    };
  }
  let pool = body.pool || null;
  if (!pool && clients && clients.ledger) {
    const loaded = await book.load(clients.ledger, anchors.WALLETS.W5.address, book.REGULAR.W5);
    pool = loaded.pool;
    pool.network_id = loaded.shot.networkId;
  }
  if (!pool) throw coded("RLUSD pool is not priced", "VALUATION");
  if (Number(pool.network_id) !== 1) throw coded("refusing network id", "MAINNET");
  const tx = buildTx(pool, now);
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  const dry = !liveGate(source);
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
  if (dry) return writePublic(body.journal, row);
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
  if (typeof clients.submit === "function") {
    await clients.submit(signed.tx_blob);
    row.submitted = true;
  }
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
  const once = () => tick(env, options.input || { journal: env.FOUNDRY_W5_ORACLE_JOURNAL, now: options.now }, options.clients);
  if (!supervise) return once().then(() => 0);
  return once().then(() => new Promise((resolve) => {
    const timer = setInterval(() => {
      once().catch(() => {});
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
};
