"use strict";

/**
 * Foundry Box allowlist. Pure checks. No seed values. No submit.
 * Caps and account ids are hardcoded. allowlist.json must match them.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const directorSchema = require("../director/schema");
const grants = require("../grants/policy");
const guard = require("../x402-outbound-guard");
const walkIn = require("../walk-in-public");

const ALLOWLIST_PATH = path.join(__dirname, "allowlist.json");
const STALE_MS = anchors.MAX_AGE_HOURS * 60 * 60 * 1000;
const FIFTY_XRP_DROPS = grants.MOTION_DROPS;
const GRANT_MAX_DROPS = 1000000n;
const OUTBOUND_MAX_DROPS = 500000n;
const HEARTBEAT_MAX_DROPS = 1000n;
const HEARTBEAT_DEFAULT_DROPS = "1";
const HEARTBEAT_MAX_PER_DAY = 4;
const HEARTBEAT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_SOURCE_TAG = 202609280;
const DAY_MS = 24 * 60 * 60 * 1000;
const BANNED_TYPES = new Set(["Batch", "EscrowFinish", "EscrowCancel", "SetHook"]);
const KEY_ENVS = ["W2_REGULAR_SEED", "W3_REGULAR_SEED", "W5_REGULAR_SEED", "W6_REGULAR_SEED"];

const SPEC = {
  walk_in_remint: {
    account: "W2",
    address: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
    key_env: "W2_REGULAR_SEED",
    max_offer_drops: walkIn.AMOUNT_DROPS,
    signs: true,
  },
  grant_pay: {
    account: "W6",
    address: "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
    key_env: "W6_REGULAR_SEED",
    max_drops: "1000000",
    signs: true,
  },
  heartbeat: {
    account: "W5",
    address: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
    key_env: "W5_REGULAR_SEED",
    default_drops: "1",
    max_drops: "1000",
    signs: true,
  },
  x402_outbound: {
    account: "W3",
    address: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
    key_env: "W3_REGULAR_SEED",
    max_drops: "500000",
    signs: true,
  },
  director_snapshot: {
    account: null,
    address: null,
    key_env: null,
    max_drops: "0",
    signs: false,
  },
};

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function envIsCi(env) {
  return grants.envIsCi(env || {});
}

function assertNotCi(env) {
  if (envIsCi(env)) throw coded("refusing to sign under CI", "CI");
}

function assertLiveGate(env) {
  assertNotCi(env);
  if (!env || env.FOUNDRY_DAEMON_LIVE !== "yes") {
    throw coded("refusing --live without FOUNDRY_DAEMON_LIVE=yes", "LIVE_GATE");
  }
}

function assertNoSeedFields(value) {
  try {
    directorSchema.assertNoSecrets(value);
  } catch (error) {
    throw coded(error.message, "SCHEMA");
  }
}

function same(got, expect, label) {
  if (got !== expect) throw coded(`${label} drifted`, "ALLOWLIST");
}

function assertAllowlist(doc) {
  assertNoSeedFields(doc);
  if (!doc || doc.schema !== "aether.foundry-runtime.allowlist") {
    throw coded("allowlist schema drifted", "ALLOWLIST");
  }
  if (doc.network_id !== anchors.XRPL_NETWORK_ID) throw coded("allowlist network_id drifted", "ALLOWLIST");
  if (doc.xahau_network_id !== anchors.XAHAU_NETWORK_ID) throw coded("allowlist xahau id drifted", "ALLOWLIST");
  if (!Array.isArray(doc.refused_network_ids) || doc.refused_network_ids.join(",") !== "0,21337") {
    throw coded("allowlist refused network ids drifted", "ALLOWLIST");
  }
  const hosts = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link", "xahau.network"];
  if (!doc.refused_hosts || doc.refused_hosts.join(",") !== hosts.join(",")) {
    throw coded("allowlist refused hosts drifted", "ALLOWLIST");
  }
  const actions = doc.actions || {};
  if (Object.keys(actions).join("|") !== Object.keys(SPEC).join("|")) {
    throw coded("allowlist actions drifted", "ALLOWLIST");
  }
  for (const [name, spec] of Object.entries(SPEC)) {
    const row = actions[name];
    same(row.account, spec.account, `${name} account`);
    same(row.address == null ? null : row.address, spec.address, `${name} address`);
    same(row.key_env == null ? null : row.key_env, spec.key_env, `${name} key_env`);
    if (spec.address && row.address !== anchors.WALLETS[spec.account].address) {
      throw coded(`${name} address is not the public anchor`, "ALLOWLIST");
    }
    if (name === "walk_in_remint") same(row.max_offer_drops, spec.max_offer_drops, "remint offer");
    if (name === "grant_pay" || name === "x402_outbound" || name === "director_snapshot") {
      same(row.max_drops, spec.max_drops, `${name} max`);
    }
    if (name === "heartbeat") {
      same(row.default_drops, spec.default_drops, "heartbeat default");
      same(row.max_drops, spec.max_drops, "heartbeat max");
      if (!row.destination_addresses || row.destination_addresses.join(",") !== `${anchors.WALLETS.W3.address},${anchors.WALLETS.W6.address}`) {
        throw coded("heartbeat destinations drifted", "ALLOWLIST");
      }
    }
    if (name === "director_snapshot") {
      if (row.signs !== false) throw coded("director_snapshot must not sign", "SIGN");
      if (row.key_env !== null) throw coded("director_snapshot has no key", "SIGN");
    } else if (row.signs === true) {
      throw coded(`${name} must not set signs true in a way that bypasses the daemon`, "ALLOWLIST");
    }
  }
  return doc;
}

function loadAllowlist(file) {
  const target = file || ALLOWLIST_PATH;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw coded(`allowlist is not JSON: ${error.message}`, "ALLOWLIST");
  }
  return assertAllowlist(doc);
}

function assertHostAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coded("refusing unparseable url", "MAINNET");
  }
  if (anchors.isMainnetHost(url.hostname)) {
    throw coded(`refusing mainnet host ${url.hostname}`, "MAINNET");
  }
  return url;
}

function assertSigningRpc(raw) {
  assertHostAllowed(raw);
  if (/^wss?:/i.test(String(raw))) return grants.assertWsUrl(raw);
  return grants.assertTestnetUrl(raw);
}

function assertAltnet(opts) {
  const options = opts || {};
  if (options.url) {
    if (options.signing === false) assertHostAllowed(options.url);
    else assertSigningRpc(options.url);
  }
  if (options.networkId == null || options.networkId === "") return;
  const id = Number(options.networkId);
  if (id === 0 || id === anchors.XAHAU_MAINNET_ID) {
    throw coded(`refusing mainnet network id ${id}`, "MAINNET");
  }
  if (options.kind === "xahau") {
    if (id !== anchors.XAHAU_NETWORK_ID) throw coded(`refusing network id ${id}`, "MAINNET");
    return;
  }
  if (id !== anchors.XRPL_NETWORK_ID) throw coded(`refusing network id ${id}`, "MAINNET");
}

function stateAgeMs(state, now) {
  const stamp = Date.parse(state && state.updated_at);
  if (!state || Number.isNaN(stamp)) throw coded("director state missing or unreadable", "STALE");
  return now.getTime() - stamp;
}

function isStale(state, now, maxAgeMs) {
  const limit = maxAgeMs == null ? STALE_MS : maxAgeMs;
  return stateAgeMs(state, now) > limit;
}

function assertFreshForSign(state, now) {
  if (!state) throw coded("refusing to sign without director state", "STALE");
  if (isStale(state, now || new Date())) {
    throw coded("refusing to sign on stale director state", "STALE");
  }
}

function assertRemint(offer) {
  if (!offer || typeof offer !== "object") {
    throw coded("refusing remint without walk-in offer state", "OFFER_OPEN");
  }
  const count = Number(offer.offer_count);
  if (offer.status !== "sold_out" || !Number.isInteger(count) || count !== 0) {
    throw coded("refusing remint while a sell offer is open", "OFFER_OPEN");
  }
}

function labeledIndex(index) {
  return index || guard.foundryIndex();
}

function assertGrant(opts) {
  const options = opts || {};
  const destination = grants.assertClassic(options.destination, "grant destination");
  const index = labeledIndex(options.index);
  const label = index.get(destination);
  if (label) throw coded(`refusing labeled wallet ${label} (${destination})`, "LABELED");
  const amount = grants.dropsOf(options.drops == null ? SPEC.grant_pay.max_drops : options.drops);
  if (amount >= FIFTY_XRP_DROPS) throw coded("refusing grant at or above 50 XRP", "FIFTY_XRP");
  if (amount > GRANT_MAX_DROPS) throw coded("refusing grant above 1000000 drops", "CAP");
  if (amount <= 0n) throw coded("grant drops must be positive", "DROPS");
  grants.assertGrantDrops(amount.toString(), destination, options.motions || []);
  if (options.w6) {
    grants.assertFloat(
      options.w6.balance,
      options.w6.ownerCount || 0,
      options.w6.reserveBase,
      options.w6.reserveInc,
      amount.toString()
    );
  }
  return amount.toString();
}

function heartbeatDestinations() {
  return [anchors.WALLETS.W3.address, anchors.WALLETS.W6.address];
}

function assertHeartbeat(opts) {
  const options = opts || {};
  const now = options.now || new Date();
  const amount = grants.dropsOf(options.drops == null ? HEARTBEAT_DEFAULT_DROPS : options.drops);
  if (amount >= FIFTY_XRP_DROPS) throw coded("refusing heartbeat at or above 50 XRP", "FIFTY_XRP");
  if (amount > HEARTBEAT_MAX_DROPS) throw coded("refusing heartbeat above 1000 drops", "CAP");
  if (amount <= 0n) throw coded("heartbeat drops must be positive", "DROPS");
  const destination = options.destination || anchors.WALLETS.W3.address;
  if (!heartbeatDestinations().includes(destination)) {
    throw coded("heartbeat destination must be W3 or W6", "DEST");
  }
  const rows = (options.history || []).filter((row) => {
    if (!row) return false;
    if (row.action !== "heartbeat" && row.event !== "heartbeat") return false;
    const stamp = Date.parse(row.ts);
    return !Number.isNaN(stamp) && stamp <= now.getTime();
  });
  const utcDay = now.toISOString().slice(0, 10);
  const sameUtcDay = rows.filter((row) => new Date(Date.parse(row.ts)).toISOString().slice(0, 10) === utcDay);
  const recent = rows.filter((row) => now.getTime() - Date.parse(row.ts) < DAY_MS);
  if (sameUtcDay.length >= HEARTBEAT_MAX_PER_DAY) {
    throw coded("refusing more than 4 heartbeats on this UTC day", "RATE");
  }
  if (recent.length >= HEARTBEAT_MAX_PER_DAY) {
    throw coded("refusing more than 4 heartbeats in 24h", "RATE");
  }
  const last = recent.reduce((max, row) => Math.max(max, Date.parse(row.ts)), 0);
  if (last && now.getTime() - last < HEARTBEAT_MIN_INTERVAL_MS) {
    throw coded("refusing heartbeat inside 6h", "RATE");
  }
  return { drops: amount.toString(), destination };
}

function assertOutbound(opts) {
  const options = opts || {};
  if (options.has402 === false || options.missing402 === true) {
    throw coded("refusing outbound without a 402 invoice", "MISSING_402");
  }
  if (options.network != null && options.network !== "") {
    const label = options.network;
    const id = label === "xrpl:0" || label === "xrpl-mainnet" ? 0 : label === "xrpl:1" ? 1 : label;
    assertAltnet({ networkId: id, url: options.rpc, signing: options.rpc ? true : undefined });
  }
  if (options.url) assertAltnet({ url: options.url, signing: false });
  const payTo = options.payTo;
  if (payTo === anchors.WALLETS.W3.address) {
    throw coded("refusing circular outbound W3 to W3", "CIRCULAR");
  }
  const index = labeledIndex(options.index);
  const label = payTo ? index.get(payTo) : "";
  if (label) throw coded(`refusing labeled payTo ${label}`, "LABELED");
  try {
    guard.assertForeignPayTo(payTo, index);
  } catch (error) {
    if (payTo === anchors.WALLETS.W3.address) {
      throw coded("refusing circular outbound W3 to W3", "CIRCULAR");
    }
    throw coded(error.message, error.code || "LABELED");
  }
  const amount = grants.dropsOf(options.drops);
  if (amount >= FIFTY_XRP_DROPS) throw coded("refusing outbound at or above 50 XRP", "FIFTY_XRP");
  if (amount > OUTBOUND_MAX_DROPS) throw coded("refusing outbound above 500000 drops", "CAP");
  if (amount <= 0n) throw coded("outbound drops must be positive", "DROPS");
  return amount.toString();
}

function assertSnapshotUnsigned(tx) {
  if (tx) throw coded("director_snapshot must not sign", "SIGN");
}

function assertSigningTx(tx, state) {
  if (!tx || typeof tx !== "object") throw coded("refusing empty tx", "TX");
  assertNoSeedFields(tx);
  if (BANNED_TYPES.has(tx.TransactionType)) {
    const code = tx.TransactionType === "Batch" ? "BATCH" : "BANNED";
    const why = tx.TransactionType === "Batch"
      ? "refusing Batch while atomic_enabled is false"
      : `refusing ${tx.TransactionType}`;
    if (state && state.watched && state.watched.batch && state.watched.batch.atomic_enabled === true && tx.TransactionType === "Batch") {
      throw coded("refusing Batch from the Foundry daemon", "BATCH");
    }
    throw coded(why, code);
  }
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  if (tx.TransactionType === "Payment" && typeof tx.Amount === "string") {
    if (grants.dropsOf(tx.Amount) >= FIFTY_XRP_DROPS) {
      throw coded("refusing payment at or above 50 XRP", "FIFTY_XRP");
    }
  }
  if (tx.TransactionType === "NFTokenCreateOffer") {
    if (tx.Destination) throw coded("refusing a Destination on the Walk-In sell offer", "DEST");
    if (tx.Amount !== walkIn.AMOUNT_DROPS) throw coded("Walk-In sell offer must be 10 XRP", "CAP");
    if (Object.prototype.hasOwnProperty.call(tx, "Destination")) {
      throw coded("refusing a Destination on the Walk-In sell offer", "DEST");
    }
  }
  if (state && state.watched && state.watched.batch && state.watched.batch.atomic_enabled !== true) {
    if (tx.TransactionType === "Batch") throw coded("refusing Batch while atomic_enabled is false", "BATCH");
  }
  return tx;
}

function decision(action, fields) {
  const spec = SPEC[action];
  return Object.assign(
    {
      action,
      allow: false,
      code: "REFUSED",
      message: "",
      signed: false,
      submitted: false,
      tx: null,
      key_env: spec ? spec.key_env : null,
    },
    fields || {}
  );
}

function fromError(action, error) {
  return decision(action, {
    allow: false,
    code: (error && error.code) || "REFUSED",
    message: error && error.message ? error.message : String(error),
    tx: null,
  });
}

function w6FromState(state) {
  if (!state || !state.wallets || !state.wallets.W6 || !state.networks) return null;
  const w6 = state.wallets.W6;
  const net = state.networks.xrpl_testnet;
  return {
    balance: w6.balance_drops,
    ownerCount: w6.owner_count,
    reserveBase: net.reserve_base_drops,
    reserveInc: net.reserve_inc_drops,
  };
}

function regularKey(state, id) {
  const row = state && state.wallets && state.wallets[id];
  if (!row || !anchors.ADDRESS_RE.test(row.regular_key || "")) {
    throw coded(`${id} regular key is missing from director state`, "SIGNER");
  }
  return row.regular_key;
}

function readJsonl(file, io) {
  const exists = (io && io.existsSync) || fs.existsSync;
  const read = (io && io.readFileSync) || fs.readFileSync;
  if (!exists(file)) return [];
  const rows = [];
  for (const line of String(read(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip malformed history */
    }
  }
  return rows;
}

