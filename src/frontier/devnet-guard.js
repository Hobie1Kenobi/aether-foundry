"use strict";

/**
 * Shared guards for F8, F9, and F10. XRPL Devnet only (network id 2).
 * Seeds stay in env. This module does not print them and does not archive
 * into the Testnet ledger log, NAV, or desk metrics.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const policy = require("../runtime/policy");
const { rpcCall } = require("../director/snapshot");
const amendments = require("./probe-amendments");
const probe = require("./probe-devnet");

const NETWORK = probe.NETWORK_LABEL;
const NETWORK_ID = probe.XRPL_DEVNET_NETWORK_ID;
const XRPL_DEVNET_HTTP = probe.XRPL_DEVNET_HTTP;
const XRPL_DEVNET_WS = "wss://s.devnet.rippletest.net:51233";
const LEDGER_REL = path.join("lab", "frontier", "devnet-ledger.jsonl");
const TESTNET_LEDGER_REL = path.join("lab", "ledger-log.jsonl");

const AETH_LABOR_ISSUANCE = "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED";

const ADDRESS_ENV = {
  D0: "D0_ADDRESS",
  D1: "D1_ADDRESS",
  D2: "D2_ADDRESS",
  D3: "D3_ADDRESS",
  SENDER: "D_CONF_SENDER_ADDRESS",
};

const SEED_ENV = {
  D0: "D0_SEED",
  D1: "D1_SEED",
  D2: "D2_SEED",
  D3: "D3_SEED",
  SENDER: "D_CONF_SENDER_SEED",
  D0_ELGAMAL: "D0_ELGAMAL_SEED",
  D3_ELGAMAL: "D3_ELGAMAL_SEED",
  SENDER_ELGAMAL: "D_CONF_SENDER_ELGAMAL_SEED",
};

const DEVNET_SEED_ENVS = Object.values(SEED_ENV);

const LABELED_ROLES = {
  W0: anchors.WALLETS.W0.address,
  W1: anchors.WALLETS.W1.address,
  W2: anchors.WALLETS.W2.address,
  W3: anchors.WALLETS.W3.address,
  W4: anchors.WALLETS.W4.address,
  W5: anchors.WALLETS.W5.address,
  W6: anchors.WALLETS.W6.address,
  BUYER: "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth",
  STRANGER: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
  AMM: anchors.AMM,
  FOREIGN: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ",
};

const PROOF_FIELDS = [
  "ZKProof",
  "SenderEncryptedAmount",
  "DestinationEncryptedAmount",
  "IssuerEncryptedAmount",
  "HolderEncryptedAmount",
  "AmountCommitment",
  "BalanceCommitment",
  "AuditorEncryptedAmount",
];

function coded(message, code) {
  return Object.assign(new Error(message), { code: code || "REFUSED" });
}

function labeledRole(address) {
  for (const [role, value] of Object.entries(LABELED_ROLES)) {
    if (value === address) return role;
  }
  return null;
}

function assertClassic(address, label) {
  const name = label || "address";
  const text = typeof address === "string" ? address.trim() : "";
  if (!text || text === "_blank_") throw coded(`${name} is blank`, "ADDRESS");
  if (!anchors.ADDRESS_RE.test(text)) throw coded(`${name} is not a classic address`, "ADDRESS");
  return text;
}

function assertNotLabeled(address, label) {
  const text = assertClassic(address, label);
  const role = labeledRole(text);
  if (role) {
    throw coded(`${label || "address"} is Testnet ${role}; refusing a Devnet sponsor or counterparty`, "LABELED");
  }
  return text;
}

function assertDistinct(pairs) {
  const seen = new Map();
  for (const [label, address] of pairs) {
    const prev = seen.get(address);
    if (prev) throw coded(`${label} is the same account as ${prev}`, "ADDRESS");
    seen.set(address, label);
  }
}

function assertDevnetId(id) {
  if (id == null || id === "") throw coded("refusing missing network id", "MAINNET");
  const n = Number(id);
  if (!Number.isInteger(n)) throw coded(`refusing network id ${id}`, "MAINNET");
  if (n === 0 || n === anchors.XAHAU_MAINNET_ID) throw coded(`refusing mainnet network id ${n}`, "MAINNET");
  if (n === anchors.XRPL_NETWORK_ID) throw coded("refusing Testnet network id 1", "MAINNET");
  if (n !== NETWORK_ID) throw coded(`refusing network id ${n}`, "MAINNET");
  return n;
}

function resolveHttp(env, override) {
  try {
    return probe.resolveHttp(env || {}, override || null);
  } catch (error) {
    if (error && error.code) throw error;
    const message = error && error.message ? error.message : String(error);
    throw coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
}

function resolveWs(env, httpUrl) {
  const named = env && (env.FOUNDRY_XRPL_DEVNET_WS || env.XRPL_DEVNET_WS);
  const raw = (named && String(named).trim()) || XRPL_DEVNET_WS;
  let hostname;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    throw coded("refusing unparseable XRPL websocket", "MAINNET");
  }
  if (anchors.isMainnetHost(hostname)) throw coded("refusing mainnet XRPL websocket", "MAINNET");
  let pub;
  try {
    pub = amendments.publicRpc(raw);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
  if (httpUrl) {
    const httpHost = new URL(httpUrl).hostname;
    const wsHost = new URL(pub).hostname;
    if (httpHost !== wsHost) throw coded("Devnet websocket host does not match the HTTP host", "MAINNET");
  }
  return pub;
}

async function loadAmendments(opts) {
  const options = opts || {};
  const http = resolveHttp(options.env, options.xrplHttp || null);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const info = await rpcCall(http, "server_info", {}, fetchImpl);
  const server = amendments.readServer(info, NETWORK_ID);
  assertDevnetId(server.network_id);
  const feature = await rpcCall(http, "feature", {}, fetchImpl);
  const rows = amendments.readAmendments(feature);
  const required = assertEnabled(rows, options.names || []);
  return {
    http,
    network: NETWORK,
    network_id: server.network_id,
    build_version: server.build_version,
    amendments: required,
    watched: rows,
  };
}

function assertEnabled(rows, names) {
  if (!Array.isArray(rows)) throw coded("feature response omitted amendments", "AMENDMENT");
  const picked = [];
  for (const name of names) {
    const row = rows.find((item) => item && item.name === name);
    if (!row) throw coded(`feature response omitted ${name}; refusing to mark it disabled`, "AMENDMENT");
    if (row.enabled !== true) throw coded(`${name} is disabled; refusing the Devnet transaction`, "AMENDMENT");
    const hash = row.hash == null ? "" : String(row.hash).toUpperCase();
    if (!anchors.HASH_RE.test(hash)) throw coded(`feature response omitted hash for ${name}`, "AMENDMENT");
    picked.push({ name, enabled: true, hash });
  }
  return picked;
}

function assertNotLaborIssuance(value, label) {
  if (value == null || value === "") return;
  const text = String(value).toUpperCase();
  if (text === AETH_LABOR_ISSUANCE) {
    throw coded(`${label || "issuance"} is the Testnet AETH-LABOR id`, "ASSET");
  }
}

function assertHashId(value, label) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!anchors.HASH_RE.test(text)) throw coded(`${label || "id"} is not 64 hex`, "ID");
  return text;
}

function assertIssuanceId(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[0-9A-F]{48}$/.test(text)) throw coded("mpt issuance id is not 48 hex", "ISSUANCE");
  assertNotLaborIssuance(text, "mpt issuance id");
  return text;
}

function assertElgamalPublic(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^(02|03)[0-9A-F]{64}$/.test(text)) {
    throw coded("issuer encryption key is not a 33-byte compressed public key", "KEY");
  }
  return text;
}

function assertNoProofMaterial(tx) {
  if (!tx || typeof tx !== "object") return tx;
  for (const key of PROOF_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(tx, key)) {
      throw coded(`builder invented ${key}`, "PROOF");
    }
  }
  return tx;
}

function addressFrom(env, id, override) {
  const key = ADDRESS_ENV[id];
  if (!key) throw coded(`unknown Devnet account ${id}`, "ADDRESS");
  const raw = override != null && String(override).trim() ? override : env && env[key];
  return assertNotLabeled(raw, id);
}

function readSeed(name, env, io) {
  if (!DEVNET_SEED_ENVS.includes(name)) throw coded(`refusing seed key ${name}`, "SEED");
  if (name.startsWith("W")) throw coded(`refusing seed key ${name}`, "SEED");
  const fromEnv = env && env[name];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const file = (env && env.AETHER_SECRETS) || "/workspace/aether-foundry-secrets/.env";
  const exists = (io && io.existsSync) || fs.existsSync;
  const read = (io && io.readFileSync) || fs.readFileSync;
  if (!exists(file)) throw coded(`${name} is not loaded`, "NO_SEED");
  for (const line of String(read(file, "utf8")).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || match[1] !== name) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value.trim()) break;
    return value.trim();
  }
  throw coded(`${name} is not loaded`, "NO_SEED");
}

function assertSigningSeedDistinct(signing, elgamal) {
  if (signing && elgamal && signing === elgamal) {
    throw coded("refusing to reuse a signing seed as an ElGamal seed", "ELGAMAL");
  }
}

function readEngine(submitted) {
  const result = (submitted && submitted.result) || submitted || {};
  const meta = result.meta || result.metaData || {};
  const hash = result.hash == null ? "" : String(result.hash).toUpperCase();
  const engine = meta.TransactionResult || null;
  if (engine !== "tesSUCCESS" || !anchors.HASH_RE.test(hash)) {
    throw coded(`result ${engine || "missing"}`, "SUBMIT");
  }
  const ledger = result.ledger_index;
  return {
    hash,
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(ledger) ? ledger : null,
    meta,
  };
}

function createdIndex(meta, ledgerEntryType) {
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  for (const node of nodes) {
    const created = node && node.CreatedNode;
    if (!created || created.LedgerEntryType !== ledgerEntryType) continue;
    const index = created.LedgerIndex == null ? "" : String(created.LedgerIndex).toUpperCase();
    if (anchors.HASH_RE.test(index)) return index;
  }
  return null;
}

function metaHash(meta, keys) {
  for (const key of keys) {
    const value = meta && meta[key];
    if (typeof value === "string" && anchors.HASH_RE.test(value.toUpperCase())) return value.toUpperCase();
  }
  return null;
}

function issuanceFromMeta(meta) {
  const direct = meta && (meta.mpt_issuance_id || meta.MPTokenIssuanceID);
  if (typeof direct === "string" && /^[0-9A-F]{48}$/i.test(direct)) {
    const id = direct.toUpperCase();
    assertNotLaborIssuance(id, "mpt issuance id");
    return id;
  }
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  for (const node of nodes) {
    const created = node && node.CreatedNode;
    if (!created || created.LedgerEntryType !== "MPTokenIssuance") continue;
    const fields = created.NewFields || {};
    const raw = fields.MPTokenIssuanceID || fields.mpt_issuance_id;
    if (typeof raw === "string" && /^[0-9A-F]{48}$/i.test(raw)) {
      const id = raw.toUpperCase();
      assertNotLaborIssuance(id, "mpt issuance id");
      return id;
    }
  }
  return null;
}

function archiveDevnet(root, row) {
  if (!row || row.network !== NETWORK || row.network_id !== NETWORK_ID) {
    throw coded("refusing to archive a non-Devnet row", "RECORD");
  }
  if (row.result !== "tesSUCCESS") throw coded("refusing to archive without tesSUCCESS", "RECORD");
  const hash = String(row.hash || "").toUpperCase();
  if (!anchors.HASH_RE.test(hash)) throw coded("refusing to archive without a ledger hash", "RECORD");
  const clean = Object.assign({}, row, { hash, network: NETWORK, network_id: NETWORK_ID, result: "tesSUCCESS" });
  policy.assertNoSeedFields(clean);
  const file = path.join(root, LEDGER_REL);
  if (path.resolve(file) === path.resolve(root, TESTNET_LEDGER_REL)) {
    throw coded("refusing to archive Devnet into the Testnet ledger log", "RECORD");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(clean)}\n`);
  return clean;
}

async function withDevnetClient(opts, fn) {
  const options = opts || {};
  assertDevnetId(options.networkId);
  const http = options.http || resolveHttp(options.env, options.xrplHttp || null);
  const ws = options.ws || resolveWs(options.env, http);
  const xrpl = options.xrpl || require("xrpl");
  const client = options.client || new xrpl.Client(ws);
  const opened = !options.client;
  if (opened) await client.connect();
  try {
    if (client.networkID == null || client.networkID === "") {
      throw coded("RPC did not prove network id", "MAINNET");
    }
    assertDevnetId(client.networkID);
    return await fn({ xrpl, client, http, ws });
  } finally {
    if (opened) {
      try {
        await client.disconnect();
      } catch {
        /* already closed */
      }
    }
  }
}

