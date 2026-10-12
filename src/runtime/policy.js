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
const license = require("../license/catalog");

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
const ASF_DISABLE_MASTER = 4;
const HOUR_MS = 60 * 60 * 1000;
const EPOCH_SCAR = {
  owner: "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth",
  offerSequence: 21094052,
  hash: "6B9528CCE3F90E39A6D6E1A8A1F1E637E1A38B575F0DDB105785D3A66A319462",
};
const AGENT_TX_TYPES = [
  "Payment",
  "TrustSet",
  "OfferCreate",
  "OfferCancel",
  "NFTokenMint",
  "NFTokenCreateOffer",
  "NFTokenAcceptOffer",
  "NFTokenCancelOffer",
  "NFTokenBurn",
  "EscrowCreate",
  "EscrowFinish",
  "EscrowCancel",
  "PaymentChannelCreate",
  "PaymentChannelFund",
  "PaymentChannelClaim",
  "CheckCreate",
  "CheckCash",
  "CheckCancel",
  "AMMDeposit",
  "AMMWithdraw",
  "DIDSet",
  "CredentialCreate",
  "CredentialAccept",
  "CredentialDelete",
  "AccountSet",
];
const AGENT_TX_REFUSED = [
  "AccountDelete",
  "SetRegularKey",
  "SignerListSet",
  "Batch",
  "EnableAmendment",
  "UNLModify",
];
const AGENT_CAPS = {
  per_tx_drops: "10000000",
  motion_drops: "50000000",
  keep_spendable_drops: "10000000",
  max_tx_per_hour: 30,
  max_tx_per_utc_day: 200,
};
const AGENT_SPECIAL = {
  epoch_scar: "do not EscrowFinish or EscrowCancel the Unix-epoch BUYER escrow",
  walk_in_price_drops: "10000000",
  batch: "Batch only as batch_heartbeat on network id 1 when BatchV1_1 and fixBatchV1_2 are enabled; amount caps apply; otherwise refuse",
  license_price_drops: license.PRICE_DROPS,
  license_transfer_fee: license.TRANSFER_FEE,
  license_taxon: license.TAXON,
  license_mint_flags: license.MINT_FLAGS,
  license_mint_wallet: "W2",
  license_list_wallet: "W2",
  license_buy_wallet: "W4",
  license_burn_wallet: "W4",
  license_challenge_wallet: "W4",
};
const AGENT_ACCOUNTS = {
  W0: { sign: false, reason: "treasury master / signer list only" },
  W1: { sign: true, key_env: "W1_REGULAR_SEED", daily_max_drops: "20000000" },
  W2: { sign: true, key_env: "W2_REGULAR_SEED", daily_max_drops: "50000000" },
  W3: { sign: true, key_env: "W3_REGULAR_SEED", daily_max_drops: "20000000" },
  W4: { sign: true, key_env: "W4_REGULAR_SEED", daily_max_drops: "30000000" },
  W5: { sign: true, key_env: "W5_REGULAR_SEED", daily_max_drops: "5000000" },
  W6: { sign: true, key_env: "W6_REGULAR_SEED", daily_max_drops: "20000000" },
  W7: { sign: true, network: "xahau_testnet", key_env: "W7_SEED", daily_max_drops: "20000000" },
};
const AGENT_KEY_ENVS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7"].map((id) => AGENT_ACCOUNTS[id].key_env);
const OWNER_OBJECT_TYPES = new Set([
  "EscrowCreate",
  "OfferCreate",
  "NFTokenCreateOffer",
  "PaymentChannelCreate",
  "CheckCreate",
  "TrustSet",
  "NFTokenMint",
  "AMMDeposit",
  "DIDSet",
  "CredentialCreate",
]);

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
  batch_heartbeat_prepare: {
    account: "W2",
    address: anchors.WALLETS.W2.address,
    key_env: "W2_REGULAR_SEED",
    max_offer_drops: "100000",
    signs: true,
  },
  batch_heartbeat: {
    account: "W1",
    address: anchors.WALLETS.W1.address,
    key_env: "W1_REGULAR_SEED",
    max_deposit_drops: "2000000",
    max_fee_drops: "100000",
    signs: true,
  },
};

const BATCH_HEARTBEAT = {
  purpose: "aether-batch-heartbeat",
  experiment: "batch-heartbeat",
  offer_drops: "10000",
  max_offer_drops: "100000",
  deposit_drops: "1000000",
  max_deposit_drops: "2000000",
  max_fee_drops: "100000",
  taxon: 20261012,
  network_id: 1,
  tf_all_or_nothing: 65536,
  tf_inner: 1073741824,
  tf_single_asset: 524288,
  tf_sell: 1,
  mint_flags: 9,
  charter: "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/corp/charter.md",
  pack_uri: "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/batch-heartbeat/README.md",
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
    if (name === "batch_heartbeat_prepare") {
      same(row.max_offer_drops, spec.max_offer_drops, "batch prepare offer");
    }
    if (name === "batch_heartbeat") {
      same(row.max_deposit_drops, spec.max_deposit_drops, "batch deposit");
      same(row.max_fee_drops, spec.max_fee_drops, "batch fee");
    }
  }
  assertAgentAllowlist(doc);
  return doc;
}

