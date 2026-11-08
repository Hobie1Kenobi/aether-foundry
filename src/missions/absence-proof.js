"use strict";

/**
 * Absence of a signed payment is proven only from validated ledger data.
 * complete_ledgers must cover the account-creation ledger through
 * LastLedgerSequence without a gap. The creation ledger comes from the
 * validated AccountRoot and its creating transaction, not from Sequence,
 * the clock, or a stored guess. A server that starts at ledger 32570 can
 * cover a later creation. Ledger 1 is not required, and it is not invented.
 * txnNotFound outside that covered span is not absence.
 */

const { rpc } = require("./ledger-window");

const HASH_RE = /^[0-9A-Fa-f]{64}$/;

function proof(extra) {
  return Object.assign({
    proven: false,
    reason: "creation_unproven",
    validated_ledger: null,
    complete_ledgers: null,
    creation_ledger: null,
    hash_found: null,
    history_covers: false,
    creation_proven: false,
  }, extra);
}

function parseCompleteLedgers(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed === "empty") return null;
  const ranges = [];
  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(piece);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] == null ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
    ranges.push([start, end]);
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return ranges;
}

function rangesCover(ranges, from, through) {
  if (!ranges || !Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 1 || through < from) return false;
  let cursor = from;
  for (const [start, end] of ranges) {
    if (end < cursor) continue;
    if (start > cursor) return false;
    cursor = Math.max(cursor, end + 1);
    if (cursor > through) return true;
  }
  return false;
}

function coveredBlockStart(ranges, from, through) {
  if (!rangesCover(ranges, from, through)) return null;
  let low = from;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [start, end] of ranges) {
      if (end + 1 >= low && start < low) {
        low = start;
        changed = true;
      }
    }
  }
  return low;
}

function integerField(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sameLedger(actual, expected) {
  if (actual == null) return false;
  const parsed = Number(actual);
  return Number.isSafeInteger(parsed) && parsed === expected;
}

function createdThisAccount(meta, account, creationLedger) {
  const nodes = meta && meta.AffectedNodes;
  if (!Array.isArray(nodes)) return false;
  let created = 0;
  let deleted = 0;
  for (const node of nodes) {
    const made = node && node.CreatedNode;
    const removed = node && node.DeletedNode;
    if (removed && removed.LedgerEntryType === "AccountRoot") deleted += 1;
    if (!made || made.LedgerEntryType !== "AccountRoot") continue;
    const fields = made.NewFields || {};
    if (fields.Account !== account) continue;
    if (fields.Sequence != null && Number(fields.Sequence) !== creationLedger) return false;
    created += 1;
  }
  return created === 1 && deleted === 0;
}

function txHashOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  const tx = entry.tx && typeof entry.tx === "object" ? entry.tx : entry;
  const hash = tx.hash || entry.hash;
  return typeof hash === "string" ? hash.toUpperCase() : null;
}

function txLedgerOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  const tx = entry.tx && typeof entry.tx === "object" ? entry.tx : entry;
  const ledger = tx.ledger_index != null ? tx.ledger_index : entry.ledger_index;
  return integerField(Number.isSafeInteger(ledger) ? ledger : Number(ledger));
}

