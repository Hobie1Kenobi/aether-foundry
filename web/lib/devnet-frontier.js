"use strict";

/**
 * Public XRPL Devnet snapshot for the desk.
 * Reads corp/wallets.md D0–D3 and lab/frontier/devnet-ledger.jsonl.
 * No seeds, no Devnet RPC, and no Testnet NAV fields.
 */

const TESTNET_LABOR_ISSUANCE = "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED";
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HASH_RE = /^[0-9A-F]{64}$/;
const HEX_ID_RE = /^[0-9A-F]{16,64}$/;
const TOKEN_RE = /^[A-Z0-9-]{2,16}$/;
const SEED_RE = /sEd[1-9A-HJ-NP-Za-km-z]{15,}/;
const SECRET_KEY_RE = /(^|_)(seed|secret|private_?key|elgamal)($|_)/i;
const ACCOUNT_IDS = ["D0", "D1", "D2", "D3"];

function emptySnapshot() {
  return {
    network: "XRPL Devnet",
    networkId: 2,
    accounts: { D0: null, D1: null, D2: null, D3: null },
    f8: {
      sponsor: null,
      sponsoree: null,
      prior_sponsee: null,
      create_hash: null,
      object_hash: null,
      ledger_index: null,
    },
    f9: {
      owner: null,
      depositor: null,
      vault_id: null,
      broker_id: null,
      loan_id: null,
      asset: null,
      accounting: null,
      create_hash: null,
      repay_hash: null,
      ledger_index: null,
    },
    f10: {
      issuer: null,
      counterparty: null,
      sender: null,
      symbol: null,
      issuance_id: null,
      payment_hash: null,
      clawback_hash: null,
      ledger_index: null,
      public_ledger: null,
    },
  };
}