function assertPrepared(prepared) {
  if (prepared && prepared.NetworkID != null) assertDevnetId(prepared.NetworkID);
  return prepared;
}

async function submitAutofill(tx, seed, expectedAddress, opts) {
  return withDevnetClient(opts, async ({ xrpl, client }) => {
    const wallet = xrpl.Wallet.fromSeed(seed);
    if ((wallet.classicAddress || wallet.address) !== expectedAddress) {
      throw coded("seed does not match the Devnet address", "SIGNER");
    }
    const prepared = assertPrepared(await client.autofill(tx));
    const signed = wallet.sign(prepared);
    return readEngine(await client.submitAndWait(signed.tx_blob));
  });
}

async function submitBlob(txBlob, opts) {
  if (typeof txBlob !== "string" || !/^[0-9A-F]+$/i.test(txBlob)) {
    throw coded("refusing an empty signed blob", "SUBMIT");
  }
  return withDevnetClient(opts, async ({ client }) => readEngine(await client.submitAndWait(txBlob)));
}

function walletFromSeed(xrpl, seed, expectedAddress) {
  let wallet;
  try {
    wallet = xrpl.Wallet.fromSeed(seed);
  } catch {
    throw coded("seed is not usable", "NO_SEED");
  }
  if ((wallet.classicAddress || wallet.address) !== expectedAddress) {
    throw coded("seed does not match the Devnet address", "SIGNER");
  }
  return wallet;
}

