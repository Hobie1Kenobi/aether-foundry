"use strict";

/**
 * Read-only endpoint for bin/reconcile. This is not the signer websocket
 * list and not the general XRPL host allowlist. Unset stays on XRPL Labs.
 * The only added server is the Honeycluster testnet pair from
 * https://xrpl.org/docs/tutorials/public-servers :
 * JSON-RPC https://testnet.honeycluster.io/ and wss://testnet.honeycluster.io/.
 * The wss form is accepted only as that documented pair and is used as HTTPS
 * JSON-RPC. Mainnet, devnet, http, and any other host are refused.
 */

const { coded } = require("./ledger");

const LABS = "https://testnet.xrpl-labs.com";
const HONEYCLUSTER = "https://testnet.honeycluster.io";
const COMMANDS = new Set(["server_info", "tx", "account_info", "account_tx", "ledger"]);
const MAX_CALLS = 12;

const PAIRS = new Map([
  ["https://testnet.xrpl-labs.com", LABS],
  ["wss://testnet.xrpl-labs.com", LABS],
  ["https://testnet.honeycluster.io", HONEYCLUSTER],
  ["wss://testnet.honeycluster.io", HONEYCLUSTER],
]);

function canonicalReconcileRpc(raw) {
  if (raw == null || String(raw).trim() === "") return LABS;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw coded("reconcile RPC is not a URL", "HOST");
  }
  if (url.username || url.password || url.search || url.hash || url.port) {
    throw coded("reconcile RPC URL is not allowed", "HOST");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw coded("reconcile RPC URL is not allowed", "HOST");
  }
  const key = `${url.protocol}//${url.hostname.toLowerCase()}`;
  const selected = PAIRS.get(key);
  if (!selected) throw coded("reconcile RPC host is not an official testnet archive", "HOST");
  return selected;
}

function boundReconcileFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw coded("validated ledger RPC is not configured", "LEDGER");
  let calls = 0;
  return async (url, init) => {
    calls += 1;
    if (calls > MAX_CALLS) throw coded("reconcile RPC call budget exceeded", "LEDGER");
    if (!init || init.method !== "POST" || typeof init.body !== "string") {
      throw coded("reconcile RPC method is not allowed", "HOST");
    }
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      throw coded("reconcile RPC body is not JSON", "LEDGER");
    }
    if (!COMMANDS.has(body.method)) throw coded("reconcile RPC command is not allowed", "HOST");
    const next = Object.assign({}, init, { signal: AbortSignal.timeout(15000) });
    return fetchImpl(url, next);
  };
}

module.exports = {
  LABS,
  HONEYCLUSTER,
  MAX_CALLS,
  canonicalReconcileRpc,
  boundReconcileFetch,
};
