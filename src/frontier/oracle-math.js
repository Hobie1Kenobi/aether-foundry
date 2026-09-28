"use strict";

/**
 * AETH/XRP mid and OracleSet field codec.
 * Ticket prices are decoded from an Oracle ledger node.
 * LastUpdateTime is UNIX seconds because OracleSet requires it.
 * Escrow FinishAfter stays Ripple Epoch and is built in oracle-ticket.js.
 */

const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const walkIn = require("../walk-in-public");
const { rippleNow } = require("../time/rippleEpoch");

const ORACLE_DOCUMENT_ID = 1;
const PRICE_SCALE = 8;
const SCALE_DIGITS = 10n ** BigInt(PRICE_SCALE);
const PROVIDER_ASCII = "aether-foundry";
const ASSET_CLASS_ASCII = "currency";
const README_URL =
  "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/native-price-oracle/README.md";
const INTENT = "oracle_set";
const AMM_WEIGHT = 0.7;
const CLOB_WEIGHT = 0.3;
const UINT64_MAX = (1n << 64n) - 1n;

const AETH_HEX = anchors.AETH_HEX;
const XRP_HEX = "0000000000000000000000000000000000000000";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function asciiHex(text) {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

function providerHex() {
  return asciiHex(PROVIDER_ASCII);
}

function assetClassHex() {
  return asciiHex(ASSET_CLASS_ASCII);
}

function readmeUriHex() {
  return walkIn.toHexUri(README_URL);
}

function isAeth(asset) {
  const code = String(asset || "").toUpperCase();
  return code === "AETH" || code === AETH_HEX;
}

function isXrp(asset) {
  const code = String(asset || "").toUpperCase();
  return code === "XRP" || code === XRP_HEX;
}

function decimalToScaled(text) {
  const raw = String(text);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw coded(`quote ${raw} is not a decimal`, "QUOTE");
  const [whole, frac = ""] = raw.split(".");
  const digits = (frac + "0".repeat(PRICE_SCALE)).slice(0, PRICE_SCALE);
  const roundUp = frac.length > PRICE_SCALE && frac[PRICE_SCALE] >= "5";
  let scaled = BigInt(whole) * SCALE_DIGITS + BigInt(digits);
  if (roundUp) scaled += 1n;
  if (scaled <= 0n || scaled > UINT64_MAX) throw coded("quote does not fit scale 8", "QUOTE");
  return scaled;
}

function scaledToDecimal(scaled) {
  const whole = scaled / SCALE_DIGITS;
  const frac = (scaled % SCALE_DIGITS).toString().padStart(PRICE_SCALE, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

function encodeQuote(xrpPerAeth) {
  const text = typeof xrpPerAeth === "string" ? xrpPerAeth : Number(xrpPerAeth).toFixed(PRICE_SCALE);
  if (typeof xrpPerAeth === "number" && !Number.isFinite(xrpPerAeth)) {
    throw coded("quote is not finite", "QUOTE");
  }
  const scaled = decimalToScaled(text);
  return {
    scale: PRICE_SCALE,
    asset_price: scaled.toString(10),
    asset_price_hex: scaled.toString(16),
    quote_xrp_per_aeth: scaledToDecimal(scaled),
  };
}

function parseAssetPrice(assetPrice) {
  const raw = String(assetPrice == null ? "" : assetPrice).trim();
  if (/^[0-9]+$/.test(raw)) return BigInt(raw);
  if (/^[0-9a-fA-F]+$/.test(raw)) return BigInt(`0x${raw}`);
  throw coded("AssetPrice is not an integer", "ORACLE");
}

function decodeScaled(assetPrice, scale) {
  const s = Number(scale);
  if (!Number.isInteger(s) || s < 0 || s > 10) throw coded("oracle Scale is not 0-10", "ORACLE");
  const n = parseAssetPrice(assetPrice);
  if (n < 0n) throw coded("AssetPrice is negative", "ORACLE");
  const den = 10n ** BigInt(s);
  const whole = n / den;
  const frac = (n % den).toString().padStart(s, "0").replace(/0+$/, "");
  const quote = s === 0 || !frac ? whole.toString() : `${whole.toString()}.${frac}`;
  return {
    scale: s,
    asset_price: n.toString(10),
    quote_xrp_per_aeth: quote,
  };
}

function dropsFromQuote(quote, units) {
  const labor = units == null ? 1 : Number(units);
  if (!Number.isInteger(labor) || labor < 1 || labor > 1000) {
    throw coded("labor units must be an integer from 1 to 1000", "QUOTE");
  }
  const raw = String(quote);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw coded("oracle quote is not a decimal", "ORACLE");
  const [whole, frac = ""] = raw.split(".");
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(whole + (frac || "0")) * 1000000n * BigInt(labor);
  const drops = (num + den / 2n) / den;
  if (drops <= 0n) throw coded("oracle quote rounds to 0 drops", "ORACLE");
  return drops.toString();
}

function spotFromAmm(amm) {
  if (!amm || typeof amm !== "object") throw coded("amm_info omitted amm", "RPC");
  let aethText = null;
  let xrpDrops = null;
  for (const part of [amm.amount, amm.amount2]) {
    if (typeof part === "string" && /^[0-9]+$/.test(part)) xrpDrops = part;
    else if (part && typeof part === "object" && part.currency && part.currency !== "XRP" && part.value != null) {
      aethText = String(part.value);
    }
  }
  if (!aethText || !xrpDrops) throw coded("amm_info omitted AETH and XRP amounts", "RPC");
  if (!/^\d+(\.\d+)?$/.test(aethText)) throw coded("amm AETH value is not decimal", "RPC");
  const [whole, frac = ""] = aethText.split(".");
  const den = 10n ** BigInt(frac.length);
  const aeth = BigInt(whole + (frac || "0"));
  if (aeth <= 0n) throw coded("amm AETH amount is zero", "RPC");
  const xrp = BigInt(xrpDrops);
  const spotNum = Number(xrp) / 1e6 / (Number(aeth) / Number(den));
  if (!Number.isFinite(spotNum) || spotNum <= 0) throw coded("amm spot is not positive", "RPC");
  return {
    spot_amm: spotNum,
    pool_aeth: aethText,
    pool_xrp_drops: xrpDrops,
  };
}

function priceFromOffer(offer, side) {
  if (!offer || typeof offer !== "object") return null;
  const pays = offer.TakerPays;
  const gets = offer.TakerGets;
  let xrpDrops;
  let aethValue;
  if (side === "ask") {
    if (typeof pays !== "string" || !gets || typeof gets !== "object") return null;
    xrpDrops = pays;
    aethValue = gets.value;
  } else {
    if (typeof gets !== "string" || !pays || typeof pays !== "object") return null;
    xrpDrops = gets;
    aethValue = pays.value;
  }
  const aeth = Number(aethValue);
  if (!aeth || !/^[0-9]+$/.test(String(xrpDrops))) return null;
  return Number(xrpDrops) / 1e6 / aeth;
}

function compositeQuote(spotAmm, bids, asks) {
  if (!Number.isFinite(spotAmm) || spotAmm <= 0) throw coded("spot_amm is not positive", "QUOTE");
  const bidPrices = (bids || []).map((row) => priceFromOffer(row, "bid")).filter((n) => n != null && n > 0);
  const askPrices = (asks || []).map((row) => priceFromOffer(row, "ask")).filter((n) => n != null && n > 0);
  const bestBid = bidPrices.length ? Math.max(...bidPrices) : null;
  const bestAsk = askPrices.length ? Math.min(...askPrices) : null;
  const thin = bestBid == null || bestAsk == null;
  const midClob = thin ? null : (bestBid + bestAsk) / 2;
  const weightAmm = thin ? 1 : AMM_WEIGHT;
  const weightClob = thin ? 0 : CLOB_WEIGHT;
  const quote = weightAmm * spotAmm + (midClob == null ? 0 : weightClob * midClob);
  if (!Number.isFinite(quote) || quote <= 0) throw coded("composite quote is not positive", "QUOTE");
  return {
    spot_amm: spotAmm,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid_clob: midClob,
    clob_thin: thin,
    weights: { amm: weightAmm, clob: weightClob },
    quote_xrp_per_aeth: quote,
    encoded: encodeQuote(quote),
  };
}

function rowsOf(feature) {
  if (feature && Array.isArray(feature.amendments)) return feature.amendments;
  const raw = feature && feature.features;
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([hash, row]) => Object.assign({ hash }, row || {}));
}

function assertPriceOracleEnabled(feature) {
  const rows = rowsOf(feature);
  if (!rows) throw coded("feature response omitted features", "AMENDMENT");
  const row = rows.find((item) => item && item.name === "PriceOracle");
  if (!row) throw coded("feature response omitted PriceOracle; refusing OracleSet", "AMENDMENT");
  if (row.enabled !== true) throw coded("PriceOracle is disabled; refusing OracleSet", "AMENDMENT");
  const hash = row.hash == null ? null : String(row.hash).toUpperCase();
  return {
    name: "PriceOracle",
    enabled: true,
    supported: row.supported === true,
    hash: hash && anchors.HASH_RE.test(hash) ? hash : null,
  };
}

function unixSeconds(now) {
  const clock = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const sec = Math.floor(clock.getTime() / 1000);
  if (!Number.isFinite(sec) || sec < 1_500_000_000) throw coded("LastUpdateTime clock is not unix", "QUOTE");
  return sec;
}

function buildOracleSet(opts) {
  const options = opts || {};
  const encoded = options.encoded || encodeQuote(options.quote_xrp_per_aeth);
  const when = unixSeconds(options.now);
  return {
    TransactionType: "OracleSet",
    Account: anchors.WALLETS.W5.address,
    OracleDocumentID: ORACLE_DOCUMENT_ID,
    Provider: providerHex(),
    URI: readmeUriHex(),
    AssetClass: assetClassHex(),
    LastUpdateTime: when,
    PriceDataSeries: [
      {
        PriceData: {
          BaseAsset: "AETH",
          QuoteAsset: "XRP",
          AssetPrice: encoded.asset_price_hex,
          Scale: encoded.scale,
        },
      },
    ],
    Memos: [
      grants.memo("purpose", "aether-oracle"),
      grants.memo("experiment", "native-price-oracle"),
    ],
  };
}

function priceDataList(node) {
  const series = node && node.PriceDataSeries;
  if (!Array.isArray(series)) return [];
  return series.map((row) => (row && row.PriceData) || row).filter(Boolean);
}

function oracleNode(result) {
  if (!result || typeof result !== "object") return null;
  if (result.node && typeof result.node === "object") return result.node;
  if (result.LedgerEntryType === "Oracle" || result.PriceDataSeries) return result;
  return null;
}

function readOraclePrice(result) {
  const node = oracleNode(result);
  if (!node) throw coded("ledger_entry omitted the Oracle node", "ORACLE");
  const pair = priceDataList(node).find((row) => isAeth(row.BaseAsset) && isXrp(row.QuoteAsset));
  if (!pair || pair.AssetPrice == null || pair.Scale == null) {
    throw coded("oracle omitted the AETH/XRP pair", "ORACLE");
  }
  const decoded = decodeScaled(pair.AssetPrice, pair.Scale);
  const index = result.index || result.node_index || node.index || null;
  const oracleId = index && anchors.HASH_RE.test(String(index).toUpperCase()) ? String(index).toUpperCase() : null;
  const ledger = Number.isInteger(result.ledger_index) && result.ledger_index > 0 ? result.ledger_index : null;
  const updated = Number(node.LastUpdateTime);
  return {
    oracle_id: oracleId,
    account: typeof node.Owner === "string" ? node.Owner : anchors.WALLETS.W5.address,
    oracle_document_id: node.OracleDocumentID == null ? ORACLE_DOCUMENT_ID : Number(node.OracleDocumentID),
    last_update_time: Number.isInteger(updated) && updated > 0 ? updated : null,
    quote_xrp_per_aeth: decoded.quote_xrp_per_aeth,
    asset_price: decoded.asset_price,
    scale: decoded.scale,
    ledger_index: ledger,
    base_asset: "AETH",
    quote_asset: "XRP",
  };
}

function ticketUri(price) {
  const quote = encodeURIComponent(price.quote_xrp_per_aeth);
  const id = price.oracle_id || "";
  const ledger = price.ledger_index == null ? "" : String(price.ledger_index);
  return `${README_URL}#oracle=${id}&quote=${quote}&ledger=${ledger}&doc=${ORACLE_DOCUMENT_ID}`;
}

function buildTicket(price, opts) {
  const options = opts || {};
  const units = options.labor_units == null ? 1 : options.labor_units;
  const drops = dropsFromQuote(price.quote_xrp_per_aeth, units);
  const now = options.now instanceof Date ? options.now : new Date(options.now == null ? Date.now() : options.now);
  const finishAfter = rippleNow(now) + 120;
  const cancelAfter = rippleNow(now) + 3600;
  const uri = ticketUri(price);
  return {
    source: "ledger_entry",
    labor_units_aeth: units,
    labor_drops: drops,
    quote_xrp_per_aeth: price.quote_xrp_per_aeth,
    oracle_id: price.oracle_id,
    mint: {
      TransactionType: "NFTokenMint",
      Account: anchors.WALLETS.W2.address,
      URI: walkIn.toHexUri(uri),
      Flags: walkIn.TF_TRANSFERABLE,
      TransferFee: walkIn.TRANSFER_FEE,
      NFTokenTaxon: walkIn.TAXON,
    },
    sell: {
      TransactionType: "NFTokenCreateOffer",
      Account: anchors.WALLETS.W2.address,
      Amount: drops,
      Flags: walkIn.TF_SELL_NFTOKEN,
    },
    escrow: {
      TransactionType: "EscrowCreate",
      Destination: anchors.WALLETS.W4.address,
      Amount: drops,
      FinishAfter: finishAfter,
      CancelAfter: cancelAfter,
    },
    uri,
  };
}

function ledgerEntryParams() {
  return {
    oracle: {
      account: anchors.WALLETS.W5.address,
      oracle_document_id: ORACLE_DOCUMENT_ID,
    },
    ledger_index: "validated",
  };
}

module.exports = {
  ORACLE_DOCUMENT_ID,
  PRICE_SCALE,
  INTENT,
  README_URL,
  PROVIDER_ASCII,
  ASSET_CLASS_ASCII,
  AMM_WEIGHT,
  CLOB_WEIGHT,
  coded,
  asciiHex,
  providerHex,
  assetClassHex,
  encodeQuote,
  decodeScaled,
  dropsFromQuote,
  spotFromAmm,
  priceFromOffer,
  compositeQuote,
  assertPriceOracleEnabled,
  unixSeconds,
  buildOracleSet,
  readOraclePrice,
  buildTicket,
  ledgerEntryParams,
  isAeth,
  isXrp,
};
