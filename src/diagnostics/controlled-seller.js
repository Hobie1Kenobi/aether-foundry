"use strict";

/**
 * Loopback seller for the buyer diagnostic. It issues an exact xrpl:1
 * challenge and reports structural verifier results. It does not settle,
 * does not open an XRPL socket, and does not log a payment header.
 */

const http = require("http");
const xrpl = require("xrpl");
const { ExactXrplScheme } = require("@x402/xrpl/exact/facilitator");
const { assertLoopback } = require("../missions/runtime-guard");
const { challengeAccept, structuralResult } = require("./buyer-diagnostic");

const SANCTIONS_PAYEE = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function startSeller(options) {
  const opts = options || {};
  const host = assertLoopback(opts.host || "127.0.0.1");
  const payTo = opts.payTo || xrpl.Wallet.generate().address;
  if (payTo === SANCTIONS_PAYEE) throw coded("controlled seller cannot use the sanctions payee", "CLAIM");
  const amount = opts.amount || "10";
  if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > 1000000n) throw coded("controlled price is outside the mission cap", "CAP");
  const invoiceId = opts.invoiceId || "diag-controlled-1";
  const scheme = new ExactXrplScheme({});
  const issued = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pay_to: payTo, settles: false }));
      return;
    }
    if (url.pathname !== "/paid") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ settled: false }));
      return;
    }
    const shape = url.searchParams.get("shape") === "official" ? "official" : "vendor";
    const accept = issued.get(shape) || challengeAccept(shape, payTo, shape === "official" ? `${invoiceId}-official` : invoiceId);
    accept.amount = amount;
    issued.set(shape, accept);
    if (req.method === "GET") {
      const body = { x402Version: 2, accepts: [accept] };
      const header = Buffer.from(JSON.stringify(body)).toString("base64");
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
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ settled: false }));
      return;
    }
    const encoded = req.headers["payment-signature"];
    let report = { official_verify: "not_run", official_settle: "not_run", settled: false, invalid_reason: "unparsed" };
    try {
      const parsed = JSON.parse(Buffer.from(String(encoded || ""), "base64").toString("utf8"));
      const blob = parsed && parsed.payload && parsed.payload.signedTxBlob;
      const tx = xrpl.decode(blob);
      const echoed = parsed.accepted;
      const same = JSON.stringify(echoed) === JSON.stringify(accept);
      const structural = structuralResult(scheme, accept, { sign: () => ({ tx_blob: blob }) }, tx, opts.validatedLedger || tx.LastLedgerSequence - 20);
      report = {
        echo_exact: same,
        structural_reason: structural.structural.envelope_reason || structural.structural.structure_reason || structural.structural.expiry_reason,
        official_verify: "not_run",
        official_settle: "not_run",
        settled: false,
      };
    } catch {
      report = { official_verify: "not_run", official_settle: "not_run", settled: false, invalid_reason: "unparsed" };
    }
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(report));
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port || 0, host, () => {
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
  startSeller({ port: Number(process.env.FOUNDRY_DIAGNOSTIC_PORT || 8794) }).then((seller) => {
    process.stdout.write(`${JSON.stringify({ url: seller.url, pay_to: seller.payTo, settles: false })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || "DIAGNOSTIC"}\n`);
    process.exit(1);
  });
}

module.exports = { startSeller, SANCTIONS_PAYEE };