function cell(raw) {
  return String(raw || "").replace(/`/g, "").trim();
}

function bannedSet(labeled) {
  return new Set(Array.isArray(labeled) ? labeled.filter((item) => typeof item === "string") : []);
}

function hasSecret(row) {
  if (SEED_RE.test(JSON.stringify(row))) return true;
  return Object.keys(row).some((key) => SECRET_KEY_RE.test(key));
}

function validAddress(value, banned) {
  const address = String(value || "").trim();
  if (!ADDRESS_RE.test(address)) return null;
  if (banned.has(address)) return null;
  return address;
}

function validHash(value) {
  const hash = String(value || "").trim().toUpperCase();
  return HASH_RE.test(hash) ? hash : null;
}

function validHexId(value) {
  if (value == null || value === "") return null;
  const id = String(value).trim().toUpperCase();
  if (!HEX_ID_RE.test(id)) return null;
  if (id === TESTNET_LABOR_ISSUANCE) return null;
  return id;
}

function validToken(value) {
  const token = String(value || "").trim().toUpperCase();
  return TOKEN_RE.test(token) ? token : null;
}

function ledgerIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function parseWallets(markdown, banned) {
  const accounts = { D0: null, D1: null, D2: null, D3: null };
  for (const line of String(markdown || "").split("\n")) {
    if (!line.startsWith("|")) continue;
    const parts = line.split("|").map(cell);
    const id = parts[1];
    if (!ACCOUNT_IDS.includes(id)) continue;
    if (parts[4] !== "XRPL Devnet") continue;
    const address = validAddress(parts[3], banned);
    if (address) accounts[id] = address;
  }
  return accounts;
}

function rowNetworkOk(row) {
  const name = row.network == null ? "" : String(row.network).trim();
  const rawId = row.network_id != null ? row.network_id : row.networkId;
  if (name === "xrpl:0" || name === "xrpl:1" || name === "XRPL Testnet") return false;
  if (/mainnet/i.test(name)) return false;
  if (rawId === 0 || rawId === 1 || rawId === "0" || rawId === "1") return false;
  const id = rawId == null || rawId === "" ? null : Number(rawId);
  if (id != null && id !== 2) return false;
  const nameOk = name === "XRPL Devnet" || name === "xrpl:2";
  if (name && !nameOk) return false;
  return nameOk || id === 2;
}

function laneOf(row) {
  const action = String(row.action || "").toLowerCase();
  if (action === "devnet_sponsor" || action === "sponsor") return "f8";
  if (action === "devnet_vault" || action === "vault" || action === "loan") return "f9";
  if (action === "devnet_confidential" || action === "confidential") return "f10";
  const experiment = String(row.experiment || row.band || "").toUpperCase();
  if (experiment === "F8") return "f8";
  if (experiment === "F9") return "f9";
  if (experiment === "F10") return "f10";
  return null;
}

function applyRow(snapshot, row, banned) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  if (!rowNetworkOk(row) || hasSecret(row)) return;
  if (row.result != null && row.result !== "tesSUCCESS") return;
  const lane = laneOf(row);
  if (!lane) return;
  const hash = validHash(row.hash || row.tx_hash || row.transaction);
  const index = ledgerIndex(row.ledger_index);
  const step = String(row.step || "").toLowerCase();
  if (lane === "f8") {
    const sponsor = validAddress(row.sponsor, banned);
    const sponsee = validAddress(row.sponsee || row.sponsoree, banned);
    if (sponsor) snapshot.f8.sponsor = sponsor;
    if (step === "object") {
      if (hash) snapshot.f8.object_hash = hash;
      if (sponsee) snapshot.f8.prior_sponsee = sponsee;
      return;
    }
    if (sponsee) snapshot.f8.sponsoree = sponsee;
    if (hash) snapshot.f8.create_hash = hash;
    if (index) snapshot.f8.ledger_index = index;
    return;
  }
  if (lane === "f9") {
    const asset = validToken(row.asset);
    const accounting = String(row.accounting || "").trim().toLowerCase();
    if (asset) snapshot.f9.asset = asset;
    if (accounting === "cash-basis" || accounting === "accrual") snapshot.f9.accounting = accounting;
    const objectId = validHexId(row.object_id || row.vault_id || row.loan_id || row.broker_id);
    if (step === "create") {
      const vaultId = validHexId(row.vault_id || row.object_id);
      if (vaultId) snapshot.f9.vault_id = vaultId;
      if (hash) snapshot.f9.create_hash = hash;
      if (index && snapshot.f9.ledger_index == null) snapshot.f9.ledger_index = index;
    } else if (step === "broker") {
      const brokerId = validHexId(row.broker_id || row.object_id);
      if (brokerId) snapshot.f9.broker_id = brokerId;
    } else if (step === "loan") {
      const loanId = validHexId(row.loan_id || row.object_id);
      if (loanId) snapshot.f9.loan_id = loanId;
      if (index) snapshot.f9.ledger_index = index;
    } else if (step === "repay" && hash) {
      snapshot.f9.repay_hash = hash;
    } else if (objectId && step === "vault") {
      snapshot.f9.vault_id = objectId;
    }
    return;
  }
  const issuance = validHexId(row.mpt_issuance_id || row.issuance_id);
  if (issuance) snapshot.f10.issuance_id = issuance;
  const symbol = validToken(row.symbol);
  if (symbol) snapshot.f10.symbol = symbol;
  if (step === "pay") {
    if (hash) snapshot.f10.payment_hash = hash;
    const sender = validAddress(row.account, banned);
    if (sender) snapshot.f10.sender = sender;
    if (index) snapshot.f10.ledger_index = index;
    if (typeof row.public_ledger === "string") {
      const note = row.public_ledger.trim();
      if (note && note.length <= 240 && !SEED_RE.test(note)) snapshot.f10.public_ledger = note;
    }
  } else if (step === "clawback" && hash) {
    snapshot.f10.clawback_hash = hash;
  }
}

function fillRoles(snapshot) {
  snapshot.f8.sponsor = snapshot.f8.sponsor || snapshot.accounts.D0;
  snapshot.f8.sponsoree = snapshot.f8.sponsoree || snapshot.accounts.D2;
  snapshot.f9.owner = snapshot.accounts.D0;
  snapshot.f9.depositor = snapshot.accounts.D1;
  snapshot.f10.issuer = snapshot.accounts.D0;
  snapshot.f10.counterparty = snapshot.accounts.D3;
  if (snapshot.f8.prior_sponsee && snapshot.f8.prior_sponsee === snapshot.f8.sponsoree) {
    snapshot.f8.prior_sponsee = null;
  }
  if (snapshot.f10.sender && (snapshot.f10.sender === snapshot.f10.issuer || snapshot.f10.sender === snapshot.f10.counterparty)) {
    snapshot.f10.sender = null;
  }
}

function publicSnapshot(input) {
  const source = input || {};
  const banned = bannedSet(source.labeled);
  const snapshot = emptySnapshot();
  Object.assign(snapshot.accounts, parseWallets(source.walletsText, banned));
  for (const line of String(source.ledgerText || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    applyRow(snapshot, row, banned);
  }
  fillRoles(snapshot);
  return snapshot;
}

module.exports = {
  TESTNET_LABOR_ISSUANCE,
  emptySnapshot,
  parseWallets,
  publicSnapshot,
};
