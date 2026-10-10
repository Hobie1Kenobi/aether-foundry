#!/usr/bin/env node
"use strict";

/**
 * Foreign agent shop. Trial counterparty for W3 outbound x402.
 * Settles to FOREIGN, not W3. Does not sign. Does not submit blobs.
 *
 *   npm run x402:foreign
 */

const http = require("http");
const hosts = require("../../src/xrpl-hosts");
const guard = require("../../src/x402-outbound-guard");
const rules = require("../../web/lib/x402-rules");
const pub = require("./foreign-public");
const verify = require("./verify");

function assertCounterparty() {
  const index = guard.foundryIndex();
  if (index.has(pub.FOREIGN_ADDRESS)) {
    throw new Error("foreign payTo collides with a Foundry wallet");
  }
  guard.assertTestnetUrl(pub.XRPL_HTTP);
  guard.assertTestnetUrl(pub.XRPL_WS);
}

function newInvoiceId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `fx-${pub.SKU.id}-${Date.now().toString(36)}-${rand}`;
}

function buildRequired({ resourceUrl, invoiceId, error }) {
  return {
    x402Version: 2,
    error: error || "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: pub.SKU.description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: pub.NETWORK,
        amount: pub.SKU.drops,
        asset: "XRP",
        payTo: pub.FOREIGN_ADDRESS,
        maxTimeoutSeconds: 600,
        extra: {
          sourceTag: pub.SKU.sourceTag,
          invoiceId,
          paymentFlow: "upfront",
          assetTransferMethod: "sequence",
          diyCostDrops: pub.SKU.diyCostDrops,
          shop: "foreign-agent",
        },
      },
    ],
    extensions: {},
    diyCostDrops: pub.SKU.diyCostDrops,
    diyNote: pub.SKU.diyNote,
  };
}

function howToPay(invoiceId) {
  return {
    network: pub.NETWORK,
    refusedNetwork: pub.MAINNET,
    scheme: "exact",
    asset: "XRP",
    transactionType: "Payment",
    destination: pub.FOREIGN_ADDRESS,
    destinationRole: "FOREIGN agent shop (not Foundry revenue)",
    amountDrops: pub.SKU.drops,
    amountXrp: pub.SKU.xrp,
    sourceTag: pub.SKU.sourceTag,
    invoiceId,
    memo: {
      MemoType: Buffer.from("invoice", "utf8").toString("hex").toUpperCase(),
      MemoData: Buffer.from(invoiceId, "utf8").toString("hex").toUpperCase(),
    },
    invoiceIdSha256: rules.sha256Hex(invoiceId),
    rpc: pub.XRPL_HTTP,
    retryHeader: "PAYMENT-SIGNATURE",
    facilitator: null,
    diyCostDrops: pub.SKU.diyCostDrops,
    tradeoff:
      "This shop verifies a validated Payment on the public Testnet RPC. It does not sign and does not submit signedTxBlob. It is not the Foundry desk and it does not settle to W3.",
  };
}

function catalog() {
  return {
    shop: "foreign-agent",
    foundry_revenue: false,
    network: pub.NETWORK,
    refusedNetwork: pub.MAINNET,
    scheme: "exact",
    asset: "XRP",
    payTo: pub.FOREIGN_ADDRESS,
    payToRole: "FOREIGN counterparty",
    facilitator: null,
    verifier:
      "validated exact Payment on the public XRPL Testnet RPC; signed blobs are not submitted",
    sku: pub.SKU,
  };
}

function rpcUrl() {
  return guard.assertTestnetUrl(hosts.resolveHttp(process.env));
}

async function lookupTxAt(hash, fetchImpl, rpc) {
  const res = await fetchImpl(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "tx",
      params: [{ transaction: hash, binary: false }],
    }),
  });
  if (!res.ok && res.status >= 500) throw new Error(`tx lookup failed: HTTP ${res.status}`);
  const json = await res.json();
  const result = (json && json.result) || {};
  if (result.error === "txnNotFound" || result.error === "txnNotValidated") {
    return { found: false, code: result.error };
  }
  if (result.status === "error" || result.error) {
    return {
      found: false,
      error: result.error_message || result.error || "tx lookup failed",
    };
  }
  return { found: true, tx: result };
}

async function lookupTx(hash, fetchImpl, rpc) {
  return hosts.withFailover(rpc, async (url) => lookupTxAt(hash, fetchImpl, guard.assertTestnetUrl(url)));
}

async function readValidatedLedgerIndexAt(fetchImpl, rpc) {
  const res = await fetchImpl(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "ledger",
      params: [{ ledger_index: "validated" }],
    }),
  });
  if (!res.ok && res.status >= 500) throw new Error(`ledger failed: HTTP ${res.status}`);
  const json = await res.json();
  const index = json && json.result && json.result.ledger_index;
  if (typeof index !== "number") {
    throw new Error("validated ledger_index missing");
  }
  return index;
}

async function readValidatedLedgerIndex(fetchImpl, rpc) {
  return hosts.withFailover(rpc, async (url) => readValidatedLedgerIndexAt(fetchImpl, guard.assertTestnetUrl(url)));
}

function resourceUrlFrom(input) {
  if (input.resourceUrl) return input.resourceUrl;
  const host = input.host || `127.0.0.1:${pub.DEFAULT_PORT}`;
  const parsed = new URL(input.url || pub.SKU.path, "http://localhost");
  return `http://${host}${parsed.pathname}${parsed.search}`;
}

