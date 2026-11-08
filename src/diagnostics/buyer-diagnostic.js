"use strict";

/**
 * Offline diagnostic for the Foundry buyer construction path.
 * It uses buildSignaturePayload and the mission invoice hash. It does not
 * submit, does not read a seed file, and does not call the seller.
 * @x402/xrpl 2.30.0 rejects a challenge that omits areFeesSponsored.
 * This tool reports that result. It does not add the field.
 */

const path = require("path");
const fs = require("fs");
const xrpl = require("xrpl");
const { ExactXrplScheme } = require("@x402/xrpl/exact/facilitator");
const { buildSignaturePayload } = require("../x402-outbound-guard");
const { invoiceIdField } = require("../missions/x402-deliver");

function packageVersion(resolvedFile, name) {
  let dir = path.dirname(resolvedFile);
  for (let i = 0; i < 8; i += 1) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg.name === name) return pkg.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`version missing for ${name}`);
}

const X402_VERSION = packageVersion(require.resolve("@x402/xrpl/exact/facilitator"), "@x402/xrpl");
const XRPL_VERSION = packageVersion(require.resolve("xrpl"), "xrpl");
const HOSTED_SUPPORTED = "https://xrpl-facilitator-testnet.t54.ai/supported";
const MAX_FEE = 10000;
const LEDGER_SPAN = 20;

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function challengeAccept(shape, payTo, invoiceId) {
  const extra = { invoiceId, sourceTag: 7 };
  if (shape === "official") extra.areFeesSponsored = false;
  else if (shape !== "vendor") throw coded("diagnostic challenge shape is not supported", "TX");
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: "XRP",
    amount: "10",
    payTo,
    maxTimeoutSeconds: 600,
    extra,
  };
}

function buildFoundryBuyerTx(input) {
  const accept = input && input.accept;
  if (!accept || accept.scheme !== "exact" || accept.network !== "xrpl:1" || accept.asset !== "XRP") {
    throw coded("diagnostic buyer is xrpl:1 exact XRP only", "MAINNET");
  }
  const amount = String(accept.amount || "");
  if (!/^[1-9][0-9]*$/.test(amount)) throw coded("diagnostic amount is not drops", "TX");
  const fee = input.fee == null ? 10 : input.fee;
  if (!Number.isSafeInteger(fee) || fee < 1 || fee > MAX_FEE) throw coded("diagnostic fee is outside the local bound", "FEE_CAP");
  const validated = input.validatedLedger;
  const sequence = input.sequence;
  if (!Number.isSafeInteger(validated) || validated <= 0) throw coded("validated ledger is missing", "LEDGER");
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw coded("validated account sequence is missing", "TX");
  const tag = Number(accept.extra && accept.extra.sourceTag);
  if (!Number.isInteger(tag) || tag < 0 || tag > 4294967295) throw coded("sourceTag is not a uint32", "TX");
  const invoiceId = accept.extra && accept.extra.invoiceId;
  if (typeof invoiceId !== "string" || invoiceId.length < 4) throw coded("invoiceId is missing", "TX");
  return {
    TransactionType: "Payment",
    Account: input.account,
    Destination: accept.payTo,
    Amount: amount,
    Fee: String(fee),
    Sequence: sequence,
    LastLedgerSequence: validated + LEDGER_SPAN,
    SourceTag: tag,
    InvoiceID: invoiceIdField(invoiceId),
  };
}

function publicTxFields(tx, accept) {
  return {
    transaction_type: tx.TransactionType,
    network_id_omitted: !Object.prototype.hasOwnProperty.call(tx, "NetworkID"),
    memos_omitted: !Object.prototype.hasOwnProperty.call(tx, "Memos"),
    amount: tx.Amount,
    amount_matches: tx.Amount === String(accept.amount),
    destination_matches: tx.Destination === accept.payTo,
    fee: tx.Fee,
    sequence: tx.Sequence,
    last_ledger_sequence: tx.LastLedgerSequence,
    source_tag: tx.SourceTag,
    invoice_id_matches_sha256: tx.InvoiceID === invoiceIdField(accept.extra.invoiceId),
  };
}

function echoAccepted(accept, txBlob) {
  const before = JSON.stringify(accept);
  const payload = buildSignaturePayload({
    required: { resource: { url: "https://diagnostic.invalid/offline" } },
    accept,
    txBlob,
  });
  const injected = Object.prototype.hasOwnProperty.call(accept.extra || {}, "areFeesSponsored")
    ? false
    : Object.prototype.hasOwnProperty.call(payload.accepted.extra || {}, "areFeesSponsored");
  return {
    payload,
    echo_exact: JSON.stringify(payload.accepted) === before && JSON.stringify(accept) === before,
    are_fees_sponsored_injected: injected,
  };
}

function localScheme(validated, sequence) {
  return new ExactXrplScheme({
    getCurrentLedgerIndex: async () => validated,
    getAccountSequence: async () => sequence,
    getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
    simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
  });
}

function settlementOnce(store, invoiceId, verifierResult) {
  if (!verifierResult || verifierResult.isValid !== true) {
    return { settled: false, replay: false, reason: (verifierResult && verifierResult.invalidReason) || "not_valid" };
  }
  if (store.has(invoiceId)) return { settled: false, replay: true, reason: "replay" };
  store.add(invoiceId);
  return { settled: true, replay: false, reason: null };
}

function assertPublicReport(report) {
  const text = JSON.stringify(report);
  if (/sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(text) || text.includes("signedTxBlob") || text.includes("PAYMENT-SIGNATURE") || text.includes("tx_blob")) {
    throw coded("diagnostic report contains a signed blob or secret", "REDACT");
  }
  return report;
}

