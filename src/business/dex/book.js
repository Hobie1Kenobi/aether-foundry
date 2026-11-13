"use strict";

const { coded } = require("../../missions/ledger");
const anchors = require("../../director/anchors");
const policy = require("../../missions/policy");
const market = require("./market");
const rlusd = require("./rlusd");

const REGULAR = {
  W3: "rJRxr1E1Dzz5TXJsCHhwQAm4qS68Y73dQj",
  W4: "rfXBxqPjprj1J5Ekq5v82D3BDqRm7ms7p2",
  W5: "rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q",
};

function outside(account, self) {
  if (!account || account === self) return false;
  if (policy.isHouse(account)) return false;
  if (account === rlusd.AMM || account === anchors.AMM || account === rlusd.ISSUER) return false;
  return true;
}

function exactOf(value) {
  if (!value || value.issuer !== rlusd.ISSUER || value.currency !== rlusd.CURRENCY) return null;
  const exact = market.exactIou(value.value);
  if (!exact || exact.coeff <= 0n) return null;
  return exact;
}

function marketXrp(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function bookSide(offers, side, self) {
  const rows = [];
  for (const row of offers || []) {
    if (!row || typeof row.Account !== "string") throw coded("RLUSD offer has no account", "UNCERTAIN");
    if (!outside(row.Account, self)) continue;
    const xrp = side === "bid" ? marketXrp(row.TakerGets) : marketXrp(row.TakerPays);
    const raw = side === "bid" ? row.TakerPays : row.TakerGets;
    const exact = exactOf(raw);
    if (xrp == null || !exact || xrp <= 0n) throw coded("RLUSD offer amount cannot be priced", "UNCERTAIN");
    rows.push({ account: row.Account, xrp, exact, value: raw.value });
  }
  return rows;
}

function lineBalance(lines) {
  const held = (lines || []).filter((line) => line && line.currency === rlusd.CURRENCY && line.account === rlusd.ISSUER);
  if (held.length > 1) throw coded("RLUSD balance is ambiguous", "UNCERTAIN");
  if (held.length === 0) return { coeff: 0n, exp: 0 };
  if (typeof held[0].balance === "string" && held[0].balance.startsWith("-")) throw coded("RLUSD balance is debt", "UNCERTAIN");
  const exact = market.exactIou(held[0].balance || "0");
  if (!exact) throw coded("RLUSD balance cannot be valued", "UNCERTAIN");
  return exact;
}

async function load(ledger, account, regularKey) {
  if (account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  const info = await ledger.request({ command: "account_info", account, ledger_index: "validated" });
  const data = info && info.result && info.result.account_data;
  if (!info.result || info.result.validated !== true || !data || data.Account !== account) {
    throw coded("validated role account is missing", "LEDGER");
  }
  if (regularKey && data.RegularKey !== regularKey) throw coded("role regular key is not the pinned signer", "REGULAR_KEY");
  const lines = await ledger.request({ command: "account_lines", account, ledger_index: "validated" });
  const page = lines && lines.result;
  if (!page || page.validated !== true || page.marker != null || !Array.isArray(page.lines)) {
    throw coded("validated trust lines are missing", "UNCERTAIN");
  }
  const amm = await ledger.request({
    command: "amm_info",
    asset: { currency: "XRP" },
    asset2: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER },
    ledger_index: "validated",
  });
  const body = amm && amm.result && amm.result.amm;
  if (!amm.result || amm.result.validated !== true || !body || body.account !== rlusd.AMM) {
    throw coded("RLUSD AMM is not the allowlisted pool", "POOL");
  }
  const server = await ledger.request({ command: "server_info" });
  const infoBody = server && server.result && server.result.info;
  if (!infoBody || Number(infoBody.network_id) !== 1) throw coded("socket did not prove xrpl network id 1", "MAINNET");
  const xrp = typeof body.amount === "string" ? BigInt(body.amount) : (typeof body.amount2 === "string" ? BigInt(body.amount2) : null);
  const iouValue = body.amount2 && typeof body.amount2 === "object" ? body.amount2 : body.amount;
  const exact = exactOf(iouValue);
  if (xrp == null || !exact || !Number.isInteger(body.trading_fee)) throw coded("RLUSD pool assets cannot be valued", "VALUATION");
  const bids = await ledger.request({
    command: "book_offers",
    taker_gets: { currency: "XRP" },
    taker_pays: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER },
    ledger_index: "validated",
    limit: 20,
  });
  const asks = await ledger.request({
    command: "book_offers",
    taker_gets: { currency: rlusd.CURRENCY, issuer: rlusd.ISSUER },
    taker_pays: { currency: "XRP" },
    ledger_index: "validated",
    limit: 20,
  });
  for (const side of [bids, asks]) {
    if (!side.result || side.result.validated !== true || side.result.marker != null || !Array.isArray(side.result.offers)) {
      throw coded("RLUSD book is incomplete", "UNCERTAIN");
    }
  }
  const offers = await ledger.request({ command: "account_offers", account, ledger_index: "validated" });
  const ownPage = offers && offers.result;
  if (!ownPage || ownPage.validated !== true || ownPage.marker != null || !Array.isArray(ownPage.offers)) {
    throw coded("validated role offers are missing", "UNCERTAIN");
  }
  const fee = await ledger.request({ command: "fee" });
  const openFee = fee && fee.result && fee.result.drops && fee.result.drops.open_ledger_fee;
  if (typeof openFee !== "string" || !/^[0-9]+$/.test(openFee)) throw coded("open ledger fee is outside the local bound", "FEE_CAP");
  const feeDrops = BigInt(openFee);
  if (feeDrops <= 0n || feeDrops > 10000n) throw coded("open ledger fee is outside the local bound", "FEE_CAP");
  const ledgerSeq = infoBody.validated_ledger && infoBody.validated_ledger.seq;
  const reserveText = infoBody.validated_ledger && infoBody.validated_ledger.reserve_inc_xrp;
  const reserveInc = typeof reserveText === "number" ? BigInt(Math.round(reserveText * 1000000)) : null;
  const reserveParsed = typeof reserveText === "string" && /^\d+(\.\d{1,6})?$/.test(reserveText)
    ? BigInt(reserveText.split(".")[0]) * 1000000n + BigInt(((reserveText.split(".")[1] || "") + "000000").slice(0, 6))
    : reserveInc;
  if (!Number.isInteger(ledgerSeq) || ledgerSeq <= 0 || reserveParsed == null || reserveParsed <= 0n) {
    throw coded("validated testnet ledger is missing", "LEDGER");
  }
  if (!Number.isInteger(data.Sequence) || data.Sequence <= 0) throw coded("validated sequence is missing", "LEDGER");
  return {
    trustline: page.lines.some((line) => line && line.currency === rlusd.CURRENCY && line.account === rlusd.ISSUER),
    pool: { xrp, exact, tradingFee: body.trading_fee, account: body.account },
    bids: bookSide(bids.result.offers, "bid", account),
    asks: bookSide(asks.result.offers, "ask", account),
    own: ownPage.offers,
    balance: lineBalance(page.lines),
    shot: {
      fee: feeDrops,
      sequence: data.Sequence,
      validatedLedger: ledgerSeq,
      reserveInc: reserveParsed,
      networkId: 1,
    },
  };
}

function counterparties(meta, self) {
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  const found = [];
  for (const node of nodes) {
    const body = node && (node.CreatedNode || node.ModifiedNode || node.DeletedNode);
    if (!body) continue;
    const fields = body.FinalFields || body.NewFields || body.PreviousFields || {};
    const account = fields.Account;
    if (body.LedgerEntryType === "Offer" && typeof account === "string" && account !== self && !found.includes(account)) {
      found.push(account);
    }
    if (body.LedgerEntryType === "AccountRoot" && typeof account === "string" && account !== self && !found.includes(account)) {
      found.push(account);
    }
  }
  const txAccount = meta && meta.Account;
  if (typeof txAccount === "string" && txAccount !== self && !found.includes(txAccount)) found.push(txAccount);
  return {
    accounts: found,
    outside_accounts: found.filter((account) => outside(account, self)),
    house_accounts: found.filter((account) => !outside(account, self)),
    outside: found.some((account) => outside(account, self)),
  };
}

module.exports = {
  REGULAR,
  outside,
  load,
  exactOf,
  counterparties,
};
