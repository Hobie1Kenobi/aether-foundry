"use strict";

/**
 * Shared checks for the W3 outbound payer.
 * Refuses mainnet and every Foundry anchor in web/lib/xrpl-public.ts WALLETS.
 */

const fs = require("fs");
const path = require("path");
const rules = require("../web/lib/x402-rules");

const ROOT = path.resolve(__dirname, "..");
const WALLETS_FILE = path.join(ROOT, "web", "lib", "xrpl-public.ts");
const W3_ADDRESS = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
const XRPL_WS = "wss://s.altnet.rippletest.net:51233";

function envIsCi(env) {
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
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
    throw Object.assign(new Error("refusing unparseable XRPL url"), { code: "MAINNET" });
  }
  if (isMainnetUrl(raw)) {
    throw Object.assign(new Error("refusing mainnet XRPL url"), { code: "MAINNET" });
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".rippletest.net") && host !== "rippletest.net") {
    throw Object.assign(new Error("refusing non-testnet XRPL url"), { code: "MAINNET" });
  }
  return raw;
}

function foundryIndex(text) {
  const src = text == null ? fs.readFileSync(WALLETS_FILE, "utf8") : text;
  const start = src.indexOf("export const WALLETS");
  if (start < 0) throw new Error("WALLETS export missing from web/lib/xrpl-public.ts");
  const end = src.indexOf("} as const;", start);
  if (end < 0) throw new Error("WALLETS block missing from web/lib/xrpl-public.ts");
  const block = src.slice(start, end);
  const map = new Map();
  const re = /id:\s*"([^"]+)"[\s\S]*?address:\s*"(r[^"]+)"/g;
  let match = re.exec(block);
  while (match) {
    map.set(match[2], match[1]);
    match = re.exec(block);
  }
  if (map.size === 0) throw new Error("no Foundry addresses parsed from WALLETS");
  if (map.get(W3_ADDRESS) !== "W3") {
    throw new Error("W3 CHANNELS anchor missing from WALLETS");
  }
  return map;
}

function assertForeignPayTo(payTo, index) {
  const id = payTo === W3_ADDRESS ? "W3" : index.get(payTo);
  if (id) {
    throw Object.assign(
      new Error(
        `refusing Foundry payTo ${payTo} (${id}). W3 does not buy Foundry anchors.`
      ),
      { code: "FOUNDRY_PAYTO" }
    );
  }
}

function normalizeDrops(amount) {
  if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0) {
    return String(amount);
  }
  if (typeof amount === "string" && /^[0-9]+$/.test(amount)) return amount;
  return null;
}

function schemeOk(row) {
  return row.scheme == null || row.scheme === "exact";
}

function assetOk(row) {
  return row.asset == null || row.asset === "XRP";
}

function selectAccept(required) {
  if (!required || typeof required !== "object") {
    throw Object.assign(new Error("PAYMENT-REQUIRED is empty"), { code: "PARSE" });
  }
  if (required.x402Version !== 2) {
    throw Object.assign(new Error("x402Version must be 2"), { code: "PARSE" });
  }
  const accepts = Array.isArray(required.accepts) ? required.accepts : [];
  if (accepts.length === 0) {
    throw Object.assign(new Error("PAYMENT-REQUIRED has no accepts"), { code: "NO_ACCEPT" });
  }
  const mainnet = accepts.some(
    (row) => row && (row.network === "xrpl:0" || row.network === "xrpl-mainnet")
  );
  const chosen = accepts.find(
    (row) => row && row.network === "xrpl:1" && schemeOk(row) && assetOk(row)
  );
  if (!chosen) {
    throw Object.assign(
      new Error(mainnet ? "refusing mainnet xrpl:0" : "no xrpl:1 exact XRP accept"),
      { code: mainnet ? "MAINNET" : "NO_ACCEPT" }
    );
  }
  const amount = normalizeDrops(chosen.amount);
  if (amount == null) {
    throw Object.assign(new Error("accept.amount must be XRP drops"), { code: "AMOUNT" });
  }
  if (typeof chosen.payTo !== "string" || chosen.payTo.length === 0) {
    throw Object.assign(new Error("accept.payTo is missing"), { code: "PAYTO" });
  }
  return Object.assign({}, chosen, { amount });
}