function flagValue(argv, name) {
  const args = Array.isArray(argv) ? argv : [];
  return args.includes(name);
}

function optionValue(argv, name) {
  const args = Array.isArray(argv) ? argv : [];
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw coded(`${name} needs a value`, "ARGS");
  return value;
}

module.exports = {
  NETWORK,
  NETWORK_ID,
  XRPL_DEVNET_HTTP,
  XRPL_DEVNET_WS,
  LEDGER_REL,
  TESTNET_LEDGER_REL,
  AETH_LABOR_ISSUANCE,
  ADDRESS_ENV,
  SEED_ENV,
  DEVNET_SEED_ENVS,
  LABELED_ROLES,
  PROOF_FIELDS,
  coded,
  labeledRole,
  assertClassic,
  assertNotLabeled,
  assertDistinct,
  assertDevnetId,
  resolveHttp,
  resolveWs,
  assertEnabled,
  assertNotLaborIssuance,
  assertHashId,
  assertIssuanceId,
  assertElgamalPublic,
  assertNoProofMaterial,
  addressFrom,
  readSeed,
  assertSigningSeedDistinct,
  readEngine,
  createdIndex,
  metaHash,
  issuanceFromMeta,
  archiveDevnet,
  withDevnetClient,
  assertPrepared,
  submitAutofill,
  submitBlob,
  walletFromSeed,
  flagValue,
  optionValue,
  loadAmendments,
};
