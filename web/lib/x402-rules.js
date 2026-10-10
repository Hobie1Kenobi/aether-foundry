"use strict";

const { createHash } = require("crypto");

/** x402 v2 on XRPL Testnet. xrpl:0 is mainnet and is refused. */
const NETWORK = "xrpl:1";
const MAINNET = "xrpl:0";
const PAY_TO = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
const MAX_TIMEOUT_SECONDS = 600;
const TF_PARTIAL_PAYMENT = 0x00020000;

const SKUS = {
  "machine-spec": {
    id: "machine-spec",
    title: "Generate a machine spec",
    description:
      "Foundry Night machine pack outline (README, PRIMITIVES, ECONOMICS) from a short prompt. Template only.",
    drops: "100000",
    xrp: "0.100000",
    sourceTag: 202609271,
    path: "/api/x402/machine-spec",
  },
  "reserve-audit": {
    id: "reserve-audit",
    title: "Audit reserve posture",
    description:
      "Live Testnet read of W0–W6 and AMM XRP reserves, AETH balances, and stranding risk.",
    drops: "250000",
    xrp: "0.250000",
    sourceTag: 202609272,
    path: "/api/x402/reserve-audit",
  },
  "composition-quote": {
    id: "composition-quote",
    title: "Quote a composition from AMM+CLOB mid",
    description:
      "Live AMM mid plus W1 CLOB book mid for AETH/XRP, and a labor quote in XRP.",
    drops: "500000",
    xrp: "0.500000",
    sourceTag: 202609273,
    path: "/api/x402/composition-quote",
  },
};

const SKU_ORDER = ["machine-spec", "reserve-audit", "composition-quote"];

const DEFAULT_PROMPT =
  "Foundry Night machine: a walk-up counter that composes a Testnet Payment, an AETH trust line, and an NFT receipt.";

function listSkus() {
  return SKU_ORDER.map((id) => SKUS[id]);
}

function getSku(id) {
  return SKUS[id] || null;
}

function newInvoiceId(skuId) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `af-${skuId}-${Date.now().toString(36)}-${rand}`;
}

function encodeHeader(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function decodeHeader(value) {
  const pad = String(value).trim().replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(pad, "base64").toString("utf8");
  return JSON.parse(json);
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex").toUpperCase();
}

function buildPaymentRequired({ sku, resourceUrl, invoiceId, error }) {
  return {
    x402Version: 2,
    error: error || "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: sku.description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: sku.drops,
        asset: "XRP",
        payTo: PAY_TO,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: {
          sourceTag: sku.sourceTag,
          invoiceId,
          paymentFlow: "upfront",
          assetTransferMethod: "sequence",
        },
      },
    ],
    extensions: {},
  };
}

function howToPay(sku, invoiceId, env) {
  const facilitator = require("./x402-facilitator").publicFacilitator(env);
  return {
    network: NETWORK,
    refusedNetwork: MAINNET,
    scheme: "exact",
    asset: "XRP",
    transactionType: "Payment",
    destination: PAY_TO,
    destinationRole: "W3 CHANNELS",
    amountDrops: sku.drops,
    amountXrp: sku.xrp,
    sourceTag: sku.sourceTag,
    invoiceId,
    memo: {
      MemoType: Buffer.from("invoice", "utf8").toString("hex").toUpperCase(),
      MemoData: Buffer.from(invoiceId, "utf8").toString("hex").toUpperCase(),
    },
    invoiceIdSha256: sha256Hex(invoiceId),
    rpc: "https://testnet.xrpl-labs.com",
    retryHeader: "PAYMENT-SIGNATURE",
    facilitator,
    tradeoff:
      facilitator.mode === "dual"
        ? "Dual mode. Self-verify still reads a validated Payment. A T54 receipt is checked against the testnet facilitator host and the same ledger read. The desk does not sign and does not call settle. Vercel does not persist x402_hits; record the x402_hit from the 200 with npm run x402:hit."
        : "Self-verify reads a validated Payment on the public Testnet RPC. XRPL_FACILITATOR_URL is unset, so facilitator receipts are not sent to a host. The desk does not sign and does not submit signedTxBlob. Vercel does not persist x402_hits; record the x402_hit from the 200 with npm run x402:hit.",
  };
}

function fail(code, error, extra) {
  return Object.assign({ ok: false, code, error }, extra || {});
}