function parsePaymentRequired(header, bodyText) {
  if (header) {
    const trimmed = String(header).trim();
    try {
      return rules.decodeHeader(trimmed);
    } catch {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* body fallback */
      }
    }
  }
  if (bodyText) {
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    if (body && body.paymentRequired && typeof body.paymentRequired === "object") {
      return body.paymentRequired;
    }
    if (body && Array.isArray(body.accepts)) return body;
  }
  throw Object.assign(new Error("could not parse PAYMENT-REQUIRED"), { code: "PARSE" });
}

function statedDiyDrops(required, accept, body) {
  const extra = accept && accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  const candidates = [
    extra.diyCostDrops,
    required && required.diyCostDrops,
    body && body.diyCostDrops,
    body && body.paymentRequired && body.paymentRequired.diyCostDrops,
  ];
  for (const candidate of candidates) {
    const drops = normalizeDrops(candidate);
    if (drops != null) return drops;
  }
  return null;
}

function resolveCeiling({ maxDropsFlag, envMax, statedDiy }) {
  if (maxDropsFlag != null && String(maxDropsFlag).length > 0) {
    if (!/^[0-9]+$/.test(String(maxDropsFlag))) {
      throw Object.assign(new Error("cost ceiling must be drops"), { code: "AMOUNT" });
    }
    return { ceiling: String(maxDropsFlag), source: "MAX_DROPS" };
  }
  if (envMax != null && String(envMax).length > 0) {
    if (!/^[0-9]+$/.test(String(envMax))) {
      throw Object.assign(new Error("MAX_DROPS must be drops"), { code: "AMOUNT" });
    }
    return { ceiling: String(envMax), source: "MAX_DROPS" };
  }
  if (statedDiy != null) return { ceiling: statedDiy, source: "stated DIY" };
  return { ceiling: null, source: null };
}

function priceVerdict(amount, ceiling) {
  if (ceiling == null) return { pay: true };
  if (BigInt(amount) > BigInt(ceiling)) {
    return { pay: false, message: "too expensive vs DIY" };
  }
  return { pay: true };
}

function buildPaymentTx({ account, accept }) {
  const tx = {
    TransactionType: "Payment",
    Account: account,
    Destination: accept.payTo,
    Amount: accept.amount,
  };
  const extra = accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  if (extra.sourceTag != null && extra.sourceTag !== "") {
    const tag = Number(extra.sourceTag);
    if (!Number.isInteger(tag) || tag < 0 || tag > 4294967295) {
      throw Object.assign(new Error("sourceTag is not a uint32"), { code: "AMOUNT" });
    }
    tx.SourceTag = tag;
  }
  if (typeof extra.invoiceId === "string" && extra.invoiceId.length > 0) {
    tx.Memos = [
      {
        Memo: {
          MemoType: Buffer.from("invoice", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from(extra.invoiceId, "utf8").toString("hex").toUpperCase(),
        },
      },
    ];
  }
  return tx;
}

function buildSignaturePayload({ required, accept, txBlob, hash }) {
  return {
    x402Version: 2,
    resource: required && required.resource,
    accepted: accept,
    payload: {
      signedTxBlob: txBlob,
      transaction: hash,
    },
  };
}

function assertResourceUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("RESOURCE_URL is not a URL"), { code: "PARSE" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("RESOURCE_URL must be http or https"), { code: "PARSE" });
  }
  return url.toString();
}

module.exports = {
  W3_ADDRESS,
  XRPL_WS,
  WALLETS_FILE,
  envIsCi,
  isMainnetUrl,
  assertTestnetUrl,
  foundryIndex,
  assertForeignPayTo,
  normalizeDrops,
  selectAccept,
  parsePaymentRequired,
  statedDiyDrops,
  resolveCeiling,
  priceVerdict,
  buildPaymentTx,
  buildSignaturePayload,
  assertResourceUrl,
  encodeHeader: rules.encodeHeader,
};
