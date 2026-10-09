"use strict";

/**
 * W6 grants flywheel policy. Pure checks. No seed values. No submit.
 * Payments leave W6. W0 is not the payer.
 */

const xrpl = require("xrpl");
const hosts = require("../xrpl-hosts");

const EXPERIMENT = "grants-flywheel";
const PURPOSE = "aether-grant";
const NETWORK = "XRPL Testnet";
const NETWORK_ID = 1;
const XRPL_HTTP = hosts.PRIMARY_HTTP;
const XRPL_WS = hosts.PRIMARY_WS;
const SECRETS_PATH = "/workspace/aether-foundry-secrets/.env";

const W0 = "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs";
const W2 = "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw";
const W3 = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
const W6 = "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf";
const AETH_HEX = "4145544800000000000000000000000000000000";

const DEFAULT_DROPS = "1000000";
const MOTION_DROPS = 50000000n;
const KEEP_SPENDABLE_DROPS = 10000000n;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_TX_LIMIT = 20;
const NFT_LIMIT = 20;
const SOURCE_TAG = 202609276;
const AETH_VALUE = "1";
const AETH_MAX_VALUE = 10;
const AETH_SEND_MAX_DROPS = "2000000";
const X402_SOURCE_TAGS = new Set([202609271, 202609272, 202609273]);

const REASONS = ["walk_in_acceptor", "x402_payer", "artifact_holder", "aeth_counterparty"];
const RANK = {
  walk_in_acceptor: 0,
  x402_payer: 1,
  artifact_holder: 2,
  aeth_counterparty: 3,
};

const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function envIsCi(env) {
  if (!env) return false;
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
}

function assertNotCi(env) {
  if (envIsCi(env)) throw coded("refusing to sign under CI", "CI");
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
    throw coded("refusing unparseable XRPL url", "MAINNET");
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("xahau")) throw coded("refusing Xahau host for W6 XRPL grants", "MAINNET");
  if (isMainnetUrl(raw)) throw coded("refusing mainnet XRPL url", "MAINNET");
  if (!hosts.isApprovedXrplTestnetHost(host)) {
    throw coded("refusing non-testnet XRPL url", "MAINNET");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw coded("refusing non-HTTP XRPL url", "MAINNET");
  }
  return raw.replace(/\/$/, "");
}

function assertWsUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coded("refusing unparseable XRPL websocket", "MAINNET");
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("xahau")) throw coded("refusing Xahau host for W6 XRPL grants", "MAINNET");
  if (isMainnetUrl(raw)) throw coded("refusing mainnet XRPL url", "MAINNET");
  if (!hosts.isApprovedXrplTestnetHost(host)) {
    throw coded("refusing non-testnet XRPL url", "MAINNET");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw coded("refusing non-websocket XRPL url", "MAINNET");
  }
  return raw;
}

function assertNetworkId(networkId) {
  if (networkId == null || networkId === "") return;
  const id = Number(networkId);
  if (id === 0) throw coded("refusing NetworkID 0", "MAINNET");
  if (id !== NETWORK_ID) throw coded(`refusing NetworkID ${networkId}`, "MAINNET");
}

function isClassic(address) {
  return typeof address === "string" && ADDRESS_RE.test(address);
}

function assertClassic(address, label) {
  if (!isClassic(address)) throw coded(`${label} is not a classic address`, "ADDRESS");
  return address;
}

function dropsOf(amount) {
  if (typeof amount === "bigint") {
    if (amount < 0n) throw coded("drops must be non-negative", "DROPS");
    return amount;
  }
  if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount) || amount < 0) throw coded("drops must be a safe integer", "DROPS");
    return BigInt(amount);
  }
  if (typeof amount === "string" && /^[0-9]+$/.test(amount)) return BigInt(amount);
  throw coded("drops must be an integer string", "DROPS");
}