function memoTexts(tx) {
  const memos = tx && tx.Memos;
  if (!Array.isArray(memos)) return [];
  const out = [];
  for (const entry of memos) {
    const data = entry && entry.Memo && entry.Memo.MemoData;
    if (typeof data !== "string" || data.length === 0 || data.length % 2 !== 0) continue;
    if (!/^[0-9A-Fa-f]+$/.test(data)) continue;
    out.push(Buffer.from(data, "hex").toString("utf8"));
  }
  return out;
}

function bindsInvoice(tx, invoiceId) {
  if (memoTexts(tx).some((text) => text === invoiceId)) return true;
  const id = typeof tx.InvoiceID === "string" ? tx.InvoiceID.toUpperCase() : "";
  return id.length === 64 && id === sha256Hex(invoiceId);
}

function xrpDrops(field) {
  return typeof field === "string" && /^[0-9]+$/.test(field) ? field : null;
}

function metaOf(tx) {
  if (tx.meta && typeof tx.meta === "object") return tx.meta;
  if (tx.metaData && typeof tx.metaData === "object") return tx.metaData;
  return {};
}

function matchAccepted(accepted, sku) {
  if (accepted == null) return { ok: true, invoiceId: null, shorthand: true };
  if (typeof accepted !== "object") {
    return fail("payment_requirements_mismatch", "accepted must be an object");
  }
  if (accepted.network === MAINNET || accepted.network === "xrpl-mainnet") {
    return fail("invalid_network", "mainnet xrpl:0 is refused");
  }
  if (accepted.scheme !== "exact") {
    return fail("payment_requirements_mismatch", "scheme must be exact");
  }
  if (accepted.network !== NETWORK) {
    return fail("invalid_network", "network must be xrpl:1 (XRPL Testnet)");
  }
  if (accepted.asset !== "XRP") {
    return fail("payment_requirements_mismatch", "asset must be XRP");
  }
  if (accepted.payTo !== PAY_TO) {
    return fail("destination_mismatch", "payTo must be W3 CHANNELS");
  }
  if (accepted.amount !== sku.drops) {
    return fail("amount_mismatch", "amount must be the SKU price in drops");
  }
  const extra = accepted.extra && typeof accepted.extra === "object" ? accepted.extra : {};
  if (Number(extra.sourceTag) !== sku.sourceTag) {
    return fail("source_tag_mismatch", "sourceTag does not match this SKU");
  }
  if (typeof extra.invoiceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{3,79}$/.test(extra.invoiceId)) {
    return fail("invoice_binding_missing", "extra.invoiceId is missing");
  }
  if (extra.paymentFlow != null && extra.paymentFlow !== "upfront") {
    return fail("payment_requirements_mismatch", "paymentFlow must be upfront");
  }
  if (extra.assetTransferMethod != null && extra.assetTransferMethod !== "sequence") {
    return fail("payment_requirements_mismatch", "assetTransferMethod must be sequence");
  }
  return { ok: true, invoiceId: extra.invoiceId, shorthand: false };
}

function resolveProofHash(payload, hashSignedTx) {
  const body = payload && typeof payload === "object" ? payload : {};
  const explicitRaw = body.transaction || body.txHash || body.hash || "";
  const explicit = String(explicitRaw).trim().toUpperCase();
  const blob = typeof body.signedTxBlob === "string" ? body.signedTxBlob.trim() : "";
  let blobHash = "";
  if (blob) {
    if (typeof hashSignedTx !== "function") {
      return fail("invalid_tx_blob", "signedTxBlob cannot be hashed on this desk");
    }
    try {
      blobHash = String(hashSignedTx(blob) || "").trim().toUpperCase();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "not_payment_tx") {
        return fail("not_payment_tx", "signedTxBlob is not a Payment");
      }
      return fail("invalid_tx_blob", "signedTxBlob is not a signed XRPL transaction");
    }
  }
  if (explicit && blobHash && explicit !== blobHash) {
    return fail(
      "payment_requirements_mismatch",
      "transaction hash does not match signedTxBlob"
    );
  }
  const txHash = explicit || blobHash;
  if (!/^[0-9A-F]{64}$/.test(txHash)) {
    return fail(
      "invalid_payload",
      "PAYMENT-SIGNATURE needs payload.transaction or payload.signedTxBlob"
    );
  }
  return { ok: true, txHash };
}

