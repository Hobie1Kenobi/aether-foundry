"use strict";

/**
 * Fresh validated inventory. The published AMM address is an allowlist
 * candidate, not a stored pool state. A failed read does not fall back
 * to a previous snapshot.
 */

const { coded } = require("../../missions/ledger");
const anchors = require("../../director/anchors");
const bounds = require("./bounds");

const SCALE = 10n ** 15n;
const XRP = { currency: "XRP" };

function scaled(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,15})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((frac + "0".repeat(15)).slice(0, 15));
}

function xrpDrops(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function isAeth(value) {
  if (!value || value.currency !== bounds.AETH || value.issuer !== bounds.ISSUER) return false;
  if (typeof value.value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value.value)) return false;
  return scaled(value.value) != null;
}

function pair(amm) {
  const firstXrp = xrpDrops(amm.amount);
  const secondXrp = xrpDrops(amm.amount2);
  if (firstXrp != null && isAeth(amm.amount2)) return { xrp: firstXrp, aeth: amm.amount2 };
  if (secondXrp != null && isAeth(amm.amount)) return { xrp: secondXrp, aeth: amm.amount };
  return null;
}

function lineAeth(page, lpCurrency) {
  const held = page.lines.filter((line) => line && line.currency === bounds.AETH && line.account === bounds.ISSUER);
  if (held.length > 1) throw coded("AETH balance is ambiguous", "VALUATION");
  if (held.length === 0) return { walletAeth: 0n, aethFrozen: false, aethDebt: false };
  const line = held[0];
  if (line.currency === lpCurrency) return { walletAeth: 0n, aethFrozen: false, aethDebt: false };
  const balance = scaled(typeof line.balance === "string" && line.balance.startsWith("-") ? null : line.balance);
  if (typeof line.balance === "string" && line.balance.startsWith("-")) return { walletAeth: 0n, aethFrozen: false, aethDebt: true };
  if (balance == null) throw coded("AETH balance cannot be valued", "VALUATION");
  const frozen = line.freeze === true || line.freeze_peer === true || line.authorized === false;
  return { walletAeth: balance, aethFrozen: frozen, aethDebt: false };
}

function parsePool(response, lines) {
  const result = response && response.result;
  const amm = result && result.amm;
  if (!result || result.validated !== true || !amm) throw coded("validated AMM state is missing", "UNCERTAIN");
  if (amm.account !== anchors.AMM) throw coded("AMM account is not the allowlisted pool", "POOL");
  const assets = pair(amm);
  const lp = amm.lp_token;
  const supply = lp && lp.issuer === amm.account ? scaled(lp.value) : null;
  if (!assets || assets.xrp <= 0n || supply == null || supply <= 0n) throw coded("AMM assets cannot be valued", "VALUATION");
  if (!Number.isInteger(amm.trading_fee) || amm.trading_fee < 0 || amm.trading_fee >= 100000) {
    throw coded("AMM trading fee is missing", "VALUATION");
  }
  const page = lines && lines.result;
  if (!page || page.validated !== true || page.account !== bounds.ACCOUNT || page.marker != null || !Array.isArray(page.lines)) {
    throw coded("validated LP balance is missing", "UNCERTAIN");
  }
  const held = page.lines.filter((line) => line && line.account === amm.account && line.currency === lp.currency);
  if (held.length > 1) throw coded("LP balance is ambiguous", "VALUATION");
  const balanceText = held.length === 0 ? "0" : held[0].balance;
  const balance = scaled(balanceText);
  if (balance == null || balance < 0n || balance > supply) throw coded("LP balance cannot be valued", "VALUATION");
  return {
    account: amm.account,
    xrp: assets.xrp,
    aeth: assets.aeth,
    aethScaled: scaled(assets.aeth.value),
    supply,
    balance,
    balanceText,
    currency: lp.currency,
    sole: balance > 0n && balance === supply,
    tradingFee: amm.trading_fee,
    ledgerIndex: result.ledger_index,
    wallet: lineAeth(page, lp.currency),
  };
}

function parseOffers(response) {
  const result = response && response.result;
  if (!result || result.validated !== true || result.account !== bounds.ACCOUNT || result.marker != null || !Array.isArray(result.offers)) {
    throw coded("validated account offers are missing", "UNCERTAIN");
  }
  return result.offers.map((row) => {
    const gets = row && (row.taker_gets != null ? row.taker_gets : row.TakerGets);
    const locked = xrpDrops(gets);
    if (locked == null) throw coded("offer lock is not XRP", "OFFER");
    return { seq: row.seq != null ? row.seq : row.Sequence, locked };
  });
}

function sideDrops(value) {
  return xrpDrops(value);
}

