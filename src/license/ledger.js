"use strict";

/**
 * Read-only XRPL Testnet helpers for license checks.
 * Never submits a signed blob. Failover is for reads only.
 */

const fs = require("fs");
const path = require("path");
const hosts = require("../xrpl-hosts");
const pub = require("../walk-in-public");
const catalog = require("./catalog");

function coded(message, code) {
  return catalog.coded(message, code);
}

async function post(url, method, params, fetchImpl) {
  pub.assertTestnetUrl(url);
  const fetchFn = fetchImpl || globalThis.fetch;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params: [params || {}] }),
    signal: AbortSignal.timeout(15000),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw coded("RPC body was not JSON", "RPC");
  }
  const result = body && body.result;
  if (!res.ok || !result || result.error || result.status === "error") {
    const detail = (result && (result.error_message || result.error)) || `HTTP ${res.status}`;
    throw coded(`RPC ${method} failed: ${detail}`, "RPC");
  }
  return result;
}

async function proveNetwork(env, fetchImpl) {
  const primary = hosts.resolveHttp(env || {});
  return hosts.withFailover(primary, async (url) => {
    const result = await post(url, "server_info", {}, fetchImpl);
    const id = result.info && result.info.network_id;
    if (id == null || id === "") throw coded("RPC did not prove network id", "RPC");
    if (Number(id) !== 1) throw coded(`refusing network id ${id}`, "MAINNET");
    return { url, networkId: 1, info: result };
  });
}

async function sellOfferAt(url, offerId, fetchImpl) {
  const id = String(offerId || "").toUpperCase();
  if (!catalog.HEX64.test(id)) throw coded("license buy requires NFTokenSellOffer", "TX");
  const result = await post(url, "ledger_entry", { index: id, ledger_index: "validated" }, fetchImpl);
  if (result.validated !== true) throw coded("sell offer was not a validated ledger", "RPC");
  const node = result.node;
  if (!node || node.LedgerEntryType !== "NFTokenOffer") {
    throw coded("sell offer is not an NFTokenOffer", "TX");
  }
  return node;
}

async function accountNfts(url, account, fetchImpl) {
  const nfts = [];
  let marker;
  for (let page = 0; page < 4; page += 1) {
    const params = { account, ledger_index: "validated", limit: 200 };
    if (marker !== undefined) params.marker = marker;
    const result = await post(url, "account_nfts", params, fetchImpl);
    if (result.validated !== true) throw coded("account_nfts was not a validated ledger", "RPC");
    nfts.push(...(result.account_nfts || []));
    if (result.marker == null) return nfts;
    marker = result.marker;
  }
  throw coded("account_nfts pagination exceeded 4 pages", "RPC");
}

async function accountInfo(url, account, fetchImpl) {
  const result = await post(url, "account_info", { account, ledger_index: "validated" }, fetchImpl);
  if (result.validated !== true) throw coded("account_info was not a validated ledger", "RPC");
  return result;
}

async function accountObjects(url, account, fetchImpl) {
  const objects = [];
  let marker;
  let ledgerIndex = null;
  for (let page = 0; page < 4; page += 1) {
    const params = { account, ledger_index: "validated", limit: 200 };
    if (marker !== undefined) params.marker = marker;
    const result = await post(url, "account_objects", params, fetchImpl);
    if (result.validated !== true) throw coded("account_objects was not a validated ledger", "RPC");
    if (result.ledger_index != null) ledgerIndex = result.ledger_index;
    objects.push(...(result.account_objects || []));
    if (result.marker == null) return { objects, ledgerIndex };
    marker = result.marker;
  }
  throw coded("account_objects pagination exceeded 4 pages", "RPC");
}

function extractNFTokenID(meta) {
  const nodes = (meta && meta.AffectedNodes) || [];
  const ids = [];
  for (const node of nodes) {
    const mod = node.CreatedNode || node.ModifiedNode;
    if (!mod || mod.LedgerEntryType !== "NFTokenPage") continue;
    const final = mod.NewFields || mod.FinalFields;
    const prev = mod.PreviousFields;
    const finalIds = ((final && final.NFTokens) || []).map((row) => row.NFToken.NFTokenID);
    const prevIds = ((prev && prev.NFTokens) || []).map((row) => row.NFToken.NFTokenID);
    for (const id of finalIds) {
      if (!prevIds.includes(id)) ids.push(String(id).toUpperCase());
    }
    if (node.CreatedNode) {
      for (const id of finalIds) {
        const upper = String(id).toUpperCase();
        if (!ids.includes(upper)) ids.push(upper);
      }
    }
  }
  if (ids.length) return ids[ids.length - 1];
  if (meta && meta.nftoken_id) return String(meta.nftoken_id).toUpperCase();
  return null;
}

function extractOfferID(meta) {
  for (const node of (meta && meta.AffectedNodes) || []) {
    const created = node.CreatedNode;
    if (created && created.LedgerEntryType === "NFTokenOffer" && created.LedgerIndex) {
      return String(created.LedgerIndex).toUpperCase();
    }
  }
  return null;
}

function findHeld(nfts, nftokenId) {
  const id = String(nftokenId || "").toUpperCase();
  return (nfts || []).find((row) => row && String(row.NFTokenID || "").toUpperCase() === id) || null;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function metadataPath(root, hash) {
  return path.join(root, "lab", "licenses", `${hash}.json`);
}

function loadMetadata(root, hash) {
  const id = String(hash || "").toUpperCase();
  if (!catalog.HEX64.test(id)) return null;
  const direct = metadataPath(root, id);
  const candidates = [direct];
  const desk = path.join(root, "machines", "agent-work-license", "desk");
  if (fs.existsSync(desk)) {
    for (const name of fs.readdirSync(desk)) {
      if (name.endsWith(".json")) candidates.push(path.join(desk, name));
    }
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const doc = catalog.metadata(JSON.parse(fs.readFileSync(file, "utf8")));
      if (catalog.contentHash(doc) === id) return doc;
    } catch {
      /* skip a desk file that is not license metadata */
    }
  }
  return null;
}

function writeMetadata(root, doc) {
  const row = catalog.metadata(doc);
  const hash = catalog.contentHash(row);
  const file = metadataPath(root, hash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${catalog.canonical(row)}\n`);
  return { hash, file, doc: row, uri: catalog.uriFor(row) };
}

module.exports = {
  post,
  proveNetwork,
  sellOfferAt,
  accountNfts,
  accountInfo,
  accountObjects,
  extractNFTokenID,
  extractOfferID,
  findHeld,
  readJsonl,
  appendJsonl,
  metadataPath,
  loadMetadata,
  writeMetadata,
};