function parseSignature(headerValue, sku, hashSignedTx) {
  let decoded;
  try {
    decoded = decodeHeader(headerValue);
  } catch {
    return fail("invalid_payload", "PAYMENT-SIGNATURE is not base64 JSON");
  }
  if (!decoded || typeof decoded !== "object") {
    return fail("invalid_payload", "PAYMENT-SIGNATURE JSON must be an object");
  }
  if (decoded.x402Version !== 2) {
    return fail("invalid_payload", "x402Version must be 2");
  }
  if (decoded.network === MAINNET || decoded.accepted?.network === MAINNET) {
    return fail("invalid_network", "mainnet xrpl:0 is refused");
  }
  const accepted = matchAccepted(decoded.accepted, sku);
  if (!accepted.ok) return accepted;
  const payload = decoded.payload && typeof decoded.payload === "object" ? decoded.payload : {};
  const fromTop = decoded.transaction || decoded.txHash || decoded.hash;
  const proof = resolveProofHash(
    fromTop ? Object.assign({ transaction: fromTop }, payload) : payload,
    hashSignedTx
  );
  if (!proof.ok) return Object.assign(proof, { invoiceId: accepted.invoiceId });
  return {
    ok: true,
    txHash: proof.txHash,
    invoiceId: accepted.invoiceId,
    shorthand: accepted.shorthand,
  };
}

function assessSettledPayment({ tx, sku, invoiceId, expectedHash }) {
  if (!tx || typeof tx !== "object") {
    return fail("rpc_error", "tx lookup returned nothing");
  }
  const hash = String(tx.hash || "").toUpperCase();
  if (hash !== String(expectedHash || "").toUpperCase()) {
    return fail("payment_requirements_mismatch", "settled hash does not match the proof");
  }
  if (tx.validated !== true) {
    return fail("payment_not_validated", "transaction is not in a validated ledger");
  }
  const meta = metaOf(tx);
  if (meta.TransactionResult !== "tesSUCCESS") {
    return fail("payment_not_validated", "transaction result is not tesSUCCESS");
  }
  if (tx.TransactionType !== "Payment") {
    return fail("not_payment_tx", "transaction is not a Payment");
  }
  if (tx.NetworkID != null && Number(tx.NetworkID) !== 1) {
    return fail("invalid_network", "NetworkID must be 1 for XRPL Testnet");
  }
  if (tx.Destination !== PAY_TO) {
    return fail("destination_mismatch", "Destination is not W3 CHANNELS");
  }
  if (tx.Amount && typeof tx.Amount === "object") {
    return fail("amount_mismatch", "IOU or cross-currency Amount is not exact XRP");
  }
  if (Array.isArray(tx.Paths) && tx.Paths.length > 0) {
    return fail("amount_mismatch", "path payments are not exact XRP");
  }
  const amount = xrpDrops(tx.Amount);
  const deliverMax = xrpDrops(tx.DeliverMax);
  if (tx.DeliverMax && typeof tx.DeliverMax === "object") {
    return fail("amount_mismatch", "DeliverMax is not XRP drops");
  }
  if (!amount && !deliverMax) {
    return fail("amount_mismatch", "Payment amount is missing");
  }
  if (amount && amount !== sku.drops) {
    return fail("amount_mismatch", "Amount does not match the SKU price");
  }
  if (deliverMax && deliverMax !== sku.drops) {
    return fail("amount_mismatch", "DeliverMax does not match the SKU price");
  }
  if (tx.SendMax != null) {
    const sendMax = xrpDrops(tx.SendMax);
    if (!sendMax || sendMax !== sku.drops) {
      return fail("amount_mismatch", "SendMax is not the exact XRP amount");
    }
  }
  const flags = Number(tx.Flags || 0);
  if (flags & TF_PARTIAL_PAYMENT) {
    return fail("amount_mismatch", "partial payments are rejected");
  }
  const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
  if (typeof delivered === "string" && delivered !== sku.drops) {
    return fail("amount_mismatch", "delivered_amount does not match the SKU price");
  }
  if (delivered && typeof delivered === "object") {
    return fail("amount_mismatch", "delivered amount is not XRP");
  }
  if (Number(tx.SourceTag) !== sku.sourceTag) {
    return fail("source_tag_mismatch", "SourceTag does not match this SKU");
  }
  if (typeof tx.LastLedgerSequence !== "number") {
    return fail("missing_last_ledger_sequence", "LastLedgerSequence is required");
  }
  let usedInvoice = invoiceId;
  if (invoiceId) {
    if (!bindsInvoice(tx, invoiceId)) {
      const any = memoTexts(tx).length > 0 || typeof tx.InvoiceID === "string";
      return fail(
        any ? "invoice_binding_mismatch" : "invoice_binding_missing",
        any ? "invoice binding does not match extra.invoiceId" : "Payment has no invoice binding"
      );
    }
  } else {
    const memos = memoTexts(tx).filter((text) => text.length > 0);
    if (memos.length > 0) usedInvoice = memos[0];
    else if (typeof tx.InvoiceID === "string" && /^[0-9A-Fa-f]{64}$/.test(tx.InvoiceID)) {
      usedInvoice = tx.InvoiceID.toUpperCase();
    } else {
      return fail("invoice_binding_missing", "Payment needs a memo or InvoiceID");
    }
  }
  const payer = typeof tx.Account === "string" ? tx.Account : "";
  if (!payer) return fail("rpc_error", "Payment has no Account");
  return {
    ok: true,
    hash,
    payer,
    invoiceId: usedInvoice,
    ledgerIndex: typeof tx.ledger_index === "number" ? tx.ledger_index : null,
    amountDrops: sku.drops,
  };
}