function parseBook(response) {
  const result = response && response.result;
  if (!result || result.validated !== true || result.marker != null || !Array.isArray(result.offers)) {
    throw coded("validated order book is missing", "UNCERTAIN");
  }
  const quotes = [];
  const bids = [];
  let unbounded = 0;
  for (const row of result.offers) {
    if (!row || typeof row.Account !== "string") throw coded("book offer has no account", "UNCERTAIN");
    if (row.Account === bounds.ACCOUNT || row.Account === bounds.ISSUER || row.Account === anchors.AMM) continue;
    const paysXrp = sideDrops(row.TakerPays);
    const getsXrp = sideDrops(row.TakerGets);
    const xrp = paysXrp != null ? paysXrp : getsXrp;
    if (xrp == null || xrp <= 0n) continue;
    if (xrp > require("../bankroll").BANKROLL_DROPS) {
      unbounded += 1;
      continue;
    }
    const aethSide = isAeth(row.TakerGets) ? row.TakerGets : (isAeth(row.TakerPays) ? row.TakerPays : null);
    if (!aethSide) continue;
    quotes.push({ account: row.Account, paysXrp, getsXrp, size: xrp });
    if (getsXrp != null && isAeth(row.TakerPays)) {
      bids.push({ account: row.Account, xrp: getsXrp, aeth: scaled(row.TakerPays.value) });
    }
  }
  return { quotes, bids, unbounded };
}

function parseAccount(response, server) {
  const info = server && server.result && server.result.info;
  const ledger = info && info.validated_ledger;
  if (!info || Number(info.network_id) !== 1 || !ledger) throw coded("validated testnet ledger is missing", "LEDGER");
  const reserveBase = require("./snapshot").xrpToDrops(ledger.reserve_base_xrp);
  const reserveInc = require("./snapshot").xrpToDrops(ledger.reserve_inc_xrp);
  const result = response && response.result;
  const data = result && result.account_data;
  if (!result || result.validated !== true || !data || data.Account !== bounds.ACCOUNT) throw coded("validated W1 account is missing", "LEDGER");
  if (reserveBase == null || reserveInc == null) throw coded("validated reserve is missing", "RESERVE");
  if (!Number.isInteger(data.OwnerCount) || data.OwnerCount < 0) throw coded("validated owner count is missing", "RESERVE");
  const balance = xrpDrops(data.Balance);
  if (balance == null) throw coded("validated balance is missing", "LEDGER");
  return { reserveBase, reserveInc, ownerCount: BigInt(data.OwnerCount), balance };
}

async function load(ledger) {
  const server = await ledger.request({ command: "server_info" });
  const account = await ledger.request({ command: "account_info", account: bounds.ACCOUNT, ledger_index: "validated" });
  const info = parseAccount(account, server);
  const amm = await ledger.request({
    command: "amm_info",
    asset: XRP,
    asset2: { currency: bounds.AETH, issuer: bounds.ISSUER },
    ledger_index: "validated",
  });
  const lines = await ledger.request({ command: "account_lines", account: bounds.ACCOUNT, ledger_index: "validated" });
  const offers = await ledger.request({ command: "account_offers", account: bounds.ACCOUNT, ledger_index: "validated" });
  const book = await ledger.request({
    command: "book_offers",
    taker_gets: XRP,
    taker_pays: { currency: bounds.AETH, issuer: bounds.ISSUER },
    ledger_index: "validated",
    limit: 20,
  });
  const pool = parsePool(amm, lines);
  const parsedBook = parseBook(book);
  return Object.assign({
    proved: true,
    pool,
    offers: parseOffers(offers),
    foreign: parsedBook.quotes,
    bids: parsedBook.bids,
    unbounded: parsedBook.unbounded,
    walletAeth: pool.wallet.walletAeth,
    aethFrozen: pool.wallet.aethFrozen,
    aethDebt: pool.wallet.aethDebt,
  }, info);
}

function slippage(pool, dx) {
  if (!pool || pool.xrp <= 0n || pool.aethScaled <= 0n || dx <= 0n) throw coded("pool price is missing", "VALUATION");
  const fee = BigInt(pool.tradingFee);
  const net = (dx * (100000n - fee)) / 100000n;
  if (net <= 0n) throw coded("probe is smaller than the trading fee", "VALUATION");
  const out = (pool.aethScaled * net) / (pool.xrp + net);
  const spot = (pool.aethScaled * dx) / pool.xrp;
  if (spot <= 0n || out < 0n || out > spot) throw coded("pool quote is not conservative", "VALUATION");
  const impact = ((spot - out) * 10000n) / spot;
  return {
    probe_drops: dx.toString(),
    impact_bps: impact.toString(),
    fee_ppm: fee.toString(),
  };
}

module.exports = {
  SCALE,
  XRP,
  scaled,
  load,
  parsePool,
  parseBook,
  slippage,
};