function assertAgentAllowlist(doc) {
  if (doc.mode !== "agent-sign") throw coded("allowlist mode drifted", "ALLOWLIST");
  const ids = Object.keys(AGENT_ACCOUNTS);
  if (!doc.accounts || Object.keys(doc.accounts).join("|") !== ids.join("|")) {
    throw coded("allowlist accounts drifted", "ALLOWLIST");
  }
  for (const id of ids) {
    const row = doc.accounts[id];
    const spec = AGENT_ACCOUNTS[id];
    if (row.sign !== spec.sign) throw coded(`${id} sign bit drifted`, "ALLOWLIST");
    if (id === "W0") {
      if (row.key_env) throw coded("W0 must not name a signing key", "W0");
      same(row.reason, spec.reason, "W0 reason");
      continue;
    }
    same(row.key_env, spec.key_env, `${id} key_env`);
    same(row.daily_max_drops, spec.daily_max_drops, `${id} daily max`);
    if (row.key_env === "W0_SEED") throw coded("allowlist named W0_SEED", "W0");
    if (id === "W7") same(row.network, "xahau_testnet", "W7 network");
    else if (row.network) throw coded(`${id} network drifted`, "ALLOWLIST");
  }
  if (!Array.isArray(doc.tx_types) || doc.tx_types.join("|") !== AGENT_TX_TYPES.join("|")) {
    throw coded("allowlist tx_types drifted", "ALLOWLIST");
  }
  if (!Array.isArray(doc.tx_types_refused) || doc.tx_types_refused.join("|") !== AGENT_TX_REFUSED.join("|")) {
    throw coded("allowlist tx_types_refused drifted", "ALLOWLIST");
  }
  if (!doc.caps) throw coded("allowlist caps missing", "ALLOWLIST");
  same(doc.caps.per_tx_drops, AGENT_CAPS.per_tx_drops, "per_tx_drops");
  same(doc.caps.motion_drops, AGENT_CAPS.motion_drops, "motion_drops");
  same(doc.caps.keep_spendable_drops, AGENT_CAPS.keep_spendable_drops, "keep_spendable_drops");
  if (doc.caps.max_tx_per_hour !== AGENT_CAPS.max_tx_per_hour) throw coded("max_tx_per_hour drifted", "ALLOWLIST");
  if (doc.caps.max_tx_per_utc_day !== AGENT_CAPS.max_tx_per_utc_day) throw coded("max_tx_per_utc_day drifted", "ALLOWLIST");
  if (!doc.special) throw coded("allowlist special missing", "ALLOWLIST");
  same(doc.special.epoch_scar, AGENT_SPECIAL.epoch_scar, "epoch_scar");
  same(doc.special.walk_in_price_drops, AGENT_SPECIAL.walk_in_price_drops, "walk_in_price");
  same(doc.special.batch, AGENT_SPECIAL.batch, "batch gate");
  same(doc.special.license_price_drops, AGENT_SPECIAL.license_price_drops, "license price");
  same(doc.special.license_transfer_fee, AGENT_SPECIAL.license_transfer_fee, "license fee");
  same(doc.special.license_taxon, AGENT_SPECIAL.license_taxon, "license taxon");
  same(doc.special.license_mint_flags, AGENT_SPECIAL.license_mint_flags, "license flags");
  same(doc.special.license_mint_wallet, AGENT_SPECIAL.license_mint_wallet, "license mint wallet");
  same(doc.special.license_list_wallet, AGENT_SPECIAL.license_list_wallet, "license list wallet");
  same(doc.special.license_buy_wallet, AGENT_SPECIAL.license_buy_wallet, "license buy wallet");
  same(doc.special.license_burn_wallet, AGENT_SPECIAL.license_burn_wallet, "license burn wallet");
  same(doc.special.license_challenge_wallet, AGENT_SPECIAL.license_challenge_wallet, "license challenge wallet");
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

function assertXahauAltnetUrl(raw) {
  try {
    anchors.assertXahauTestnetUrl(raw);
  } catch (error) {
    throw coded(
      error && error.message ? error.message : "refusing non-Xahau-Testnet host",
      (error && error.code) || "MAINNET"
    );
  }
}

function assertAltnet(opts) {
  const options = opts || {};
  const xahau = options.kind === "xahau";
  if (options.url) {
    if (xahau) assertXahauAltnetUrl(options.url);
    else if (options.signing === false) assertHostAllowed(options.url);
    else assertSigningRpc(options.url);
  }
  if (options.networkId == null || options.networkId === "") return;
  const id = Number(options.networkId);
  if (id === 0 || id === anchors.XAHAU_MAINNET_ID) {
    throw coded(`refusing mainnet network id ${id}`, "MAINNET");
  }
  if (xahau) {
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

function assertAgentGate(env) {
  assertNotCi(env);
  if (!env || env.FOUNDRY_AGENT_SIGN !== "yes") {
    throw coded("refusing to sign without FOUNDRY_AGENT_SIGN=yes", "AGENT_SIGN");
  }
}

function agentWallet(id) {
  const spec = AGENT_ACCOUNTS[id];
  if (!spec) throw coded(`unknown wallet ${id}`, "WALLET");
  if (id === "W0" || spec.sign !== true) throw coded("refusing to sign as W0", "W0");
  const anchor = anchors.WALLETS[id];
  if (!anchor || !anchor.address) throw coded(`${id} has no public address`, "WALLET");
  return {
    id,
    sign: true,
    address: anchor.address,
    key_env: spec.key_env,
    network: spec.network || "xrpl_testnet",
    daily_max_drops: spec.daily_max_drops,
  };
}

function assertAgentRpc(raw, wallet) {
  if (wallet && wallet.network === "xahau_testnet") return anchors.assertXahauTestnetUrl(raw);
  return assertSigningRpc(raw);
}

function dropsField(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  return grants.dropsOf(value);
}

function xrpFields(tx) {
  const fields = [];
  const push = (name, value, destination) => {
    const drops = dropsField(value);
    if (drops == null) return;
    fields.push({
      name,
      drops,
      destination: destination || tx.Destination || tx.Account || "",
    });
  };
  const type = tx.TransactionType;
  if (type === "Payment") {
    push("Amount", tx.Amount, tx.Destination);
    push("SendMax", tx.SendMax, tx.Destination);
  } else if (type === "EscrowCreate") {
    push("Amount", tx.Amount, tx.Destination);
  } else if (type === "OfferCreate") {
    push("TakerPays", tx.TakerPays, tx.Account);
    push("TakerGets", tx.TakerGets, tx.Account);
  } else if (type === "NFTokenCreateOffer") {
    push("Amount", tx.Amount, tx.Destination || tx.Account);
  } else if (type === "PaymentChannelCreate" || type === "PaymentChannelFund") {
    push("Amount", tx.Amount, tx.Destination);
  } else if (type === "CheckCreate") {
    push("SendMax", tx.SendMax, tx.Destination);
  } else if (type === "CheckCash") {
    push("Amount", tx.Amount, tx.Account);
  }
  return fields;
}

function xrpOut(tx) {
  let total = 0n;
  const add = (value) => {
    const drops = dropsField(value);
    if (drops != null) total += drops;
  };
  const type = tx.TransactionType;
  if (type === "Payment") add(tx.Amount);
  else if (type === "EscrowCreate") add(tx.Amount);
  else if (type === "OfferCreate") add(tx.TakerGets);
  else if (type === "PaymentChannelCreate" || type === "PaymentChannelFund") add(tx.Amount);
  else if (type === "CheckCreate") add(tx.SendMax);
  else if (type === "CheckCash") add(tx.Amount);
  else if (type === "Batch") {
    for (const raw of tx.RawTransactions || []) {
      const inner = raw && raw.RawTransaction;
      if (inner && inner.TransactionType === "AMMDeposit") add(inner.Amount);
    }
  }
  return total;
}

function loadMotions(root, io) {
  const exists = (io && io.existsSync) || fs.existsSync;
  const readDir = (io && io.readdirSync) || fs.readdirSync;
  const read = (io && io.readFileSync) || fs.readFileSync;
  const dir = path.join(root || anchors.repoRoot(), "lab", "motions");
  if (!exists(dir)) return [];
  const files = [];
  for (const name of readDir(dir)) {
    if (!String(name).endsWith(".md") || String(name).toLowerCase() === "readme.md") continue;
    files.push({ name, text: read(path.join(dir, name), "utf8") });
  }
  return files;
}

function assertAgentAmounts(tx, motions, intent) {
  const perTx = grants.dropsOf(AGENT_CAPS.per_tx_drops);
  const motionLine = grants.dropsOf(AGENT_CAPS.motion_drops);
  const files = Array.isArray(motions) ? motions : [];
  for (const field of xrpFields(tx)) {
    if (field.drops > perTx && field.drops < motionLine) {
      throw coded(
        `refusing ${field.drops.toString()} drops above per_tx_drops without raising the allowlist`,
        "CAP"
      );
    }
    if (field.drops >= motionLine) {
      const hit = files.some((file) => grants.motionCovers(file.text, field.destination, field.drops.toString()));
      if (!hit) {
        throw coded(
          `${tx.TransactionType} of ${field.drops.toString()} drops needs a motion in lab/motions/`,
          "MOTION"
        );
      }
    }
  }
  if (tx.TransactionType === "NFTokenCreateOffer" && tx.Account === anchors.WALLETS.W2.address) {
    const sell = (Number(tx.Flags) & 1) === 1;
    const prepare = intent === "batch_heartbeat_prepare" && sell;
    if (sell && !prepare) {
      if (tx.Destination) throw coded("refusing a Destination on the Walk-In sell offer", "DEST");
      if (Object.prototype.hasOwnProperty.call(tx, "Destination")) {
        throw coded("refusing a Destination on the Walk-In sell offer", "DEST");
      }
      if (intent === "license_list" || tx.Amount === AGENT_SPECIAL.license_price_drops) {
        if (tx.Amount !== AGENT_SPECIAL.license_price_drops) {
          throw coded("license sell offer must be 2 XRP", "CAP");
        }
      } else if (tx.Amount !== AGENT_SPECIAL.walk_in_price_drops) {
        throw coded("Walk-In sell offer must be 10 XRP", "CAP");
      }
    }
  }
}

function assertAgentFloat(tx, account, feeDrops, extraDrops) {
  if (!account) throw coded("refusing without an account balance", "FLOAT");
  const fee = grants.dropsOf(feeDrops || tx.Fee || "12");
  const extra = extraDrops ? grants.dropsOf(extraDrops) : 0n;
  const pay = xrpOut(tx) + fee + extra;
  const owners = Number(account.ownerCount || 0) + (OWNER_OBJECT_TYPES.has(tx.TransactionType) ? 1 : 0);
  grants.assertFloat(
    account.balance,
    owners,
    account.reserveBase,
    account.reserveInc,
    pay.toString()
  );
}

function agentRows(history, now) {
  return (history || []).filter((row) => {
    if (!row || row.source !== "agent-signer") return false;
    const stamp = Date.parse(row.ts);
    return !Number.isNaN(stamp) && stamp <= now.getTime();
  });
}

function assertAgentRate(history, now, wallet, tx, extraDrops) {
  const when = now || new Date();
  const rows = agentRows(history, when);
  const hour = rows.filter((row) => when.getTime() - Date.parse(row.ts) < HOUR_MS);
  if (hour.length >= AGENT_CAPS.max_tx_per_hour) {
    throw coded("refusing more than 30 agent txs in an hour", "RATE");
  }
  const day = when.toISOString().slice(0, 10);
  const today = rows.filter((row) => new Date(Date.parse(row.ts)).toISOString().slice(0, 10) === day);
  if (today.length >= AGENT_CAPS.max_tx_per_utc_day) {
    throw coded("refusing more than 200 agent txs on this UTC day", "RATE");
  }
  const spent = today
    .filter((row) => row.wallet === wallet.id)
    .reduce((sum, row) => sum + grants.dropsOf(row.amount_drops || "0"), 0n);
  const extra = extraDrops ? grants.dropsOf(extraDrops) : 0n;
  const next = spent + xrpOut(tx) + extra;
  if (next > grants.dropsOf(wallet.daily_max_drops)) {
    throw coded(`refusing ${wallet.id} spend above daily_max_drops`, "CAP");
  }
}

function scarTargeted(tx) {
  const owner = tx.Owner || tx.Account;
  const sequence = tx.OfferSequence == null ? null : Number(tx.OfferSequence);
  if (owner === EPOCH_SCAR.owner && sequence === EPOCH_SCAR.offerSequence) return true;
  const hash = EPOCH_SCAR.hash.toLowerCase();
  for (const value of Object.values(tx)) {
    if (typeof value === "string" && value.toLowerCase() === hash) return true;
  }
  return false;
}

function assertEpochScar(tx) {
  if (tx.TransactionType !== "EscrowFinish" && tx.TransactionType !== "EscrowCancel") return;
  if (scarTargeted(tx)) {
    throw coded("refusing to finish or cancel the Unix-epoch BUYER escrow", "EPOCH_SCAR");
  }
  if ((tx.Owner || "") === EPOCH_SCAR.owner && tx.OfferSequence == null) {
    throw coded("refusing an escrow finish without the scar sequence", "EPOCH_SCAR");
  }
}

function batchEnabled(state) {
  return Boolean(state && state.watched && state.watched.batch && state.watched.batch.atomic_enabled === true);
}

function isBatchIntent(intent) {
  return intent === "batch_heartbeat" || intent === "batch_heartbeat_prepare";
}

function batchGateOpen(state) {
  const batch = state && state.watched && state.watched.batch;
  if (!batch || batch.atomic_enabled !== true) return false;
  if (Array.isArray(batch.amendments) && batch.amendments.length > 0) {
    const enabled = new Map(batch.amendments.map((row) => [row.name, row.enabled === true]));
    if (enabled.get("BatchV1_1") !== true || enabled.get("fixBatchV1_2") !== true) return false;
  }
  return true;
}

function hexUtf8(hex) {
  const text = String(hex || "");
  if (!/^[0-9A-Fa-f]+$/.test(text) || text.length % 2 !== 0) return null;
  return Buffer.from(text, "hex").toString("utf8");
}

function parsedNft(id) {
  const text = String(id || "").toUpperCase();
  if (!anchors.HASH_RE.test(text)) throw coded("batch heartbeat NFTokenID drifted", "TX");
  try {
    return require("xrpl").parseNFTokenID(text);
  } catch {
    throw coded("batch heartbeat NFTokenID drifted", "TX");
  }
}

function innerTransactions(tx) {
  if (!tx || !Array.isArray(tx.RawTransactions)) return null;
  const inners = [];
  for (const row of tx.RawTransactions) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const keys = Object.keys(row);
    if (keys.length !== 1 || keys[0] !== "RawTransaction" || !row.RawTransaction) return null;
    inners.push(row.RawTransaction);
  }
  return inners;
}

function assertNoW0Signer(tx) {
  if (!tx || typeof tx !== "object") return;
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  const inners = innerTransactions(tx) || [];
  for (const inner of inners) {
    if (inner.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  }
  if (tx.BatchSigners) throw coded("batch heartbeat is a single-account Batch", "BATCH");
}

function assertHeartbeatMemos(tx) {
  const memos = grants.decodeMemos(tx);
  if (memos.purpose !== BATCH_HEARTBEAT.purpose || memos.experiment !== BATCH_HEARTBEAT.experiment) {
    throw coded("batch heartbeat memo drifted", "TX");
  }
}

function assertBatchPrepare(tx) {
  if (!tx || typeof tx !== "object") throw coded("refusing empty tx", "TX");
  assertNoW0Signer(tx);
  if (tx.Account !== anchors.WALLETS.W2.address) throw coded("batch heartbeat prepare is only W2", "ACCOUNT");
  assertHeartbeatMemos(tx);
  if (tx.TransactionType === "NFTokenMint") {
    if (tx.NFTokenTaxon !== BATCH_HEARTBEAT.taxon) throw coded("batch heartbeat taxon drifted", "TX");
    if (tx.Flags !== BATCH_HEARTBEAT.mint_flags) throw coded("batch heartbeat mint flags drifted", "TX");
    if (tx.Issuer || tx.Destination || tx.Amount) throw coded("batch heartbeat mint must not set Issuer, Destination, or Amount", "TX");
    if (tx.TransferFee != null && Number(tx.TransferFee) !== 0) throw coded("batch heartbeat mint fee drifted", "TX");
    if (hexUtf8(tx.URI) !== BATCH_HEARTBEAT.pack_uri) throw coded("batch heartbeat mint URI drifted", "TX");
    return;
  }
  if (tx.TransactionType === "NFTokenCreateOffer") {
    if (tx.Flags !== BATCH_HEARTBEAT.tf_sell) throw coded("batch heartbeat prepare must be a sell offer", "TX");
    if (tx.Destination !== anchors.WALLETS.W1.address) throw coded("batch heartbeat offer destination must be W1", "DEST");
    if (tx.Owner || tx.Expiration) throw coded("batch heartbeat offer must not set Owner or Expiration", "TX");
    const drops = grants.dropsOf(tx.Amount);
    const cap = grants.dropsOf(BATCH_HEARTBEAT.max_offer_drops);
    if (drops <= 0n || drops > cap) throw coded("batch heartbeat offer is above the cap", "CAP");
    const parsed = parsedNft(tx.NFTokenID);
    if (Number(parsed.Taxon) !== BATCH_HEARTBEAT.taxon) throw coded("batch heartbeat NFT taxon drifted", "TX");
    if (parsed.Issuer !== anchors.WALLETS.W2.address) throw coded("batch heartbeat NFT issuer must be W2", "ACCOUNT");
    return;
  }
  throw coded("batch heartbeat prepare is mint or sell offer", "TX");
}

function assertHeartbeatOffer(offer, accept) {
  if (!offer || offer.LedgerEntryType !== "NFTokenOffer") {
    throw coded("batch heartbeat requires the sell offer", "OFFER");
  }
  if ((Number(offer.Flags) & BATCH_HEARTBEAT.tf_sell) !== BATCH_HEARTBEAT.tf_sell) {
    throw coded("batch heartbeat offer is not a sell offer", "OFFER");
  }
  if (offer.Owner !== anchors.WALLETS.W2.address) throw coded("batch heartbeat offer owner must be W2", "ACCOUNT");
  if (offer.Destination !== anchors.WALLETS.W1.address) throw coded("batch heartbeat offer destination must be W1", "DEST");
  let drops;
  try {
    drops = grants.dropsOf(offer.Amount);
  } catch {
    throw coded("batch heartbeat offer amount must be drops", "CAP");
  }
  if (drops <= 0n || drops > grants.dropsOf(BATCH_HEARTBEAT.max_offer_drops)) {
    throw coded("batch heartbeat offer is above the cap", "CAP");
  }
  const parsed = parsedNft(offer.NFTokenID);
  if (Number(parsed.Taxon) !== BATCH_HEARTBEAT.taxon) throw coded("batch heartbeat NFT taxon drifted", "TX");
  if (parsed.Issuer !== anchors.WALLETS.W2.address) throw coded("batch heartbeat NFT issuer must be W2", "ACCOUNT");
  if (offer.index && String(offer.index).toUpperCase() !== String(accept.NFTokenSellOffer || "").toUpperCase()) {
    throw coded("batch heartbeat offer index drifted", "OFFER");
  }
  return drops.toString();
}

function assertInnerCommon(inner, label) {
  if (!inner || inner.Account !== anchors.WALLETS.W1.address) {
    throw coded(`batch heartbeat ${label} account must be W1`, "ACCOUNT");
  }
  if (inner.TxnSignature != null || inner.Signers != null) {
    throw coded(`batch heartbeat ${label} must be unsigned`, "TX");
  }
  if (inner.TicketSequence != null) throw coded(`batch heartbeat ${label} must not use a ticket`, "TX");
  if (inner.Fee != null && inner.Fee !== "0") throw coded(`batch heartbeat ${label} fee must be 0`, "TX");
  if (inner.SigningPubKey != null && inner.SigningPubKey !== "") {
    throw coded(`batch heartbeat ${label} signing key must be empty`, "TX");
  }
  if (inner.Sequence != null && (!Number.isInteger(inner.Sequence) || inner.Sequence <= 0)) {
    throw coded(`batch heartbeat ${label} sequence drifted`, "TX");
  }
  if (inner.NetworkID != null && Number(inner.NetworkID) !== anchors.XRPL_NETWORK_ID) {
    throw coded(`refusing network id ${inner.NetworkID}`, "MAINNET");
  }
  if (inner.LastLedgerSequence != null) throw coded(`batch heartbeat ${label} must not set LastLedgerSequence`, "TX");
}

function assertBatchHeartbeat(tx, opts) {
  const options = opts || {};
  if (!tx || tx.TransactionType !== "Batch") throw coded("batch_heartbeat requires Batch", "TX");
  if (!batchGateOpen(options.state)) {
    throw coded("refusing Batch while atomic_enabled is false", "BATCH");
  }
  if (options.networkId != null && options.networkId !== "" && Number(options.networkId) !== anchors.XRPL_NETWORK_ID) {
    throw coded(`refusing network id ${options.networkId}`, "MAINNET");
  }
  assertNoW0Signer(tx);
  if (tx.Account !== anchors.WALLETS.W1.address) throw coded("batch heartbeat fee payer is W1", "ACCOUNT");
  if (tx.Flags !== BATCH_HEARTBEAT.tf_all_or_nothing) throw coded("batch heartbeat requires tfAllOrNothing", "TX");
  if (tx.NetworkID != null && Number(tx.NetworkID) !== anchors.XRPL_NETWORK_ID) {
    throw coded(`refusing network id ${tx.NetworkID}`, "MAINNET");
  }
  if (tx.Fee != null) {
    const fee = grants.dropsOf(tx.Fee);
    if (fee <= 0n || fee > grants.dropsOf(BATCH_HEARTBEAT.max_fee_drops)) {
      throw coded("batch heartbeat fee is above the cap", "CAP");
    }
  }
  assertHeartbeatMemos(tx);
  const inners = innerTransactions(tx);
  if (!inners || inners.length !== 3) throw coded("batch heartbeat requires exactly 3 inners", "TX");
  const accept = inners[0];
  const deposit = inners[1];
  const did = inners[2];
  if (accept.TransactionType !== "NFTokenAcceptOffer") throw coded("batch heartbeat inner 1 is NFTokenAcceptOffer", "TX");
  if (deposit.TransactionType !== "AMMDeposit") throw coded("batch heartbeat inner 2 is AMMDeposit", "TX");
  if (did.TransactionType !== "DIDSet") throw coded("batch heartbeat inner 3 is DIDSet", "TX");
  assertInnerCommon(accept, "accept");
  assertInnerCommon(deposit, "deposit");
  assertInnerCommon(did, "did");
  if (accept.Flags !== BATCH_HEARTBEAT.tf_inner) throw coded("batch heartbeat accept flags drifted", "TX");
  if (!anchors.HASH_RE.test(String(accept.NFTokenSellOffer || "").toUpperCase())) {
    throw coded("batch heartbeat requires NFTokenSellOffer", "TX");
  }
  if (accept.NFTokenBuyOffer || accept.Amount) throw coded("batch heartbeat accept sets no amount", "TX");
  const depositFlags = BATCH_HEARTBEAT.tf_inner | BATCH_HEARTBEAT.tf_single_asset;
  if (deposit.Flags !== depositFlags) throw coded("batch heartbeat deposit must be single-asset XRP", "TX");
  if (!deposit.Asset || deposit.Asset.currency !== "XRP" || deposit.Asset.issuer) {
    throw coded("batch heartbeat deposit asset must be XRP", "TX");
  }
  const asset2 = deposit.Asset2;
  if (!asset2 || asset2.currency !== anchors.AETH_HEX || asset2.issuer !== anchors.WALLETS.W0.address) {
    throw coded("batch heartbeat deposit asset2 must be AETH issued by W0", "TX");
  }
  if (deposit.Amount2 || deposit.LPTokenOut || deposit.EPrice) {
    throw coded("batch heartbeat deposit is single-asset XRP", "TX");
  }
  const depositDrops = grants.dropsOf(deposit.Amount);
  if (depositDrops <= 0n || depositDrops > grants.dropsOf(BATCH_HEARTBEAT.max_deposit_drops)) {
    throw coded("batch heartbeat deposit is above the cap", "CAP");
  }
  if (did.Flags !== BATCH_HEARTBEAT.tf_inner) throw coded("batch heartbeat DID flags drifted", "TX");
  if (did.DIDDocument) throw coded("batch heartbeat DIDSet uses URI and Data", "TX");
  const uri = hexUtf8(did.URI);
  const prefix = `${BATCH_HEARTBEAT.charter}#heartbeat=`;
  if (!uri || !uri.startsWith(prefix)) throw coded("batch heartbeat DID URI drifted", "TX");
  const stamp = uri.slice(prefix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(stamp)) {
    throw coded("batch heartbeat DID timestamp drifted", "TX");
  }
  let data;
  try {
    data = JSON.parse(hexUtf8(did.Data) || "");
  } catch {
    throw coded("batch heartbeat DID data drifted", "TX");
  }
  if (!data || Object.keys(data).sort().join(",") !== "heartbeat,machine") {
    throw coded("batch heartbeat DID data drifted", "TX");
  }
  if (data.machine !== "batch-heartbeat" || data.heartbeat !== stamp) {
    throw coded("batch heartbeat DID data drifted", "TX");
  }
  if (tx.Sequence != null && inners.every((inner) => inner.Sequence != null)) {
    const outer = Number(tx.Sequence);
    if (!Number.isInteger(outer) || outer <= 0) throw coded("batch heartbeat sequence drifted", "TX");
    inners.forEach((inner, index) => {
      if (inner.Sequence !== outer + 1 + index) throw coded("batch heartbeat inner sequence drifted", "TX");
    });
  }
  const offerDrops = assertHeartbeatOffer(options.sellOffer, accept);
  if (paidOnUtcDay(options.history || [], "batch_heartbeat", options.now || new Date())) {
    throw coded("refusing a second batch heartbeat on this UTC day", "DAY");
  }
  return { depositDrops: depositDrops.toString(), offerDrops, stamp };
}

function assertAgentBatch(tx, options) {
  const opts = options || {};
  const state = opts.state;
  const isBatch = Boolean(tx && (tx.TransactionType === "Batch" || tx.RawTransactions));
  if (opts.intent === "batch_heartbeat") {
    return assertBatchHeartbeat(tx, opts);
  }
  if (!isBatch) return null;
  const why = batchGateOpen(state) || batchEnabled(state)
    ? "refusing Batch"
    : "refusing Batch while atomic_enabled is false";
  throw coded(why, "BATCH");
}

function assertDisableMaster(tx) {
  if (Number(tx.SetFlag) === ASF_DISABLE_MASTER) {
    throw coded("refusing asfDisableMaster", "MASTER");
  }
}

function assertAgentType(tx, intent) {
  const type = tx.TransactionType;
  if (!type || typeof type !== "string") throw coded("refusing missing TransactionType", "TX");
  if (type === "Batch") {
    if (intent === "batch_heartbeat") return;
    throw coded(
      "refusing Batch while atomic_enabled is false",
      "BATCH"
    );
  }
  if (AGENT_TX_REFUSED.includes(type) || !AGENT_TX_TYPES.includes(type)) {
    throw coded(`refusing ${type}`, "TX");
  }
}

function licenseUriOk(uri) {
  if (typeof uri !== "string" || !/^[A-F0-9]+$/.test(uri)) return false;
  const text = Buffer.from(uri, "hex").toString("utf8");
  return license.parseUri(text) != null;
}

function assertLicenseTx(tx, intent, opts) {
  const options = opts || {};
  const name = typeof intent === "string" ? intent : "";
  const named = name.startsWith("license_");
  const mintShaped = tx.TransactionType === "NFTokenMint" && Number(tx.NFTokenTaxon) === license.TAXON;
  const listShaped = tx.TransactionType === "NFTokenCreateOffer"
    && (Number(tx.Flags) & 1) === 1
    && tx.Amount === license.PRICE_DROPS;
  const burnShaped = tx.TransactionType === "NFTokenBurn";
  if (!named && !mintShaped && !listShaped && !burnShaped) return false;
  if (burnShaped || name === "license_burn") {
    if (name !== "license_burn") throw coded("refusing NFTokenBurn outside license_burn", "TX");
    if (options.wallet !== "W4") throw coded("license burn is only W4", "WALLET");
    if (tx.TransactionType !== "NFTokenBurn") throw coded("license_burn requires NFTokenBurn", "TX");
    if (!license.HEX64.test(String(tx.NFTokenID || "").toUpperCase())) {
      throw coded("license burn requires NFTokenID", "TX");
    }
    if (tx.Owner) throw coded("holder burn must not set Owner", "TX");
    if (tx.Amount != null) throw coded("NFTokenBurn has no amount", "TX");
    return true;
  }
  if (mintShaped || name === "license_mint") {
    if (name !== "license_mint") throw coded("license mint requires intent license_mint", "TX");
    if (options.wallet !== "W2") throw coded("license mint is only W2", "WALLET");
    if (tx.TransactionType !== "NFTokenMint") throw coded("license_mint requires NFTokenMint", "TX");
    if (Number(tx.NFTokenTaxon) !== license.TAXON) throw coded("license taxon drifted", "TX");
    if (Number(tx.Flags) !== license.MINT_FLAGS) throw coded("license mint flags must be burnable and transferable", "TX");
    if (Number(tx.TransferFee) !== license.TRANSFER_FEE) throw coded("license TransferFee must be 5000", "TX");
    if (!licenseUriOk(tx.URI)) throw coded("license URI must be aflic:1:<hash>", "TX");
    if (tx.Destination || tx.Amount || tx.Issuer) throw coded("license mint must not set Destination, Amount, or Issuer", "TX");
    return true;
  }
  if (listShaped || name === "license_list") {
    if (name !== "license_list") throw coded("license list requires intent license_list", "TX");
    if (options.wallet !== "W2") throw coded("license list is only W2", "WALLET");
    if (tx.TransactionType !== "NFTokenCreateOffer") throw coded("license_list requires NFTokenCreateOffer", "TX");
    if (Number(tx.Flags) !== license.TF_SELL_NFTOKEN) throw coded("license list must be a sell offer", "TX");
    if (tx.Amount !== license.PRICE_DROPS) throw coded("license sell offer must be 2 XRP", "CAP");
    if (tx.Destination || Object.prototype.hasOwnProperty.call(tx, "Destination")) {
      throw coded("refusing a Destination on the license sell offer", "DEST");
    }
    if (!license.HEX64.test(String(tx.NFTokenID || "").toUpperCase())) {
      throw coded("license list requires NFTokenID", "TX");
    }
    return true;
  }
  if (name === "license_buy") {
    if (options.wallet !== "W4") throw coded("license buy is only W4", "WALLET");
    if (tx.TransactionType !== "NFTokenAcceptOffer") throw coded("license_buy requires NFTokenAcceptOffer", "TX");
    if (!license.HEX64.test(String(tx.NFTokenSellOffer || "").toUpperCase())) {
      throw coded("license buy requires NFTokenSellOffer", "TX");
    }
    if (tx.NFTokenBuyOffer || tx.Amount) throw coded("license buy accepts a sell offer and sets no amount", "TX");
    const offer = options.sellOffer;
    const amount = options.offerAmount != null ? options.offerAmount : offer && offer.Amount;
    if (typeof amount !== "string" || amount !== license.PRICE_DROPS) {
      throw coded("license sell offer must be 2 XRP", "CAP");
    }
    if (offer) {
      if (offer.LedgerEntryType && offer.LedgerEntryType !== "NFTokenOffer") {
        throw coded("license buy offer is not an NFTokenOffer", "TX");
      }
      if ((Number(offer.Flags) & 1) !== 1) throw coded("license offer is not a sell offer", "TX");
      if (offer.Owner && offer.Owner !== anchors.WALLETS.W2.address) {
        throw coded("license sell offer owner must be W2", "ACCOUNT");
      }
      if (offer.Destination) throw coded("refusing a Destination on the license sell offer", "DEST");
    }
    return true;
  }
  throw coded(`refusing ${name || tx.TransactionType}`, "TX");
}

function assertKnownIntent(tx, intent, opts) {
  const options = opts || {};
  if (intent === "batch_heartbeat_prepare") {
    assertBatchPrepare(tx);
    return;
  }
  if (intent === "batch_heartbeat") return;
  if (assertLicenseTx(tx, intent, options)) return;
  const memos = grants.decodeMemos(tx);
  let name = intent;
  if (memos.purpose === "aether-heartbeat") name = "heartbeat";
  if (memos.purpose === "aether-grant") name = "grant_pay";
  if (name === "heartbeat" || name === "aether-heartbeat") {
    assertHeartbeat({
      drops: tx.Amount,
      destination: tx.Destination,
      history: options.history || [],
      now: options.now,
    });
  }
  if (name === "grant_pay" || name === "aether-grant") {
    assertGrant({
      destination: tx.Destination,
      drops: tx.Amount,
      index: options.index,
      motions: options.motions,
      w6: options.account
        ? {
            balance: options.account.balance,
            ownerCount: options.account.ownerCount,
            reserveBase: options.account.reserveBase,
            reserveInc: options.account.reserveInc,
          }
        : null,
    });
  }
  if (name === "x402_outbound" || name === "x402_buy") {
    assertOutbound({
      has402: options.has402 !== false,
      payTo: tx.Destination,
      drops: tx.Amount,
      network: "xrpl:1",
      index: options.index,
    });
    if (paidOnUtcDay(options.history || [], "x402_outbound", options.now || new Date())) {
      throw coded("refusing a second outbound on this UTC day", "DAY");
    }
  }
  if (name === "grant_pay" || name === "aether-grant") {
    if (paidOnUtcDay(options.history || [], "grant_paid", options.now || new Date())) {
      throw coded("refusing a second grant on this UTC day", "DAY");
    }
  }
  const walkInMint = tx.TransactionType === "NFTokenMint"
    && tx.Account === anchors.WALLETS.W2.address
    && Number(tx.NFTokenTaxon) === 20260927;
  const walkInSell = tx.TransactionType === "NFTokenCreateOffer"
    && tx.Account === anchors.WALLETS.W2.address
    && tx.Amount === AGENT_SPECIAL.walk_in_price_drops
    && (Number(tx.Flags) & 1) === 1;
  if (name === "walk_in_remint" || walkInMint || walkInSell) {
    const offer = options.offer || (options.state && options.state.watched && options.state.watched.walk_in_offer);
    assertRemint(offer);
  }
}

function assertAgentRequest(opts) {
  const options = opts || {};
  assertAgentGate(options.env);
  const wallet = agentWallet(options.wallet);
  const tx = options.tx;
  if (!tx || typeof tx !== "object" || Array.isArray(tx)) throw coded("refusing empty tx", "TX");
  assertNoSeedFields(tx);
  if (tx.Account === anchors.WALLETS.W0.address || options.wallet === "W0") {
    throw coded("refusing to sign as W0", "W0");
  }
  if (options.url) assertAgentRpc(options.url, wallet);
  if (options.networkId != null && options.networkId !== "") {
    assertAltnet({
      networkId: options.networkId,
      kind: wallet.network === "xahau_testnet" ? "xahau" : undefined,
    });
    const expect = wallet.network === "xahau_testnet" ? anchors.XAHAU_NETWORK_ID : anchors.XRPL_NETWORK_ID;
    if (Number(options.networkId) !== expect) {
      throw coded(`refusing network id ${options.networkId}`, "MAINNET");
    }
  }
  if (tx.Account !== wallet.address) throw coded("tx.Account does not match wallet", "ACCOUNT");
  if (isBatchIntent(options.intent) && Number(options.networkId) !== anchors.XRPL_NETWORK_ID) {
    throw coded("batch heartbeat is network id 1 only", "MAINNET");
  }
  assertAgentBatch(tx, options);
  assertAgentType(tx, options.intent);
  assertDisableMaster(tx);
  assertAgentAmounts(tx, options.motions || [], options.intent);
  assertKnownIntent(tx, options.intent, options);
  let spendExtra = options.intent === "license_buy" ? license.PRICE_DROPS : null;
  let account = options.account;
  if (options.intent === "batch_heartbeat") {
    spendExtra = options.offerAmount || (options.sellOffer && options.sellOffer.Amount) || "0";
    if (account) {
      account = Object.assign({}, account, {
        ownerCount: Number(account.ownerCount || 0) + 3,
      });
    }
  }
  if (account) assertAgentFloat(tx, account, options.feeDrops, spendExtra);
  else if (options.requireAccount) throw coded("refusing without an account balance", "FLOAT");
  assertAgentRate(options.history || [], options.now || new Date(), wallet, tx, spendExtra);
  assertEpochScar(tx);
  assertAgentBatch(tx, options);
  return { wallet, tx };
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
  AGENT_KEY_ENVS,
  AGENT_TX_TYPES,
  AGENT_TX_REFUSED,
  AGENT_CAPS,
  AGENT_ACCOUNTS,
  AGENT_SPECIAL,
  EPOCH_SCAR,
  ASF_DISABLE_MASTER,
  BANNED_TYPES,
  BATCH_HEARTBEAT,
  coded,
  isBatchIntent,
  batchGateOpen,
  assertBatchHeartbeat,
  assertBatchPrepare,
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
  assertAgentGate,
  assertAgentAllowlist,
  assertAgentRpc,
  assertAgentRequest,
  assertEpochScar,
  agentWallet,
  loadMotions,
  xrpOut,
  xrpFields,
};
