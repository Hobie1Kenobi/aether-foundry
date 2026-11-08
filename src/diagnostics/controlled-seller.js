"use strict";

/**
 * Loopback seller for one diagnostic payment.
 * The payee is the funded address the operator names. This process does not
 * generate a wallet. Port 8794 is the mission worker and is refused.
 * A vendor-shaped challenge is rejected before settle. The official shape
 * is verified and settled, then answered with a receipt that has no blob.
 */

const http = require("http");
const xrpl = require("xrpl");
const { ExactXrplScheme } = require("@x402/xrpl/exact/facilitator");
const { assertLoopback } = require("../missions/runtime-guard");
const { boundedSellerReason, publicFacilitatorDetail } = require("../missions/service-result");
const { challengeAccept } = require("./buyer-diagnostic");

const TESTNET_WS = "wss://s.altnet.rippletest.net:51233";
const SELLER_TIMEOUT_MS = 15000;

const SANCTIONS_PAYEE = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const DIAGNOSTIC_PORT = 8795;
const BLOCKED_PORTS = new Set([8787, 8788, 8792, 8793, 8794]);

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertDiagnosticPort(raw) {
  if (raw === 0 || raw === "0") return 0;
  const port = Number(raw == null || raw === "" ? DIAGNOSTIC_PORT : raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw coded("refusing port", "BIND");
  if (BLOCKED_PORTS.has(port)) throw coded(`refusing port ${port} because an existing service owns it`, "BIND");
  return port;
}

function officialScheme() {
  return new ExactXrplScheme({
    clientFactory(url) {
      if (url !== TESTNET_WS) {
        const error = new Error("refusing an unapproved XRPL socket");
        error.code = "HOST";
        throw error;
      }
      return new xrpl.Client(url, { timeout: 8000, connectionTimeout: 5000 });
    },
  });
}

function publicReason(value, fallback) {
  return boundedSellerReason(value) || fallback;
}

function withTimeout(work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("timeout");
      error.code = "SELLER_TIMEOUT";
      reject(error);
    }, ms);
    work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function challengesFor(payTo, amount, invoiceId) {
  const vendor = challengeAccept("vendor", payTo, invoiceId);
  const official = challengeAccept("official", payTo, `${invoiceId}-official`);
  vendor.amount = amount;
  official.amount = amount;
  return { vendor, official };
}

async function fulfill(parsed, challenges, scheme, boundary) {
  const echoed = parsed && parsed.accepted;
  const vendor = JSON.stringify(echoed) === JSON.stringify(challenges.vendor);
  const official = JSON.stringify(echoed) === JSON.stringify(challenges.official);
  const missingFlag = !echoed || !echoed.extra || !Object.prototype.hasOwnProperty.call(echoed.extra, "areFeesSponsored");
  if (vendor || missingFlag || !official) {
    return {
      status: 402,
      body: {
        settled: false,
        paid: false,
        invalid_reason: vendor || missingFlag ? "invalid_exact_xrpl_fees_sponsored_unsupported" : "payment_requirements_mismatch",
        official_verify: "not_run",
        official_settle: "not_run",
      },
    };
  }
  if (!scheme || typeof scheme.verify !== "function" || typeof scheme.settle !== "function") {
    return { status: 402, body: { settled: false, paid: false, invalid_reason: "seller_verify_failed", official_settle: "not_run" } };
  }
  const verified = await scheme.verify(parsed, challenges.official);
  if (!verified || verified.isValid !== true) {
    return {
      status: 402,
      body: {
        settled: false,
        paid: false,
        invalid_reason: publicReason(verified && verified.invalidReason, "seller_verify_failed"),
        error_reason: publicFacilitatorDetail(verified && verified.invalidReason),
        error_message: publicFacilitatorDetail(verified && verified.invalidMessage),
        official_verify: "rejected",
        official_settle: "not_run",
      },
    };
  }
  const settled = await scheme.settle(parsed, challenges.official);
  if (!settled || settled.success !== true || typeof settled.transaction !== "string" || settled.transaction.length === 0) {
    return {
      status: 402,
      body: {
        settled: false,
        paid: false,
        invalid_reason: publicReason(settled && settled.errorReason, "seller_verify_failed"),
        error_reason: publicFacilitatorDetail(settled && settled.errorReason),
        error_message: publicFacilitatorDetail(settled && settled.errorMessage),
        official_settle: "not_proven",
      },
    };
  }
  return {
    status: 200,
    body: {
      paid: true,
      settled: true,
      transaction: settled.transaction.toUpperCase(),
      network: "xrpl:1",
      payer: settled.payer || verified.payer || null,
      network_boundary: boundary,
      official_settle: boundary === "testnet" ? "exact_xrpl_scheme" : boundary,
    },
  };
}