async function proveSignedAbsence(fetchImpl, claim, endpoint) {
  const account = claim && claim.account;
  const claimHash = typeof claim.hash === "string" ? claim.hash.toUpperCase() : "";
  const last = claim && claim.lastLedgerSequence;
  const sequence = claim && claim.sequence;
  const call = (method, params) => rpc(fetchImpl, method, params, endpoint);
  if (!account || !HASH_RE.test(claimHash) || !integerField(last) || !integerField(sequence)) {
    return proof({ reason: "creation_unproven" });
  }
  const info = await call("server_info", {});
  const node = info && info.result && info.result.info;
  if (!node || Number(node.network_id) !== 1) {
    const error = new Error("fee RPC did not prove network id 1");
    error.code = "MAINNET";
    throw error;
  }
  const validated = integerField(node.validated_ledger && node.validated_ledger.seq);
  const completeLedgers = typeof node.complete_ledgers === "string" ? node.complete_ledgers : "";
  const ranges = parseCompleteLedgers(completeLedgers);
  const base = {
    validated_ledger: validated,
    complete_ledgers: completeLedgers || null,
  };
  if (!validated) return proof(Object.assign({ reason: "ledger_mismatch" }, base));
  if (validated <= last) return proof(Object.assign({ reason: "window_open" }, base));

  const looked = await call("tx", { transaction: claimHash, binary: false });
  const lookedResult = (looked && looked.result) || {};
  if (lookedResult.validated === false) return proof(Object.assign({ reason: "lookup_unknown" }, base));
  if (typeof lookedResult.hash === "string") {
    return proof(Object.assign({ reason: "hash_present", hash_found: true }, base));
  }
  if (lookedResult.error !== "txnNotFound") {
    return proof(Object.assign({ reason: "lookup_unknown", hash_found: null }, base));
  }

  const current = await call("account_info", { account, ledger_index: validated });
  const currentResult = (current && current.result) || {};
  if (currentResult.validated !== true || !sameLedger(currentResult.ledger_index, validated)) {
    return proof(Object.assign({ reason: "ledger_mismatch", hash_found: false }, base));
  }
  const data = currentResult.account_data || {};
  if (data.Account !== account) return proof(Object.assign({ reason: "creation_unproven", hash_found: false }, base));
  const creationLedger = integerField(data.PreviousTxnLgrSeq);
  const previousHash = typeof data.PreviousTxnID === "string" ? data.PreviousTxnID.toUpperCase() : "";
  if (!creationLedger || !HASH_RE.test(previousHash) || creationLedger > last) {
    return proof(Object.assign({ reason: "creation_unproven", hash_found: false }, base));
  }
  if (data.Sequence !== sequence || data.Sequence !== creationLedger) {
    return proof(Object.assign({
      reason: "sequence_moved",
      hash_found: false,
      creation_ledger: creationLedger,
    }, base));
  }
  const covered = rangesCover(ranges, creationLedger, last);
  const located = Object.assign({
    hash_found: false,
    creation_ledger: creationLedger,
    history_covers: covered,
  }, base);
  if (!covered) return proof(Object.assign({ reason: "history_incomplete" }, located));

  const created = await call("tx", { transaction: previousHash, binary: false });
  const createdResult = (created && created.result) || {};
  if (createdResult.validated !== true
    || !sameLedger(createdResult.ledger_index, creationLedger)
    || String(createdResult.hash || "").toUpperCase() !== previousHash
    || !createdResult.meta
    || createdResult.meta.TransactionResult !== "tesSUCCESS"
    || !createdThisAccount(createdResult.meta, account, creationLedger)) {
    return proof(Object.assign({ reason: "creation_unproven" }, located));
  }

  const prior = await call("account_info", { account, ledger_index: creationLedger - 1 });
  const priorResult = (prior && prior.result) || {};
  if (priorResult.validated === false || (priorResult.ledger_index != null && !sameLedger(priorResult.ledger_index, creationLedger - 1))) {
    return proof(Object.assign({ reason: "ledger_mismatch" }, located));
  }
  if (priorResult.error !== "actNotFound" || priorResult.account_data) {
    return proof(Object.assign({ reason: "account_recreated" }, located));
  }

  const historyStart = coveredBlockStart(ranges, creationLedger, last);
  const listed = await call("account_tx", {
    account,
    ledger_index_min: historyStart,
    ledger_index_max: last,
    binary: false,
    forward: true,
    limit: 2,
  });
  const listedResult = (listed && listed.result) || {};
  if (listedResult.validated !== true
    || !sameLedger(listedResult.ledger_index_min, historyStart)
    || !sameLedger(listedResult.ledger_index_max, last)
    || listedResult.marker != null
    || !Array.isArray(listedResult.transactions)
    || listedResult.transactions.length !== 1) {
    return proof(Object.assign({ reason: "account_recreated" }, located));
  }
  const only = listedResult.transactions[0];
  if (only.validated === false || txHashOf(only) !== previousHash || txLedgerOf(only) !== creationLedger) {
    return proof(Object.assign({ reason: "account_recreated" }, located));
  }
  const onlyMeta = only.meta || (only.tx && only.tx.meta);
  if (onlyMeta && onlyMeta.AffectedNodes && !createdThisAccount(onlyMeta, account, creationLedger)) {
    return proof(Object.assign({ reason: "account_recreated" }, located));
  }

  const header = await call("ledger", { ledger_index: last, transactions: false, expand: false });
  const headerResult = (header && header.result) || {};
  const ledger = headerResult.ledger || {};
  const ledgerIndex = headerResult.ledger_index != null ? headerResult.ledger_index : ledger.ledger_index;
  if (headerResult.validated !== true || !sameLedger(ledgerIndex, last) || !HASH_RE.test(String(ledger.ledger_hash || ""))) {
    return proof(Object.assign({ reason: "ledger_mismatch" }, located));
  }

  return proof(Object.assign({
    proven: true,
    reason: "ledger_window",
    creation_proven: true,
    history_covers: true,
  }, located));
}

module.exports = {
  parseCompleteLedgers,
  rangesCover,
  coveredBlockStart,
  proveSignedAbsence,
};
