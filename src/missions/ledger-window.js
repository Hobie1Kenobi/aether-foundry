"use strict";

const { coded } = require("./ledger");

const MAX_LEDGER_WINDOW = 20;
const LABS_HTTP = "https://testnet.xrpl-labs.com";

function dropsField(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw coded(`${label} is missing or malformed`, "TX");
}

function assertPrepared(tx, account) {
  if (!tx || tx.TransactionType !== "Payment") throw coded("mission spend is a Payment", "TX");
  if (tx.NetworkID !== 1) throw coded("mission spend is network id 1 only", "MAINNET");
  dropsField(tx.Amount, "Amount");
  const fee = dropsField(tx.Fee, "Fee");
  if (fee > 10000) throw coded("Fee is outside the local bound", "FEE_CAP");
  if (!account || !Number.isSafeInteger(account.validated) || account.validated <= 0) {
    throw coded("validated ledger is missing", "LEDGER");
  }
  if (!Number.isSafeInteger(account.sequence) || account.sequence < 0) {
    throw coded("validated account sequence is missing", "TX");
  }
  if (!Number.isSafeInteger(tx.Sequence) || tx.Sequence < 0) {
    throw coded("Sequence is missing or malformed", "TX");
  }
  if (tx.Sequence !== account.sequence) throw coded("Sequence does not match the validated account", "TX");
  if (!Number.isSafeInteger(tx.LastLedgerSequence)) {
    throw coded("LastLedgerSequence is missing or malformed", "LEDGER");
  }
  const span = tx.LastLedgerSequence - account.validated;
  if (span < 1 || span > MAX_LEDGER_WINDOW) {
    throw coded("LastLedgerSequence is outside the validated-ledger window", "LEDGER");
  }
  return {
    TransactionType: "Payment",
    Account: tx.Account,
    Destination: tx.Destination,
    Amount: String(tx.Amount),
    Fee: String(tx.Fee),
    NetworkID: 1,
    Sequence: tx.Sequence,
    LastLedgerSequence: tx.LastLedgerSequence,
  };
}

function bindWindow(validated, sequence) {
  if (!Number.isSafeInteger(validated) || validated <= 0) throw coded("validated ledger is missing", "LEDGER");
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw coded("validated account sequence is missing", "TX");
  return {
    validated,
    sequence,
    lastLedgerSequence: validated + MAX_LEDGER_WINDOW,
  };
}

async function rpc(fetchImpl, method, params) {
  if (typeof fetchImpl !== "function") throw coded("validated ledger RPC is not configured", "LEDGER");
  let response;
  try {
    response = await fetchImpl(LABS_HTTP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "aether-foundry-missions",
      },
      body: JSON.stringify({ method, params: [params || {}] }),
    });
  } catch (error) {
    if (error && error.code) throw error;
    throw coded("XRPL Labs ledger RPC failed", "LEDGER");
  }
  if (!response || response.ok === false) throw coded("XRPL Labs ledger RPC failed", "LEDGER");
  return response.json();
}

async function readValidatedAccount(fetchImpl, account) {
  const info = await rpc(fetchImpl, "server_info", {});
  const node = info && info.result && info.result.info;
  if (!node || Number(node.network_id) !== 1) throw coded("fee RPC did not prove network id 1", "MAINNET");
  const validatedLedger = node.validated_ledger;
  const validated = validatedLedger && validatedLedger.seq;
  if (!Number.isSafeInteger(validated) || validated <= 0) {
    throw coded("validated ledger is missing", "LEDGER");
  }
  const acct = await rpc(fetchImpl, "account_info", { account, ledger_index: "validated" });
  const result = (acct && acct.result) || {};
  if (result.validated === false) throw coded("account sequence is not from a validated ledger", "LEDGER");
  const data = result.account_data;
  const sequence = data && data.Sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw coded("validated account sequence is missing", "TX");
  }
  return bindWindow(validated, sequence);
}

async function hashFound(fetchImpl, hash) {
  const body = await rpc(fetchImpl, "tx", { transaction: hash, binary: false });
  const result = (body && body.result) || {};
  if (result.error === "txnNotFound") return false;
  if (typeof result.hash === "string") return true;
  return null;
}

module.exports = {
  MAX_LEDGER_WINDOW,
  dropsField,
  assertPrepared,
  bindWindow,
  readValidatedAccount,
  hashFound,
};
