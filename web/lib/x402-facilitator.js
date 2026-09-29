"use strict";

/**
 * Dual-mode x402 for the desk.
 * Self-verify reads a validated Testnet Payment.
 * Facilitator mode also accepts a T54 receipt, and may POST /verify.
 * The desk never settles and never calls a mainnet facilitator.
 */

const rules = require("./x402-rules");

const TESTNET_ORIGIN = "https://xrpl-facilitator-testnet.t54.ai";
const TESTNET_HOST = "xrpl-facilitator-testnet.t54.ai";
const NETWORK = "xrpl:1";
const NETWORK_ID = 1;
const VERIFY_PATH = "/verify";

const LABELED = [
  "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
  "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
  "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
  "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
  "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w",
  "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth",
  "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
];

function fail(code, error, extra) {
  return Object.assign({ ok: false, code, error }, extra || {});
}

function parseFacilitatorUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return fail("invalid_facilitator", "facilitator URL is not a URL");
  }
  if (url.username || url.password) {
    return fail("invalid_facilitator", "facilitator URL must not carry credentials");
  }
  if (url.protocol !== "https:") {
    return fail("invalid_facilitator", "facilitator URL must be https");
  }
  if (url.port && url.port !== "443") {
    return fail("invalid_facilitator", "facilitator URL must use port 443");
  }
  const host = url.hostname.toLowerCase();
  if (host !== TESTNET_HOST) {
    return fail(
      "invalid_facilitator",
      "facilitator host must be xrpl-facilitator-testnet.t54.ai"
    );
  }
  if (url.pathname && url.pathname !== "/") {
    return fail("invalid_facilitator", "facilitator URL must not include a path");
  }
  if (url.search || url.hash) {
    return fail("invalid_facilitator", "facilitator URL must not include a query or hash");
  }
  return { ok: true, host: TESTNET_HOST, origin: TESTNET_ORIGIN };
}

function facilitatorEnv(source) {
  const env = source || {};
  const url = env.XRPL_FACILITATOR_URL;
  const network = env.XRPL_NETWORK;
  return {
    XRPL_FACILITATOR_URL: url == null ? undefined : String(url),
    XRPL_NETWORK: network == null ? undefined : String(network),
  };
}

function resolveFacilitator(env) {
  const source = facilitatorEnv(env);
  const network = source.XRPL_NETWORK;
  if (network != null && String(network).trim() !== "") {
    const name = String(network).trim();
    if (name === "xrpl:0" || name === "xrpl-mainnet" || name === "0") {
      return fail("invalid_network", "XRPL_NETWORK must be xrpl:1");
    }
    if (name !== NETWORK) {
      return fail("invalid_network", "XRPL_NETWORK must be xrpl:1");
    }
  }
  const raw = source.XRPL_FACILITATOR_URL;
  if (raw == null || String(raw).trim() === "") {
    return {
      ok: true,
      mode: "self-verify",
      host: null,
      url: null,
      network: NETWORK,
      networkId: NETWORK_ID,
    };
  }
  const parsed = parseFacilitatorUrl(raw);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    mode: "dual",
    host: parsed.host,
    url: parsed.origin,
    network: NETWORK,
    networkId: NETWORK_ID,
  };
}

function publicFacilitator(env) {
  const resolved = resolveFacilitator(env);
  const base = {
    network: NETWORK,
    networkId: NETWORK_ID,
    advertised: TESTNET_ORIGIN,
    settles: false,
    verifyOnly: true,
    remoteVerify: false,
  };
  if (!resolved.ok) {
    return Object.assign({}, base, {
      mode: "refused",
      host: null,
      url: null,
      code: resolved.code,
      error: resolved.error,
    });
  }
  return Object.assign({}, base, {
    mode: resolved.mode,
    host: resolved.host,
    url: resolved.url,
    remoteVerify: resolved.mode === "dual",
  });
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function extractReceipt(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  const payload = asObject(decoded.payload) || {};
  const extensions = asObject(decoded.extensions) || {};
  const fromExtension = asObject(extensions.facilitator);
  const receipt =
    asObject(payload.facilitatorReceipt) ||
    asObject(payload.facilitator_receipt) ||
    asObject(decoded.facilitatorReceipt) ||
    asObject(extensions.facilitatorReceipt) ||
    (fromExtension ? asObject(fromExtension.receipt) : null);
  if (!receipt) return null;
  const facilitator =
    typeof receipt.facilitator === "string"
      ? receipt.facilitator
      : receipt.facilitator && typeof receipt.facilitator.url === "string"
        ? receipt.facilitator.url
        : fromExtension && typeof fromExtension.url === "string"
          ? fromExtension.url
          : null;
  return {
    success: receipt.success,
    transaction: receipt.transaction || receipt.txHash || receipt.hash || null,
    network: receipt.network,
    networkId: receipt.networkId != null ? receipt.networkId : receipt.NetworkID,
    payer: typeof receipt.payer === "string" ? receipt.payer : "",
    facilitator,
  };
}

function gateReceipt(receipt) {
  if (!receipt) return { ok: true };
  if (receipt.success === false) {
    return fail("facilitator_rejected", "facilitator receipt success is false");
  }
  if (receipt.network === "xrpl:0" || receipt.network === "xrpl-mainnet") {
    return fail("invalid_network", "facilitator receipt network xrpl:0 is refused");
  }
  if (receipt.network != null && receipt.network !== NETWORK) {
    return fail("invalid_network", "facilitator receipt network must be xrpl:1");
  }
  if (receipt.networkId != null && Number(receipt.networkId) !== NETWORK_ID) {
    return fail("invalid_network", "facilitator receipt network id must be 1");
  }
  const hash = String(receipt.transaction || "").trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) {
    return fail("invalid_payload", "facilitator receipt needs a 64-hex transaction");
  }
  if (receipt.facilitator) {
    const parsed = parseFacilitatorUrl(receipt.facilitator);
    if (!parsed.ok) return parsed;
  }
  return { ok: true, txHash: hash, payer: receipt.payer };
}

