"use strict";

/**
 * W3 outbound x402. Wraps the outbound guard. Refuses W3 payTo, mainnet, and a missing 402.
 * Cap 500000 drops. Signer is W3_REGULAR_SEED, not W3_SEED.
 */

const path = require("path");
const anchors = require("../../director/anchors");
const guard = require("../../x402-outbound-guard");
const record = require("../../x402-outbound-record");
const policy = require("../policy");

function historyFile(root) {
  return path.join(root, "lab", "ledger-log.jsonl");
}

function urlFromActions(nextActions) {
  for (const line of nextActions || []) {
    const match = String(line).match(/https?:\/\/[^\s)]+/);
    if (match && policy.namesOutbound([line])) return match[0];
  }
  return "";
}

async function loadInvoice(opts) {
  if (opts.required) return { required: opts.required, resourceUrl: opts.resourceUrl || "" };
  const resourceUrl = opts.resourceUrl || urlFromActions(opts.state && opts.state.next_actions);
  if (!resourceUrl) return { required: null, resourceUrl: "" };
  policy.assertAltnet({ url: resourceUrl, signing: false });
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(resourceUrl);
  const header = response.headers && response.headers.get ? response.headers.get("payment-required") : "";
  const bodyText = await response.text();
  if (response.status !== 402 || !header) {
    return { required: null, resourceUrl, status: response.status };
  }
  return {
    required: guard.parsePaymentRequired(header, bodyText),
    resourceUrl,
    status: 402,
    bodyText,
  };
}

function planFromInvoice(opts, invoice) {
  if (!policy.namesOutbound(opts.state && opts.state.next_actions) && !opts.required && !opts.force) {
    return policy.decision("x402_outbound", { code: "NOT_NAMED", message: "director next_actions do not name outbound" });
  }
  const now = opts.now || new Date();
  const rows = opts.history || (opts.root ? policy.readJsonl(historyFile(opts.root), opts.io) : []);
  if (policy.paidOnUtcDay(rows, "x402_outbound", now)) {
    return policy.decision("x402_outbound", { code: "NOT_DUE", message: "an x402_outbound row already exists for this UTC day" });
  }
  if (!invoice || !invoice.required) {
    return policy.decision("x402_outbound", { code: "MISSING_402", message: "refusing outbound without a 402 invoice" });
  }
  let accept;
  try {
    accept = guard.selectAccept(invoice.required);
    policy.assertOutbound({
      payTo: accept.payTo,
      drops: accept.amount,
      network: accept.network,
      has402: true,
      index: opts.index,
      rpc: anchors.XRPL_WS,
    });
  } catch (error) {
    return policy.fromError("x402_outbound", error);
  }
  const tx = guard.buildPaymentTx({ account: anchors.WALLETS.W3.address, accept });
  try {
    policy.assertSigningTx(tx, opts.state);
  } catch (error) {
    return policy.fromError("x402_outbound", error);
  }
  return policy.decision("x402_outbound", {
    allow: true,
    code: "DUE",
    message: `unsigned outbound ${accept.amount} drops to ${accept.payTo}`,
    tx,
    payTo: accept.payTo,
    resourceUrl: invoice.resourceUrl || null,
    accept,
    required: invoice.required,
  });
}

async function plan(opts) {
  const options = opts || {};
  const now = options.now || new Date();
  if (!options.state || policy.isStale(options.state, now)) {
    return policy.decision("x402_outbound", { code: "STALE", message: "refusing to sign on stale director state" });
  }
  if (options.live) {
    try {
      policy.assertLiveGate(options.env);
    } catch (error) {
      return policy.fromError("x402_outbound", error);
    }
  }
  if (!policy.namesOutbound(options.state.next_actions) && !options.required && !options.force) {
    return policy.decision("x402_outbound", { code: "NOT_NAMED", message: "director next_actions do not name outbound" });
  }
  try {
    const invoice = await loadInvoice(options);
    const draft = planFromInvoice(options, invoice);
    if (draft.required) {
      return policy.decision("x402_outbound", {
        allow: draft.allow,
        code: draft.code,
        message: draft.message,
        tx: draft.tx,
        payTo: draft.payTo,
        resourceUrl: draft.resourceUrl,
      });
    }
    return draft;
  } catch (error) {
    return policy.fromError("x402_outbound", error);
  }
}

async function execute(opts) {
  const options = opts || {};
  policy.assertLiveGate(options.env);
  const invoice = await loadInvoice(options);
  const draft = planFromInvoice(Object.assign({}, options, { force: true }), invoice);
  if (!draft.allow || !draft.tx) throw policy.coded(draft.message || "outbound refused", draft.code || "REFUSED");
  const regular = policy.regularKey(options.state, "W3");
  const submitted = await options.submit(draft.tx, "W3_REGULAR_SEED", regular);
  if (!submitted || submitted.result !== "tesSUCCESS" || !submitted.hash) {
    throw policy.coded("outbound payment did not succeed", "SUBMIT");
  }
  const payload = guard.buildSignaturePayload({
    required: draft.required,
    accept: draft.accept,
    txBlob: submitted.tx_blob,
    hash: submitted.hash,
  });
  const signature = guard.encodeHeader(payload);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let status = 0;
  if (draft.resourceUrl) {
    const retry = await fetchImpl(draft.resourceUrl, {
      headers: { Accept: "application/json", "PAYMENT-SIGNATURE": signature },
    });
    status = retry.status;
  }
  const row = {
    ts: new Date().toISOString(),
    action: "x402_outbound",
    network: "xrpl:1",
    resource_url: draft.resourceUrl,
    pay_to: draft.payTo,
    payer: anchors.WALLETS.W3.address,
    amount_drops: draft.tx.Amount,
    hash: submitted.hash,
    result: "tesSUCCESS",
    ledger_index: submitted.ledger_index == null ? null : submitted.ledger_index,
    http_status: status,
  };
  if (options.archive) options.archive(row);
  if (status === 200) {
    record.recordOutbound(row);
  }
  return { hash: submitted.hash, result: "tesSUCCESS", http_status: status, payTo: draft.payTo };
}

module.exports = { plan, execute, planFromInvoice, urlFromActions };