function challengeResult(resourceUrl, opts) {
  const invoiceId = (opts && opts.invoiceId) || newInvoiceId();
  const paymentRequired = buildRequired({
    resourceUrl,
    invoiceId,
    error: opts && opts.error,
  });
  const body = {
    error: (opts && opts.error) || "Payment required",
    code: (opts && opts.code) || "payment_required",
    shop: "foreign-agent",
    foundry_revenue: false,
    x402Version: 2,
    paymentRequired,
    diyCostDrops: pub.SKU.diyCostDrops,
    diyNote: pub.SKU.diyNote,
    howToPay: howToPay(invoiceId),
  };
  if (opts && opts.txHash) body.txHash = opts.txHash;
  return {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": rules.encodeHeader(paymentRequired),
      "Cache-Control": "no-store",
    },
    body,
  };
}

async function handleForeignRequest(input) {
  assertCounterparty();
  const method = String(input.method || "GET").toUpperCase();
  const parsed = new URL(input.url || "/", "http://localhost");
  if (method === "OPTIONS") {
    return { status: 204, headers: {}, body: null };
  }
  if (parsed.pathname === "/" || parsed.pathname === "/catalog") {
    if (method !== "GET" && method !== "POST") {
      return { status: 405, headers: {}, body: { error: "method not allowed" } };
    }
    return { status: 200, headers: {}, body: catalog() };
  }
  if (parsed.pathname !== pub.SKU.path) {
    return {
      status: 404,
      headers: {},
      body: { error: "not found", shop: "foreign-agent" },
    };
  }
  if (method !== "GET" && method !== "POST") {
    return { status: 405, headers: {}, body: { error: "method not allowed" } };
  }
  const requested = parsed.searchParams.get("network");
  if (requested && requested !== pub.NETWORK) {
    return {
      status: 400,
      headers: {},
      body: { error: "foreign shop accepts xrpl:1 only", code: "invalid_network" },
    };
  }
  const headers = input.headers || {};
  const signature =
    headers["payment-signature"] ||
    headers["x-payment"] ||
    headers["PAYMENT-SIGNATURE"] ||
    headers["X-PAYMENT"];
  const resourceUrl = resourceUrlFrom(input);
  if (!signature) return challengeResult(resourceUrl);

  const fetchImpl = input.fetchImpl || globalThis.fetch;
  const rpc = input.rpc || rpcUrl();
  const proof = await verify.verifyForeignPayment({
    header: signature,
    lookupTx: (hash) => (input.lookupTx ? input.lookupTx(hash) : lookupTx(hash, fetchImpl, rpc)),
  });
  if (!proof.ok) {
    const keep =
      proof.code === "payment_not_on_ledger" || proof.code === "payment_not_validated"
        ? proof.invoiceId
        : undefined;
    const response = challengeResult(resourceUrl, {
      error: proof.error,
      code: proof.code,
      invoiceId: keep,
      txHash: proof.txHash,
    });
    response.headers["PAYMENT-RESPONSE"] = rules.encodeHeader({
      success: false,
      transaction: proof.txHash || "",
      network: pub.NETWORK,
      payer: "",
      errorReason: proof.error,
    });
    return response;
  }

  let ledgerIndex;
  try {
    ledgerIndex = input.ledgerIndex
      ? await input.ledgerIndex()
      : await readValidatedLedgerIndex(fetchImpl, rpc);
  } catch (err) {
    return {
      status: 502,
      headers: {
        "PAYMENT-RESPONSE": rules.encodeHeader({
          success: true,
          transaction: proof.hash,
          network: pub.NETWORK,
          payer: proof.payer,
        }),
      },
      body: {
        error: err instanceof Error ? err.message : "ledger read failed",
        paid: true,
        retry_same_proof: true,
        shop: "foreign-agent",
      },
    };
  }

  return {
    status: 200,
    headers: {
      "PAYMENT-RESPONSE": rules.encodeHeader({
        success: true,
        transaction: proof.hash,
        network: pub.NETWORK,
        payer: proof.payer,
      }),
    },
    body: {
      ok: true,
      work: "foreign-oracle-ping",
      ledger_index: ledgerIndex,
      shop: "foreign-agent",
      foundry_revenue: false,
      pay_to: pub.FOREIGN_ADDRESS,
      network: pub.NETWORK,
      payer: proof.payer,
      tx_hash: proof.hash,
      validated_ledger_rpc: rpc,
    },
  };
}

function writeResult(res, result) {
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type",
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    },
    result.headers || {}
  );
  if (result.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  res.writeHead(result.status, headers);
  res.end(JSON.stringify(result.body, null, 2));
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const result = await handleForeignRequest({
        method: req.method,
        url: req.url,
        headers: req.headers,
        host: req.headers.host,
      });
      writeResult(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "foreign shop failed";
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: message, shop: "foreign-agent" }));
    }
  });
}

if (require.main === module) {
  assertCounterparty();
  const port = Number(process.env.PORT || pub.DEFAULT_PORT);
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`foreign agent shop http://${host}:${port}${pub.SKU.path}`);
    console.log("payTo", pub.FOREIGN_ADDRESS);
    console.log("drops", pub.SKU.drops);
    console.log("foundry_revenue", false);
  });
}

module.exports = {
  handleForeignRequest,
  createServer,
  buildRequired,
  catalog,
  assertCounterparty,
  readValidatedLedgerIndex,
  lookupTx,
};