function parseMotion(text) {
  const fields = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^\s*(destination|amount_drops|amount_xrp)\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

function motionCovers(text, destination, drops) {
  const fields = parseMotion(text);
  if (fields.destination !== destination) return false;
  const need = dropsOf(drops);
  if (fields.amount_drops != null) {
    try {
      return dropsOf(fields.amount_drops) === need;
    } catch {
      return false;
    }
  }
  if (fields.amount_xrp != null) {
    try {
      return BigInt(xrpl.xrpToDrops(fields.amount_xrp)) === need;
    } catch {
      return false;
    }
  }
  return false;
}

function assertGrantDrops(drops, destination, files) {
  const amount = dropsOf(drops);
  if (amount <= 0n) throw coded("grant drops must be positive", "DROPS");
  if (amount >= MOTION_DROPS) {
    assertClassic(destination, "grant destination");
    const list = Array.isArray(files) ? files : [];
    const hit = list.some((file) => motionCovers(file.text, destination, amount));
    if (!hit) {
      throw coded(
        `W6 grant of ${amount.toString()} drops to ${destination} needs a motion in /lab/motions/`,
        "MOTION"
      );
    }
  }
  return amount.toString();
}

function assertFloat(balance, ownerCount, reserveBase, reserveInc, drops) {
  const bal = dropsOf(balance);
  const reserve = dropsOf(reserveBase) + dropsOf(reserveInc) * BigInt(ownerCount);
  const pay = dropsOf(drops);
  const spendable = bal > reserve ? bal - reserve : 0n;
  const left = spendable - pay;
  if (left < KEEP_SPENDABLE_DROPS) {
    throw coded(
      `W6 grant of ${pay.toString()} drops would leave ${left.toString()} spendable drops, under the ${KEEP_SPENDABLE_DROPS.toString()} float`,
      "FLOAT"
    );
  }
  return { spendable: spendable.toString(), left: left.toString() };
}

function memo(type, data) {
  return {
    Memo: {
      MemoType: Buffer.from(type, "utf8").toString("hex").toUpperCase(),
      MemoData: Buffer.from(data, "utf8").toString("hex").toUpperCase(),
    },
  };
}

function grantMemos(reason) {
  if (!REASONS.includes(reason)) throw coded(`unknown grant reason ${reason}`, "REASON");
  return [memo("purpose", PURPOSE), memo("experiment", EXPERIMENT), memo("reason", reason)];
}

function decodeMemos(tx) {
  const list = tx && Array.isArray(tx.Memos) ? tx.Memos : [];
  const out = {};
  for (const wrapper of list) {
    const row = wrapper && wrapper.Memo;
    if (!row || !row.MemoType || !row.MemoData) continue;
    try {
      const type = Buffer.from(row.MemoType, "hex").toString("utf8");
      const data = Buffer.from(row.MemoData, "hex").toString("utf8");
      out[type] = data;
    } catch {
      /* skip malformed memo */
    }
  }
  return out;
}

function reasonFromMemos(tx) {
  const memos = decodeMemos(tx);
  if (memos.purpose !== PURPOSE) return "";
  if (memos.experiment !== EXPERIMENT) return "";
  return REASONS.includes(memos.reason) ? memos.reason : "";
}

function buildGrantPayment(opts) {
  const account = opts.account || W6;
  const destination = assertClassic(opts.destination, "grant destination");
  const drops = assertGrantDrops(opts.drops == null ? DEFAULT_DROPS : opts.drops, destination, opts.motions || []);
  if (account !== W6) throw coded("grant Account must be W6", "PAYER");
  if (destination === W6) throw coded("refusing a grant to W6", "FOUNDRY");
  const tx = {
    TransactionType: "Payment",
    Account: W6,
    Destination: destination,
    Amount: drops,
    SourceTag: SOURCE_TAG,
    Memos: grantMemos(opts.reason),
  };
  if (tx.NetworkID === 0) throw coded("refusing NetworkID 0", "MAINNET");
  xrpl.validate(tx);
  return tx;
}

function assertAethValue(value) {
  const text = value == null ? AETH_VALUE : String(value);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) throw coded("AETH grant value must be a decimal", "AETH");
  const amount = Number(text);
  if (!(amount > 0) || amount > AETH_MAX_VALUE) {
    throw coded(`refusing AETH grant above ${AETH_MAX_VALUE}`, "AETH");
  }
  return text;
}