function paidOnUtcDay(rows, action, now) {
  const day = now.toISOString().slice(0, 10);
  return rows.some((row) => row && row.action === action && String(row.ts || "").startsWith(day));
}

function namesOutbound(nextActions) {
  return (nextActions || []).some((line) => /\b(x402_outbound|x402:outbound|outbound x402)\b/i.test(String(line)));
}

function redact(message, secrets) {
  let text = message == null ? "" : String(message);
  for (const secret of secrets || []) {
    if (secret && text.includes(secret)) text = text.split(secret).join("[redacted]");
  }
  if (anchors.EMBEDDED_SEED_RE.test(text) || /sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text)) {
    return "runtime failed (details omitted because they mentioned a seed)";
  }
  return text;
}

function assertPrintSafe(text) {
  if (anchors.EMBEDDED_SEED_RE.test(text) || /sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text)) {
    throw coded("refusing to print seed-shaped output", "SEED");
  }
}

module.exports = {
  ALLOWLIST_PATH,
  SPEC,
  STALE_MS,
  FIFTY_XRP_DROPS,
  GRANT_MAX_DROPS,
  OUTBOUND_MAX_DROPS,
  HEARTBEAT_MAX_DROPS,
  HEARTBEAT_DEFAULT_DROPS,
  HEARTBEAT_MAX_PER_DAY,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_SOURCE_TAG,
  KEY_ENVS,
  BANNED_TYPES,
  coded,
  envIsCi,
  assertNotCi,
  assertLiveGate,
  assertNoSeedFields,
  assertAllowlist,
  loadAllowlist,
  assertHostAllowed,
  assertSigningRpc,
  assertAltnet,
  stateAgeMs,
  isStale,
  assertFreshForSign,
  assertRemint,
  assertGrant,
  assertHeartbeat,
  heartbeatDestinations,
  assertOutbound,
  assertSnapshotUnsigned,
  assertSigningTx,
  decision,
  fromError,
  w6FromState,
  regularKey,
  readJsonl,
  paidOnUtcDay,
  namesOutbound,
  redact,
  assertPrintSafe,
};