function headerWithReceiptHash(decoded, txHash) {
  const payload = Object.assign({}, asObject(decoded.payload) || {});
  const existing = String(payload.transaction || payload.txHash || payload.hash || "")
    .trim()
    .toUpperCase();
  if (existing && existing !== txHash) {
    return fail("payment_requirements_mismatch", "receipt transaction does not match payload.transaction");
  }
  payload.transaction = txHash;
  return {
    ok: true,
    header: rules.encodeHeader(Object.assign({}, decoded, { payload })),
  };
}

function verifyEndpoint(origin) {
  const parsed = parseFacilitatorUrl(origin);
  if (!parsed.ok) return parsed;
  const endpoint = new URL(VERIFY_PATH, parsed.origin);
  if (endpoint.origin !== TESTNET_ORIGIN || endpoint.pathname !== VERIFY_PATH) {
    return fail("invalid_facilitator", "refusing to call a non-testnet facilitator");
  }
  return { ok: true, url: endpoint.toString() };
}

async function readOnlyVerify({ origin, paymentPayload, paymentRequirements, fetchImpl }) {
  const endpoint = verifyEndpoint(origin);
  if (!endpoint.ok) return endpoint;
  if (typeof fetchImpl !== "function") {
    return fail("facilitator_unreachable", "facilitator verify fetch is missing");
  }
  let response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
    });
  } catch (err) {
    return fail(
      "facilitator_unreachable",
      err instanceof Error ? err.message : "facilitator /verify failed"
    );
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.isValid !== true) {
    const reason =
      (body && (body.invalidReason || body.error || body.detail)) || "facilitator /verify rejected the payload";
    const text = typeof reason === "string" ? reason : "facilitator /verify rejected the payload";
    return fail("facilitator_rejected", text);
  }
  return { ok: true, payer: typeof body.payer === "string" ? body.payer : "" };
}

async function verifyDeskPayment({ header, sku, lookupTx, hashSignedTx, env, fetchImpl }) {
  const configured = resolveFacilitator(env || {});
  if (!configured.ok) return configured;

  let decoded = null;
  try {
    decoded = rules.decodeHeader(header);
  } catch {
    decoded = null;
  }
  const receipt = extractReceipt(decoded);
  let proofHeader = header;
  if (receipt) {
    const gated = gateReceipt(receipt);
    if (!gated.ok) return gated;
    const rebound = headerWithReceiptHash(decoded, gated.txHash);
    if (!rebound.ok) return rebound;
    proofHeader = rebound.header;
  }

  const proof = await rules.verifyPaymentProof({
    header: proofHeader,
    sku,
    lookupTx,
    hashSignedTx,
  });
  if (proof.ok) {
    if (receipt && receipt.payer && proof.payer !== receipt.payer) {
      return fail("payer_mismatch", "facilitator receipt payer does not match the settled Account", {
        txHash: proof.hash,
        invoiceId: proof.invoiceId,
      });
    }
    return Object.assign({}, proof, {
      via: receipt && configured.mode === "dual" ? "facilitator-receipt" : "self-verify",
    });
  }

  const payload = decoded && asObject(decoded.payload);
  const blob = payload && typeof payload.signedTxBlob === "string" ? payload.signedTxBlob.trim() : "";
  if (configured.mode === "dual" && proof.code === "payment_not_on_ledger" && blob) {
    const remote = await readOnlyVerify({
      origin: configured.url,
      paymentPayload: decoded,
      paymentRequirements: decoded.accepted,
      fetchImpl,
    });
    if (!remote.ok) {
      return Object.assign(remote, {
        txHash: proof.txHash,
        invoiceId: proof.invoiceId,
      });
    }
    return Object.assign({}, proof, {
      facilitatorVerified: true,
      via: "facilitator-verify",
      error:
        "Facilitator /verify accepted the signed blob. This desk does not settle. Submit the Payment, or settle it on the testnet facilitator, then retry with the validated transaction hash.",
    });
  }

  return Object.assign({}, proof, { via: "self-verify" });
}

function countForeignX402Hits(text, labeled) {
  const wallets = new Set(labeled && labeled.length ? labeled : LABELED);
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.action !== "x402_hit" || !row.hash || !row.payer) continue;
    if (row.network === "xrpl:0") continue;
    if (wallets.has(row.payer)) continue;
    seen.add(`${row.sku || ""}:${String(row.hash).toUpperCase()}`);
  }
  return seen.size;
}

module.exports = {
  TESTNET_ORIGIN,
  TESTNET_HOST,
  NETWORK,
  NETWORK_ID,
  VERIFY_PATH,
  LABELED,
  parseFacilitatorUrl,
  facilitatorEnv,
  resolveFacilitator,
  publicFacilitator,
  extractReceipt,
  gateReceipt,
  verifyEndpoint,
  readOnlyVerify,
  verifyDeskPayment,
  countForeignX402Hits,
};
