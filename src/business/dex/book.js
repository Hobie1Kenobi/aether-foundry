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

function balanceText(balance) {
  if (typeof balance === "string") return balance;
  if (!balance || typeof balance !== "object" || typeof balance.value !== "string") return null;
  if (balance.currency != null && balance.currency !== rlusd.CURRENCY) return null;
  return balance.value;
}

function orient(fields, account) {
  if (!fields || !fields.HighLimit || !fields.LowLimit) return null;
  const high = fields.HighLimit;
  const low = fields.LowLimit;
  const currency = high.currency || low.currency;
  const issuers = [high.issuer, low.issuer];
  if (currency !== rlusd.CURRENCY) return null;
  if (issuers.some((issuer) => String(issuer || "").includes("rKmPxq"))) return null;
  if (!issuers.includes(rlusd.ISSUER) || !issuers.includes(account)) return null;
  const text = balanceText(fields.Balance);
  if (text == null) return null;
  const neg = text.startsWith("-");
  const exact = market.exactIou(neg ? text.slice(1) : text);
  if (!exact) return null;
  let sign = 1;
  if (low.issuer === account && high.issuer === rlusd.ISSUER) sign = 1;
  else if (high.issuer === account && low.issuer === rlusd.ISSUER) sign = -1;
  else return null;
  if (neg) sign = -sign;
  return { sign, coeff: exact.coeff, exp: exact.exp };
}

function overlay(finalFields, previous) {
  if (!finalFields && !previous) return null;
  return Object.assign({}, finalFields || {}, previous || {});
}

function width(amount, span) {
  if (!amount || amount.coeff === 0n) return 0n;
  const mag = amount.coeff * (10n ** BigInt(span + amount.exp));
  return amount.sign < 0 ? -mag : mag;
}

function heldWidth(amount, span) {
  const value = width(amount, span);
  return value > 0n ? value : 0n;
}

function formatSpan(value, span) {
  if (value === 0n) return "0";
  const neg = value < 0n;
  const mag = neg ? -value : value;
  const digits = mag.toString();
  let text;
  if (span <= 0) text = `${digits}${"0".repeat(-span)}`;
  else if (digits.length > span) {
    const whole = digits.slice(0, digits.length - span);
    const frac = digits.slice(digits.length - span).replace(/0+$/, "");
    text = frac ? `${whole}.${frac}` : whole;
  } else {
    text = `0.${"0".repeat(span - digits.length)}${digits}`.replace(/0+$/, "");
  }
  return neg ? `-${text}` : text;
}

function nodeDelta(node, account) {
  if (node.CreatedNode && node.CreatedNode.LedgerEntryType === "RippleState") {
    const after = orient(node.CreatedNode.NewFields, account);
    if (!after) return null;
    return { before: { sign: 1, coeff: 0n, exp: 0 }, after };
  }
  if (node.DeletedNode && node.DeletedNode.LedgerEntryType === "RippleState") {
    const body = node.DeletedNode;
    const before = orient(overlay(body.FinalFields, body.PreviousFields), account);
    if (!before) return null;
    return { before, after: { sign: 1, coeff: 0n, exp: 0 } };
  }
  if (node.ModifiedNode && node.ModifiedNode.LedgerEntryType === "RippleState") {
    const body = node.ModifiedNode;
    const after = orient(body.FinalFields, account);
    const before = orient(overlay(body.FinalFields, body.PreviousFields), account);
    if (!after && !before) return null;
    if (!after || !before) return false;
    return { before, after };
  }
  return null;
}

function rlusdAcquired(meta, account) {
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  const parts = [];
  for (const node of nodes) {
    if (!node) continue;
    const delta = nodeDelta(node, account);
    if (delta === false) return null;
    if (delta) parts.push(delta);
  }
  if (!parts.length) return null;
  const span = parts.reduce((max, part) => Math.max(max, -part.before.exp, -part.after.exp, 0), 0);
  const gains = [];
  for (const part of parts) {
    const gain = heldWidth(part.after, span) - heldWidth(part.before, span);
    if (gain > 0n) gains.push(gain);
  }
  if (gains.length > 1) return null;
  if (gains.length === 0) return "0";
  const text = formatSpan(gains[0], span);
  return market.exactIou(text) ? text : null;
}

function atMost(text, ceiling) {
  if (typeof text !== "string" || typeof ceiling !== "string") return null;
  const got = market.exactIou(text);
  const cap = market.exactIou(ceiling);
  if (!got || got.coeff <= 0n || !cap || cap.coeff <= 0n) return null;
  const span = Math.max(-got.exp, -cap.exp, 0);
  const mag = (exact) => exact.coeff * (10n ** BigInt(span + exact.exp));
  return mag(got) <= mag(cap) ? text : ceiling;
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

function sameSequence(mission, tx) {
  if (!mission || mission.sequence == null || mission.sequence === "") return true;
  const seq = typeof mission.sequence === "number" ? mission.sequence : (/^[0-9]+$/.test(String(mission.sequence)) ? Number(mission.sequence) : NaN);
  return Number.isInteger(seq) && tx.Sequence === seq;
}

function trustSettled(result, mission, account) {
  const meta = result && (result.meta || result.metaData);
  const tx = result && (result.tx_json || result);
  if (!result || result.error || result.validated !== true || !meta || meta.TransactionResult !== "tesSUCCESS") return null;
  if (!tx || tx.TransactionType !== "TrustSet" || tx.Account !== account) return null;
  const limit = tx.LimitAmount;
  if (!limit || typeof limit !== "object" || limit.currency !== rlusd.CURRENCY || limit.issuer !== rlusd.ISSUER) return null;
  if (String(limit.issuer).includes("rKmPxq")) return null;
  const hash = String(result.hash || "").toUpperCase();
  const wanted = String(mission && mission.signed_hash || "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash) || hash !== wanted) return null;
  if (!sameSequence(mission, tx)) return null;
  if (!Number.isInteger(result.ledger_index) || result.ledger_index <= 0) return null;
  return {
    status: "rlusd_proved",
    hold: "uncertain",
    outstanding_drops: "0",
    proof_hash: hash,
    proof_result: "tesSUCCESS",
    proof_type: "trust_set",
    validated_ledger: result.ledger_index,
    outside_fill: false,
    settled: true,
  };
}

module.exports = {
  REGULAR,
  outside,
  load,
  exactOf,
  rlusdAcquired,
  atMost,
  counterparties,
  trustSettled,
};