async function verifyPaymentProof({ header, sku, lookupTx, hashSignedTx }) {
  const parsed = parseSignature(header, sku, hashSignedTx);
  if (!parsed.ok) return parsed;
  let looked;
  try {
    looked = await lookupTx(parsed.txHash);
  } catch (err) {
    return fail("rpc_error", err instanceof Error ? err.message : "tx lookup failed", {
      txHash: parsed.txHash,
      invoiceId: parsed.invoiceId,
    });
  }
  if (!looked || looked.found !== true) {
    const missing = looked && looked.code === "txnNotFound";
    return fail(
      missing ? "payment_not_on_ledger" : "rpc_error",
      missing
        ? "No validated Testnet tx for this proof. v0 does not submit signed blobs. Submit the Payment, wait for tesSUCCESS, then retry the same PAYMENT-SIGNATURE."
        : (looked && looked.error) || "tx lookup failed",
      { txHash: parsed.txHash, invoiceId: parsed.invoiceId }
    );
  }
  const assessed = assessSettledPayment({
    tx: looked.tx,
    sku,
    invoiceId: parsed.invoiceId,
    expectedHash: parsed.txHash,
  });
  if (!assessed.ok) {
    return Object.assign(assessed, {
      txHash: parsed.txHash,
      invoiceId: parsed.invoiceId || assessed.invoiceId,
    });
  }
  return assessed;
}

function slugify(prompt) {
  const base = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return base || "untitled-night";
}

