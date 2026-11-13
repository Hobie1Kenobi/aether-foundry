"use strict";

/**
 * W3 IOC guards. A sell needs a proved cost basis, and a Chicago day
 * stops new buys once realized loss reaches the cap. The record is
 * fsynced inside the mission ledger lock. A bad record fails closed.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../../director/anchors");
const { coded, exclusive } = require("../../missions/ledger");

const SCHEMA = "aether.dex.w3-guard";
const FILE = "w3-guard.json";
const DEFAULT_LOSS_CAP = 50000n;
const DEFAULT_MARGIN = 0n;
const PNL = /^-?(?:0|[1-9][0-9]*)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9A-F]{64}$/;

function lossCap(env) {
  return configured(env && env.FOUNDRY_W3_DAILY_LOSS_CAP_DROPS, DEFAULT_LOSS_CAP, DEFAULT_LOSS_CAP);
}

function sellMargin(env) {
  return configured(env && env.FOUNDRY_W3_SELL_MARGIN_DROPS, DEFAULT_MARGIN, null);
}

function configured(raw, fallback, max) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value < 0n) return null;
  if (max != null && value > max) return null;
  return value;
}

function isDay(day) {
  if (typeof day !== "string" || !DAY.test(day)) return false;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month < 1 || month > 12 || date < 1 || date > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, date));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === date;
}

function fresh() {
  return { schema: SCHEMA, day: null, realized_pnl_drops: "0", proofs: [], fresh: true };
}

function parsePnl(text) {
  if (typeof text !== "string" || !PNL.test(text) || text === "-0") return null;
  return BigInt(text);
}

function valid(parsed) {
  if (!parsed || parsed.schema !== SCHEMA) return false;
  if (!isDay(parsed.day)) return false;
  if (parsePnl(parsed.realized_pnl_drops) == null) return false;
  if (!Array.isArray(parsed.proofs)) return false;
  return parsed.proofs.every((hash) => typeof hash === "string" && HASH.test(hash));
}

function read(dir) {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return fresh();
  try {
    const text = fs.readFileSync(file, "utf8");
    if (/seed|secret|tx_blob|private/i.test(text)) return { closed: true };
    const parsed = JSON.parse(text);
    if (!valid(parsed)) return { closed: true };
    return {
      schema: SCHEMA,
      day: parsed.day,
      realized_pnl_drops: parsePnl(parsed.realized_pnl_drops).toString(),
      proofs: parsed.proofs.slice(),
    };
  } catch (error) {
    return { closed: true };
  }
}

function write(dir, body) {
  const text = `${JSON.stringify(body)}\n`;
  if (/seed|secret|tx_blob|private/i.test(text)) {
    throw coded("W3 loss record is not public", "SECRET");
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, FILE);
  const tmp = path.join(dir, `${FILE}.partial`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  const dirFd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function lossOf(state, day) {
  if (!state || state.closed || state.day !== day) return 0n;
  const pnl = parsePnl(state.realized_pnl_drops);
  if (pnl == null || pnl >= 0n) return 0n;
  return -pnl;
}

function inspect(dir, day) {
  return exclusive(dir, () => {
    const state = read(dir);
    if (state.closed) return { closed: true, loss: null };
    return { closed: false, loss: lossOf(state, day) };
  });
}

function record(dir, day, delta, hash) {
  if (!isDay(day)) throw coded("W3 loss day is not a Chicago day", "GUARD");
  if (typeof delta !== "bigint") throw coded("W3 realized result is not drops", "GUARD");
  const id = String(hash || "").toUpperCase();
  if (!HASH.test(id)) throw coded("W3 loss proof hash is missing", "GUARD");
  return exclusive(dir, () => {
    const state = read(dir);
    if (state.closed) throw coded("The W3 daily loss record is unreadable. Nothing is signed.", "GUARD");
    let target = day;
    let proofs = [];
    let pnl = 0n;
    if (state.day && isDay(state.day) && state.day >= day) {
      target = state.day;
      proofs = state.proofs.slice();
      pnl = parsePnl(state.realized_pnl_drops);
    }
    if (pnl == null) throw coded("The W3 daily loss record is unreadable. Nothing is signed.", "GUARD");
    if (proofs.includes(id)) {
      return { schema: SCHEMA, day: target, realized_pnl_drops: pnl.toString(), proofs, replay: true };
    }
    const applied = state.day && state.day > day && delta > 0n ? 0n : delta;
    const next = {
      schema: SCHEMA,
      day: target,
      realized_pnl_drops: (pnl + applied).toString(),
      proofs: proofs.concat(id),
    };
    write(dir, next);
    return next;
  });
}

function width(exact, span) {
  return exact.coeff * (10n ** BigInt(span + exact.exp));
}

function poolOut(pool, exact) {
  if (!pool || typeof pool.xrp !== "bigint" || pool.xrp <= 0n || !pool.exact || pool.exact.coeff <= 0n) return null;
  if (!exact || exact.coeff <= 0n) return null;
  if (!Number.isInteger(pool.tradingFee) && typeof pool.tradingFee !== "bigint") return null;
  const fee = BigInt(pool.tradingFee);
  if (fee < 0n || fee >= 100000n) return null;
  const span = Math.max(-pool.exact.exp, -exact.exp, 0);
  const input = width(exact, span);
  const poolIou = width(pool.exact, span);
  if (input <= 0n || poolIou <= 0n) return null;
  let out = pool.xrp * input / (poolIou + input);
  out = out * (100000n - fee) / 100000n;
  return out > 0n ? out : null;
}

function moreXrp(left, right) {
  const span = Math.max(-left.exact.exp, -right.exact.exp, 0);
  return left.xrp * width(right.exact, span) > right.xrp * width(left.exact, span);
}

function sizedBid(bid) {
  if (!bid || typeof bid.xrp !== "bigint" || bid.xrp <= 0n || !bid.exact || bid.exact.coeff <= 0n) return null;
  if (bid.fundedXrp == null && bid.fundedExact == null) return { xrp: bid.xrp, exact: bid.exact };
  if (typeof bid.fundedXrp !== "bigint" || bid.fundedXrp <= 0n || !bid.fundedExact || bid.fundedExact.coeff <= 0n) return false;
  return { xrp: bid.fundedXrp, exact: bid.fundedExact };
}

function bookOut(bids, exact) {
  const rows = [];
  for (const bid of bids || []) {
    const sized = sizedBid(bid);
    if (sized === null) return null;
    if (sized === false) continue;
    rows.push(sized);
  }
  if (!rows.length || !exact || exact.coeff <= 0n) return null;
  rows.sort((left, right) => (moreXrp(left, right) ? -1 : moreXrp(right, left) ? 1 : 0));
  let left = exact.coeff;
  let exp = exact.exp;
  let total = 0n;
  for (const bid of rows) {
    if (left <= 0n) break;
    const span = Math.max(-exp, -bid.exact.exp, 0);
    const have = left * (10n ** BigInt(span + exp));
    const offer = width(bid.exact, span);
    if (have <= 0n || offer <= 0n) return null;
    const take = have <= offer ? have : offer;
    total += bid.xrp * take / offer;
    const next = have - take;
    left = next;
    exp = -span;
  }
  if (left > 0n) return null;
  return total > 0n ? total : null;
}

function netProceeds(pool, bids, exact, txFee) {
  if (typeof txFee !== "bigint" || txFee < 0n) return null;
  const fromPool = poolOut(pool, exact);
  const fromBook = bookOut(bids, exact);
  let best = null;
  if (fromPool != null) best = fromPool;
  if (fromBook != null && (best == null || fromBook > best)) best = fromBook;
  if (best == null || best <= txFee) return best == null ? null : 0n;
  return best - txFee;
}

function portion(cost, bought, sold) {
  if (typeof cost !== "bigint" || cost <= 0n) return null;
  if (!bought || !sold || bought.coeff <= 0n || sold.coeff <= 0n) return null;
  const span = Math.max(-bought.exp, -sold.exp, 0);
  const whole = width(bought, span);
  const part = width(sold, span);
  if (whole <= 0n || part <= 0n || part > whole) return null;
  return (cost * part + whole - 1n) / whole;
}

function settledSell(lotCost, lotExact, disposedExact, delta) {
  if (typeof lotCost !== "bigint" || lotCost <= 0n || typeof delta !== "bigint") return null;
  if (!lotExact || lotExact.coeff <= 0n || !disposedExact || disposedExact.coeff < 0n) return null;
  if (disposedExact.coeff === 0n) {
    if (delta > 0n) return { legacy: true };
    return {
      realized: delta,
      soldBasis: 0n,
      remainder: lotExact,
      remainderBasis: lotCost,
      full: false,
    };
  }
  const soldBasis = portion(lotCost, lotExact, disposedExact);
  if (soldBasis == null) return null;
  const span = Math.max(-lotExact.exp, -disposedExact.exp, 0);
  const whole = width(lotExact, span);
  const part = width(disposedExact, span);
  const left = whole - part;
  if (left < 0n) return null;
  const remainder = left === 0n ? null : { coeff: left, exp: -span };
  let remainderBasis = lotCost - soldBasis;
  if (remainder && remainderBasis <= 0n) remainderBasis = 1n;
  return {
    realized: delta - soldBasis,
    soldBasis,
    remainder,
    remainderBasis,
    full: left === 0n,
  };
}

function accountDelta(meta, account) {
  if (!account || account === anchors.WALLETS.W0.address) return null;
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  let seen = false;
  let delta = 0n;
  for (const node of nodes) {
    const body = node && node.ModifiedNode;
    if (!body || body.LedgerEntryType !== "AccountRoot") continue;
    const finalFields = body.FinalFields || {};
    const previous = body.PreviousFields || {};
    if ((finalFields.Account || previous.Account) !== account) continue;
    if (typeof finalFields.Balance !== "string" || typeof previous.Balance !== "string") return null;
    if (!/^[0-9]+$/.test(finalFields.Balance) || !/^[0-9]+$/.test(previous.Balance)) return null;
    delta += BigInt(finalFields.Balance) - BigInt(previous.Balance);
    seen = true;
  }
  return seen ? delta : null;
}

function provedSpend(meta, tx, account) {
  const delta = accountDelta(meta, account);
  if (delta == null || delta >= 0n) return null;
  const feeText = tx && tx.Fee;
  if (typeof feeText !== "string" || !/^[0-9]+$/.test(feeText)) return null;
  const spent = -delta;
  if (spent < BigInt(feeText)) return null;
  return spent.toString();
}

module.exports = {
  SCHEMA,
  FILE,
  DEFAULT_LOSS_CAP,
  DEFAULT_MARGIN,
  lossCap,
  sellMargin,
  isDay,
  read,
  inspect,
  record,
  lossOf,
  netProceeds,
  poolOut,
  portion,
  settledSell,
  accountDelta,
  provedSpend,
};