function buildAethGrantPayment(opts) {
  const destination = assertClassic(opts.destination, "grant destination");
  if (opts.account && opts.account !== W6) throw coded("grant Account must be W6", "PAYER");
  if (destination === W6) throw coded("refusing a grant to W6", "FOUNDRY");
  const value = assertAethValue(opts.value);
  const sendMax = opts.sendMax == null ? AETH_SEND_MAX_DROPS : String(opts.sendMax);
  const send = dropsOf(sendMax);
  if (send <= 0n || send > dropsOf(AETH_SEND_MAX_DROPS)) {
    throw coded(`AETH SendMax must be 1..${AETH_SEND_MAX_DROPS} drops`, "AETH");
  }
  const tx = {
    TransactionType: "Payment",
    Account: W6,
    Destination: destination,
    Amount: {
      currency: AETH_HEX,
      issuer: W0,
      value,
    },
    SendMax: send.toString(),
    SourceTag: SOURCE_TAG,
    Memos: grantMemos(opts.reason || "aeth_counterparty"),
  };
  if (Array.isArray(opts.paths)) tx.Paths = opts.paths;
  if (tx.Flags) throw coded("refusing partial-payment flag on an AETH grant", "AETH");
  return tx;
}

function chooseAethPath(alternatives, maxDrops) {
  const cap = dropsOf(maxDrops == null ? AETH_SEND_MAX_DROPS : maxDrops);
  const list = Array.isArray(alternatives) ? alternatives : [];
  for (const alt of list) {
    const send = typeof alt.source_amount === "string" ? alt.source_amount : "";
    if (!/^[0-9]+$/.test(send)) continue;
    if (dropsOf(send) <= 0n || dropsOf(send) > cap) continue;
    if (!Array.isArray(alt.paths_computed) || alt.paths_computed.length === 0) continue;
    return { sendMax: send, paths: alt.paths_computed };
  }
  return null;
}

function signerMode(present) {
  const has = (name) => Boolean(present && present[name]);
  if (has("W6_REGULAR_SEED")) return "regular";
  if (has("W6_SEED") || has("GRANTS_SEED")) return "master";
  return "";
}

module.exports = {
  EXPERIMENT,
  PURPOSE,
  NETWORK,
  NETWORK_ID,
  XRPL_HTTP,
  XRPL_WS,
  SECRETS_PATH,
  W0,
  W2,
  W3,
  W6,
  AETH_HEX,
  DEFAULT_DROPS,
  MOTION_DROPS,
  KEEP_SPENDABLE_DROPS,
  COOLDOWN_MS,
  ACCOUNT_TX_LIMIT,
  NFT_LIMIT,
  SOURCE_TAG,
  AETH_VALUE,
  AETH_MAX_VALUE,
  AETH_SEND_MAX_DROPS,
  X402_SOURCE_TAGS,
  REASONS,
  RANK,
  ADDRESS_RE,
  coded,
  envIsCi,
  assertNotCi,
  isMainnetUrl,
  assertTestnetUrl,
  assertWsUrl,
  assertNetworkId,
  isClassic,
  assertClassic,
  dropsOf,
  parseMotion,
  motionCovers,
  assertGrantDrops,
  assertFloat,
  memo,
  grantMemos,
  decodeMemos,
  reasonFromMemos,
  buildGrantPayment,
  assertAethValue,
  buildAethGrantPayment,
  chooseAethPath,
  signerMode,
};