function startSeller(options) {
  const opts = options || {};
  const host = assertLoopback(opts.host || "127.0.0.1");
  const port = assertDiagnosticPort(opts.port == null ? 0 : opts.port);
  const payTo = opts.payTo;
  if (typeof payTo !== "string" || payTo.length === 0) throw coded("controlled seller payee is missing", "PAYEE");
  if (payTo === SANCTIONS_PAYEE) throw coded("controlled seller cannot use the sanctions payee", "CLAIM");
  const amount = opts.amount || "10";
  if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > 1000000n) throw coded("controlled price is outside the mission cap", "CAP");
  const challenges = challengesFor(payTo, amount, opts.invoiceId || "diag-controlled-1");
  const scheme = opts.scheme || officialScheme();
  const boundary = opts.boundary || (opts.scheme ? "supplied_scheme" : "testnet");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, pay_to: payTo, port, settles: true });
      return;
    }
    if (url.pathname !== "/paid") {
      send(res, 404, { settled: false });
      return;
    }
    const shape = url.searchParams.get("shape") === "official" ? "official" : "vendor";
    if (req.method === "GET") {
      const accept = challenges[shape];
      const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
      res.writeHead(402, { "content-type": "application/json", "payment-required": header });
      res.end(JSON.stringify({
        error: "payment_required",
        shape,
        are_fees_sponsored_present: Object.prototype.hasOwnProperty.call(accept.extra, "areFeesSponsored"),
        settled: false,
      }));
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { settled: false });
      return;
    }
    req.resume();
    req.on("end", () => {
      let parsed = null;
      try {
        const encoded = req.headers["payment-signature"];
        parsed = JSON.parse(Buffer.from(String(encoded || ""), "base64").toString("utf8"));
      } catch {
        send(res, 402, { settled: false, paid: false, invalid_reason: "unparsed", official_settle: "not_run" });
        return;
      }
      withTimeout(fulfill(parsed, challenges, scheme, boundary), SELLER_TIMEOUT_MS).then((result) => {
        const text = JSON.stringify(result.body);
        if (text.includes("signedTxBlob") || text.includes("PAYMENT-SIGNATURE") || /sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text)) {
          send(res, 402, { settled: false, invalid_reason: "unparsed" });
          return;
        }
        send(res, result.status, result.body);
      }).catch((error) => {
        const timedOut = error && error.code === "SELLER_TIMEOUT";
        send(res, 402, {
          settled: false,
          paid: false,
          invalid_reason: timedOut ? "seller_timeout" : "seller_verify_failed",
          official_settle: "not_run",
        });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host,
        port: address.port,
        payTo,
        url: `http://${host}:${address.port}/paid`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (require.main === module) {
  try {
    const sellerPort = assertDiagnosticPort(process.env.FOUNDRY_DIAGNOSTIC_PORT || DIAGNOSTIC_PORT);
    startSeller({ payTo: process.env.FOUNDRY_DIAGNOSTIC_PAYEE, port: sellerPort }).then((seller) => {
      process.stdout.write(`${JSON.stringify({ url: seller.url, pay_to: seller.payTo, port: seller.port })}\n`);
    }).catch((error) => {
      process.stderr.write(`${error.code || "DIAGNOSTIC"}\n`);
      process.exit(1);
    });
  } catch (error) {
    process.stderr.write(`${error.code || "DIAGNOSTIC"}\n`);
    process.exit(1);
  }
}

module.exports = {
  SANCTIONS_PAYEE,
  DIAGNOSTIC_PORT,
  BLOCKED_PORTS,
  TESTNET_WS,
  assertDiagnosticPort,
  officialScheme,
  startSeller,
  fulfill,
};
