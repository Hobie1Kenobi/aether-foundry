"use strict";

const config = require("./config");
const policy = require("./policy");

const KNOWN = new Set([
  "source_gateway_called",
  "destination_gateway_approved",
  "destination_executed",
  "express_executed",
  "error",
  "executing",
  "approving",
  "forecalled",
  "forecalled_without_gas_paid",
  "not_executed",
  "not_executed_without_gas_paid",
  "insufficient_fee",
  "unknown_error",
  "cannot_fetch_status",
  "confirmed",
]);

const PENDING = new Set([
  "source_gateway_called",
  "destination_gateway_approved",
  "executing",
  "approving",
  "forecalled",
  "not_executed",
  "confirmed",
]);

const RECOVERY = new Set(["insufficient_fee", "forecalled_without_gas_paid", "not_executed_without_gas_paid"]);

function blank(extra) {
  return Object.assign(
    {
      schema: "aether.axelar-its.status",
      final: false,
      signed: false,
      submitted: false,
      signable: false,
      recovery_action: null,
      funds_at_gateway_possible: false,
    },
    extra
  );
}

function gmpRow(body) {
  if (body == null) return null;
  if (typeof body !== "object") return { unrecognized: true };
  const row = Array.isArray(body.data) ? body.data[0] : body.data && !Array.isArray(body.data) ? body.data : body;
  if (!row || typeof row !== "object") return { empty: true };
  if (Array.isArray(body.data) && body.data.length === 0) return { empty: true };
  const status = typeof row.status === "string" ? row.status.trim() : "";
  const executed = row.executed && typeof row.executed === "object" ? row.executed : null;
  const hash = executed && (executed.transactionHash || executed.txHash || executed.hash);
  return {
    status,
    hash: typeof hash === "string" ? hash.toLowerCase() : null,
    known: KNOWN.has(status),
  };
}

function proofMatches(proof, hash, direction, expect) {
  if (!proof || typeof proof !== "object" || !hash) return false;
  const got = String(proof.tx_hash || "").toLowerCase();
  if (!got || got !== hash.toLowerCase()) return false;
  if (direction === "xrpl-to-evm") {
    return proof.network === "xrpl_evm_testnet" && String(proof.chain_id) === config.EVM_CHAIN_ID && proof.status === "success";
  }
  return (
    proof.network === "xrpl_testnet" &&
    proof.validated === true &&
    proof.result === "tesSUCCESS" &&
    Number(proof.network_id) === config.XRPL_NETWORK_ID &&
    proof.account === config.XRPL_GATEWAY &&
    proof.destination === expect
  );
}