async function verifySigned(scheme, accept, wallet, tx, store) {
  const signed = wallet.sign(tx);
  const echoed = echoAccepted(accept, signed.tx_blob);
  const verified = await scheme.verify(echoed.payload, accept);
  return {
    echo_exact: echoed.echo_exact,
    are_fees_sponsored_injected: echoed.are_fees_sponsored_injected,
    tx: publicTxFields(tx, accept),
    local_verifier: {
      tool: "@x402/xrpl",
      version: X402_VERSION,
      is_valid: verified.isValid === true,
      invalid_reason: verified.isValid === true ? null : (verified.invalidReason || "unknown"),
    },
    settlement: settlementOnce(store, accept.extra.invoiceId, verified),
  };
}

async function diagnoseOffline(options) {
  const opts = options || {};
  const wallet = opts.wallet || xrpl.Wallet.generate();
  const payTo = opts.payTo || xrpl.Wallet.generate().address;
  const invoiceId = opts.invoiceId || "diag-offline-1";
  const validated = opts.validatedLedger == null ? 10000 : opts.validatedLedger;
  const sequence = opts.sequence == null ? 10 : opts.sequence;
  const store = opts.store || new Set();
  const scheme = opts.scheme || localScheme(validated, sequence);
  const vendorAccept = challengeAccept("vendor", payTo, invoiceId);
  const officialAccept = challengeAccept("official", payTo, `${invoiceId}-official`);
  const vendorTx = buildFoundryBuyerTx({ accept: vendorAccept, account: wallet.address, validatedLedger: validated, sequence });
  const officialTx = buildFoundryBuyerTx({ accept: officialAccept, account: wallet.address, validatedLedger: validated, sequence });
  const vendor = Object.assign({ shape: "vendor_missing_areFeesSponsored", payer_address: wallet.address }, await verifySigned(scheme, vendorAccept, wallet, vendorTx, store));
  const otherPayee = xrpl.Wallet.generate().address;
  const faults = [];
  const fault = async (name, mutate) => {
    const tx = Object.assign({}, officialTx);
    mutate(tx);
    const row = await verifySigned(scheme, officialAccept, wallet, tx, store);
    faults.push(Object.assign({ shape: name, payer_address: wallet.address, builder: false }, row));
  };
  await fault("amount_mismatch", (tx) => { tx.Amount = "11"; });
  await fault("destination_mismatch", (tx) => { tx.Destination = otherPayee; });
  await fault("fee_too_high", (tx) => { tx.Fee = "10001"; });
  await fault("last_ledger_too_large", (tx) => { tx.LastLedgerSequence = validated + 200; });
  await fault("memo_rejected", (tx) => { tx.Memos = [{ Memo: { MemoData: "00" } }]; });
  await fault("network_id_present", (tx) => { tx.NetworkID = 1; });
  const official = Object.assign({ shape: "official_areFeesSponsored_false", payer_address: wallet.address, builder: true }, await verifySigned(scheme, officialAccept, wallet, officialTx, store));
  const replay = Object.assign({ shape: "official_replay", payer_address: wallet.address, builder: true }, await verifySigned(scheme, officialAccept, wallet, officialTx, store));
  return assertPublicReport({
    schema: "aether.diagnostics.buyer",
    mode: "offline",
    versions: { "@x402/xrpl": X402_VERSION, xrpl: XRPL_VERSION },
    hosted_verify_called: false,
    seller_called: false,
    cases: [Object.assign({ builder: true }, vendor), official, replay],
    faults,
    limitations: [
      "Offline only. No seller request and no hosted /verify or /settle.",
      "@x402/xrpl 2.30.0 rejects a missing areFeesSponsored flag. The echoed challenge is not changed.",
      "A passing local verifier is not proof the original seller accepts the payload.",
      "The in-memory settlement record is a local replay guard, not a ledger submission.",
    ],
  });
}

function classifySupported(body) {
  const kinds = body && Array.isArray(body.kinds) ? body.kinds : [];
  const exact = kinds.some((kind) => kind && kind.x402Version === 2 && kind.scheme === "exact" && kind.network === "xrpl:1");
  return {
    schema: "aether.diagnostics.buyer.supported",
    endpoint: HOSTED_SUPPORTED,
    method: "GET",
    exact_xrpl1: exact,
    schemes: kinds.map((kind) => kind && kind.scheme).filter((scheme) => typeof scheme === "string"),
    hosted_verify_called: false,
    seller_called: false,
  };
}

async function readHostedSupported(fetchImpl) {
  if (typeof fetchImpl !== "function") throw coded("supported read has no fetch", "LEDGER");
  const response = await fetchImpl(HOSTED_SUPPORTED, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "aether-foundry-missions" },
  });
  if (!response || response.ok === false) throw coded("supported read failed", "LEDGER");
  const body = typeof response.json === "function" ? await response.json() : null;
  return classifySupported(body);
}

async function main() {
  const command = process.argv[2] || "offline";
  if (command === "offline") {
    const report = await diagnoseOffline();
    process.stdout.write(`${JSON.stringify(assertPublicReport(report))}\n`);
    return;
  }
  if (command === "supported") {
    const report = await readHostedSupported(globalThis.fetch);
    process.stdout.write(`${JSON.stringify(assertPublicReport(report))}\n`);
    return;
  }
  throw coded("diagnostic command is offline or supported", "TX");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || "DIAGNOSTIC"}\n`);
    process.exit(1);
  });
}

module.exports = {
  HOSTED_SUPPORTED,
  X402_VERSION,
  challengeAccept,
  buildFoundryBuyerTx,
  diagnoseOffline,
  classifySupported,
  readHostedSupported,
  settlementOnce,
};