function buildMachineSpec(prompt, anchors) {
  const cfg = Object.assign(
    {
      w0: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
      w1: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
      w3: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
      amm: "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w",
      aethHex: "4145544800000000000000000000000000000000",
    },
    anchors || {}
  );
  const raw = String(prompt || "").trim();
  const promptTruncated = raw.length > 500;
  const clean = (raw || DEFAULT_PROMPT).slice(0, 500);
  const gridRefused = /\bgrid(\s|-)?bot\b|\bgrid trading\b/i.test(clean);
  const slug = slugify(gridRefused ? "observatory-not-a-grid" : clean);
  const title = gridRefused
    ? "Observatory stub (grid bot refused)"
    : clean.length > 72
      ? `${clean.slice(0, 69)}...`
      : clean;

  const catalog = [
    {
      re: /escrow|ticket|labor|bond/i,
      name: "EscrowCreate / EscrowFinish",
      note: "Labor bond in XRP. FinishAfter and CancelAfter use Ripple epoch, never Unix.",
    },
    {
      re: /nft|artifact|mint|badge|receipt/i,
      name: "NFTokenMint / NFTokenCreateOffer",
      note: "Taxon 20260927 receipt minted by W2. Transferable. Desk does not mint.",
    },
    {
      re: /amm|pool|swap|path/i,
      name: "AMM AETH/XRP",
      note: `Pool ${cfg.amm}. Read amm_info. Path pay is a composition, not a grid.`,
    },
    {
      re: /clob|book|offer|oracle|quote|mid/i,
      name: "book_offers",
      note: `W1 ${cfg.w1} passive wings. Mid with the AMM using 0.7 spot + 0.3 book.`,
    },
    {
      re: /channel|drip|stream/i,
      name: "PaymentChannelCreate / PaymentChannelClaim",
      note: `W3 CHANNELS ${cfg.w3}. Micropayment channel, not an x402 facilitator.`,
    },
    {
      re: /check/i,
      name: "CheckCreate / CheckCash",
      note: "Optional hospitality check after delivery.",
    },
    {
      re: /trust|aeth|iou/i,
      name: "TrustSet AETH",
      note: `Issuer W0 ${cfg.w0}, currency ${cfg.aethHex}.`,
    },
    {
      re: /payment|pay\b|xrp/i,
      name: "Payment",
      note: "Exact XRP Payment on Testnet. No partial flag.",
    },
  ];

  let selected;
  if (gridRefused) {
    selected = [
      { name: "account_info", note: "Read balances. Do not place a grid of offers." },
      { name: "amm_info", note: `Observe pool ${cfg.amm}.` },
      { name: "book_offers", note: "Observe the book. Do not chase it." },
    ];
  } else {
    selected = catalog.filter((row) => row.re.test(clean)).map(({ name, note }) => ({ name, note }));
    const fillers = [
      { name: "Payment", note: "Exact XRP Payment on XRPL Testnet." },
      { name: "TrustSet AETH", note: `Issuer W0 ${cfg.w0}, currency ${cfg.aethHex}.` },
      { name: "NFTokenMint", note: "Taxon 20260927 artifact receipt. Spec only until a trial." },
    ];
    for (const filler of fillers) {
      if (selected.length >= 3) break;
      if (!selected.some((row) => row.name === filler.name)) selected.push(filler);
    }
  }

  const primitiveLines = selected.map((row) => `- **${row.name}** — ${row.note}`).join("\n");
  const thesis = gridRefused
    ? "Refused as a grid bot. Foundry composes primitives and measures surplus. It does not grind a spread. This pack is an observatory stub."
    : clean;

  const readme = `# Machine — ${title}

**Status:** spec (x402 machine-spec). Not trialled.
**Network:** XRPL Testnet only (\`xrpl:1\`). Mainnet \`xrpl:0\` is out of scope.
**Slug:** \`${slug}\`

## Thesis

${thesis}

## Primitive composition

${primitiveLines}

## Public anchors

| Role | Address |
|------|---------|
| W0 Treasury / AETH issuer | \`${cfg.w0}\` |
| W1 Market | \`${cfg.w1}\` |
| W3 Channels | \`${cfg.w3}\` |
| AMM AETH/XRP | \`${cfg.amm}\` |
| AETH hex | \`${cfg.aethHex}\` |

## Non-goals

- No grid bot and no offer-chasing loop.
- No mainnet, no seeds in git, no signing from the Vercel desk.
- This outline is not a RESULTS file. A trial still has to submit and archive hashes.
`;

  const primitives = `# PRIMITIVES — ${slug}

Network: XRPL Testnet only.

${primitiveLines}

Desk merchant note: buying this outline did not submit these transactions.
`;

  const economics = `# ECONOMICS — ${slug}

**Network:** XRPL Testnet simulation. Drops here are not mainnet XRP.

## Stub

- Price the trial in Testnet XRP after a live AMM+CLOB quote, not from this template.
- AETH issuer is W0. Do not invent a second currency code.
- Surplus is the composition (escrow, channel, NFT, or quote), not a spread captured by a bot.
- x402 sale of this outline settles to W3 CHANNELS \`${cfg.w3}\` and is counted as \`x402_hits\` when an operator appends the desk event.

## Non-goals

- No grid-trading P&L.
- No claim that Vercel persisted this file.
`;

  return {
    sku: "machine-spec",
    network: NETWORK,
    slug,
    title,
    prompt: clean,
    prompt_truncated: promptTruncated,
    grid_refused: gridRefused,
    primitives: selected.map((row) => row.name),
    files: {
      "README.md": readme,
      "PRIMITIVES.md": primitives,
      "ECONOMICS.md": economics,
    },
  };
}

module.exports = {
  NETWORK,
  MAINNET,
  PAY_TO,
  MAX_TIMEOUT_SECONDS,
  SKUS,
  listSkus,
  getSku,
  newInvoiceId,
  encodeHeader,
  decodeHeader,
  sha256Hex,
  buildPaymentRequired,
  howToPay,
  verifyPaymentProof,
  assessSettledPayment,
  parseSignature,
  buildMachineSpec,
  memoTexts,
};