function classify(observation) {
  const obs = observation || {};
  const direction = obs.direction;
  if (direction != null && direction !== "xrpl-to-evm" && direction !== "evm-to-xrpl") {
    return blank({ status: "error", code: "UNSUPPORTED", reason: "direction is not the pinned route" });
  }
  if (obs.network_id != null && Number(obs.network_id) !== config.XRPL_NETWORK_ID) {
    return blank({ status: "error", code: "MAINNET", reason: "refusing a non-testnet network id" });
  }
  if (obs.evm_chain_id != null && String(obs.evm_chain_id) !== config.EVM_CHAIN_ID) {
    return blank({ status: "error", code: "MAINNET", reason: "refusing a non-testnet EVM chain id" });
  }

  const xrpl = obs.xrpl;
  if (xrpl && Number(xrpl.network_id) === 0) {
    return blank({ status: "error", code: "MAINNET", reason: "refusing network id 0" });
  }
  if (xrpl && xrpl.validated === false) {
    return blank({
      status: "pending",
      reason: "source transaction is not validated",
      submitted: true,
    });
  }
  if (xrpl && xrpl.validated === true && xrpl.result && xrpl.result !== "tesSUCCESS") {
    return blank({
      status: "error",
      code: "XRPL",
      reason: xrpl.result,
      submitted: true,
      funds_at_gateway_possible: false,
    });
  }

  const gmp = gmpRow(obs.gmp);
  const sourceOk = Boolean(xrpl && xrpl.validated === true && xrpl.result === "tesSUCCESS" && Number(xrpl.network_id) === 1);
  if (!gmp || gmp.empty || gmp.unrecognized || !gmp.known) {
    if (!xrpl && !obs.gmp) {
      const local = obs.local_status || "planned";
      return blank({
        status: local,
        reason: local === "approved_unsigned" ? "reviewed; signing is still disabled" : "no source transaction has been observed",
        submitted: false,
      });
    }
    return blank({
      status: "uncertain",
      reason: gmp && gmp.empty ? "gmp response was empty" : "gmp status is missing or not a known Axelar status",
      submitted: true,
      funds_at_gateway_possible: sourceOk && direction !== "evm-to-xrpl",
    });
  }

  if (gmp.status === "error") {
    return blank({
      status: "error",
      code: "GMP",
      reason: "destination execution error",
      submitted: true,
      funds_at_gateway_possible: sourceOk,
      recovery_action: "manual_review_not_implemented",
    });
  }
  if (gmp.status === "unknown_error" || gmp.status === "cannot_fetch_status") {
    return blank({
      status: "uncertain",
      reason: gmp.status,
      submitted: true,
      funds_at_gateway_possible: sourceOk,
    });
  }
  if (RECOVERY.has(gmp.status)) {
    return blank({
      status: "recovery",
      reason: gmp.status,
      submitted: true,
      funds_at_gateway_possible: sourceOk || direction === "xrpl-to-evm",
      recovery_action: "manual_add_gas_not_implemented",
    });
  }
  if (gmp.status === "destination_executed" || gmp.status === "express_executed") {
    const proven = proofMatches(obs.destination_proof, gmp.hash, direction || "xrpl-to-evm", obs.expected_xrpl_destination);
    if (!proven) {
      return blank({
        status: "uncertain",
        reason: "gmp reports execution without a matching destination proof",
        submitted: true,
        funds_at_gateway_possible: sourceOk,
      });
    }
    return blank({
      status: "final",
      final: true,
      reason: gmp.status,
      submitted: true,
      funds_at_gateway_possible: false,
    });
  }
  if (PENDING.has(gmp.status)) {
    return blank({
      status: "pending",
      reason: gmp.status,
      submitted: true,
      funds_at_gateway_possible: sourceOk,
    });
  }
  return blank({
    status: "uncertain",
    reason: "settlement did not match a known terminal state",
    submitted: Boolean(xrpl || obs.gmp),
    funds_at_gateway_possible: sourceOk,
  });
}

function assertFetchUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw policy.coded("refusing unparseable status url", "MAINNET");
  }
  const origin = `${url.protocol}//${url.host}`;
  const allowed = [config.XRPL_HTTP, config.EVM_RPC, config.GMP_API];
  if (!allowed.includes(origin) && !allowed.includes(origin.replace(/\/$/, ""))) {
    throw policy.coded(`refusing status host ${url.host}`, "MAINNET");
  }
  if (url.protocol !== "https:") throw policy.coded("refusing non-https status url", "MAINNET");
  return url;
}

async function fetchStatus(query, deps) {
  const fetchImpl = deps && deps.fetch;
  if (typeof fetchImpl !== "function") throw policy.coded("status fetch has no transport", "RPC");
  const hash = String(query && query.hash ? query.hash : "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) throw policy.coded("status hash must be 64 hex", "HASH");
  const xrplUrl = assertFetchUrl(config.XRPL_HTTP);
  const evmUrl = assertFetchUrl(config.EVM_RPC);
  const gmpUrl = assertFetchUrl(`${config.GMP_API}/gmp/searchGMP?txHash=${hash.replace(/^0x/i, "")}`);
  const chainBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  const chainRes = await fetchImpl(evmUrl.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chainBody,
  });
  const chainJson = await chainRes.json();
  const chainId = chainJson && chainJson.result;
  if (String(chainId).toLowerCase() !== config.EVM_CHAIN_ID_HEX) {
    throw policy.coded(`refusing EVM chain id ${chainId}`, "MAINNET");
  }
  const xrplBody = JSON.stringify({
    method: "tx",
    params: [{ transaction: hash.replace(/^0x/i, "").toUpperCase(), binary: false }],
  });
  const xrplRes = await fetchImpl(xrplUrl.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: xrplBody,
  });
  const gmpRes = await fetchImpl(gmpUrl.toString(), { method: "GET" });
  return {
    xrpl_http: xrplUrl.toString(),
    evm_rpc: evmUrl.toString(),
    gmp_api: gmpUrl.toString(),
    xrpl: await xrplRes.json(),
    gmp: await gmpRes.json(),
    evm_chain_id: config.EVM_CHAIN_ID,
    fetched: true,
    signed: false,
    submitted: false,
  };
}

module.exports = {
  KNOWN,
  classify,
  assertFetchUrl,
  fetchStatus,
};
