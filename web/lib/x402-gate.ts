import * as xrpl from "xrpl";
import { NETWORK_LABEL } from "./xrpl-public";
import { fetchValidatedTransaction } from "./xrpl-read";
import {
  PAY_TO,
  buildPaymentRequired,
  encodeHeader,
  getSku,
  howToPay,
  listSkus,
  newInvoiceId,
  verifyPaymentProof,
  type Sku,
} from "./x402-rules";
import { ResourceError } from "./x402-resources";

const seenProofs = new Set<string>();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};

function hashSignedTx(blob: string): string {
  let decoded: { TransactionType?: string };
  try {
    decoded = xrpl.decode(blob) as { TransactionType?: string };
  } catch {
    throw new Error("invalid_tx_blob");
  }
  if (decoded.TransactionType !== "Payment") throw new Error("not_payment_tx");
  return xrpl.hashes.hashSignedTx(blob);
}

function markDuplicate(skuId: string, hash: string): boolean {
  const key = `${skuId}:${hash}`;
  const duplicate = seenProofs.has(key);
  if (!duplicate) {
    if (seenProofs.size >= 500) seenProofs.clear();
    seenProofs.add(key);
  }
  return duplicate;
}

function jsonResponse(
  status: number,
  body: unknown,
  extra?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
      ...extra,
    },
  });
}

function paymentRequiredResponse(
  req: Request,
  sku: Sku,
  opts?: { error?: string; code?: string; invoiceId?: string; txHash?: string }
): Response {
  const invoiceId = opts?.invoiceId || newInvoiceId(sku.id);
  const paymentRequired = buildPaymentRequired({
    sku,
    resourceUrl: req.url,
    invoiceId,
    error: opts?.error || "PAYMENT-SIGNATURE header is required",
  });
  const body: Record<string, unknown> = {
    error: opts?.error || "Payment required",
    code: opts?.code || "payment_required",
    x402Version: 2,
    paymentRequired,
    howToPay: howToPay(sku, invoiceId),
  };
  if (opts?.txHash) body.txHash = opts.txHash;
  return jsonResponse(402, body, {
    "PAYMENT-REQUIRED": encodeHeader(paymentRequired),
  });
}

function hitEvent(sku: Sku, proof: {
  hash: string;
  payer: string;
  invoiceId: string;
  ledgerIndex: number | null;
}, duplicate: boolean) {
  return {
    ts: new Date().toISOString(),
    action: "x402_hit",
    sku: sku.id,
    network: "xrpl:1",
    pay_to: PAY_TO,
    amount_drops: sku.drops,
    amount_xrp: sku.xrp,
    source_tag: sku.sourceTag,
    invoice_id: proof.invoiceId,
    hash: proof.hash,
    payer: proof.payer,
    ledger_index: proof.ledgerIndex,
    duplicate,
    persisted: false,
    log_with: "npm run x402:hit",
  };
}

function assertTestnetDesk(req: Request): Response | null {
  if (/\bmainnet\b/i.test(NETWORK_LABEL)) {
    return jsonResponse(400, {
      error: "x402 refuses a mainnet network label",
      code: "invalid_network",
    });
  }
  const requested = new URL(req.url).searchParams.get("network");
  if (requested && requested !== "xrpl:1") {
    return jsonResponse(400, {
      error: "x402 accepts xrpl:1 (XRPL Testnet) only",
      code: "invalid_network",
    });
  }
  return null;
}

export function x402Catalog() {
  return {
    merchant: "aether-foundry-desk",
    network: "xrpl:1",
    refusedNetwork: "xrpl:0",
    scheme: "exact",
    asset: "XRP",
    payTo: PAY_TO,
    payToRole: "W3 CHANNELS",
    facilitator: null,
    verifier:
      "validated exact Payment on the public XRPL Testnet RPC; signed blobs are not submitted",
    hits: "Response includes x402_hit. Vercel does not write market/pnl.md. Append with npm run x402:hit.",
    skus: listSkus(),
  };
}

export async function handlePaidSku(
  req: Request,
  skuId: string,
  produce: (req: Request) => Promise<object>
): Promise<Response> {
  const refused = assertTestnetDesk(req);
  if (refused) return refused;
  const sku = getSku(skuId);
  if (!sku) {
    return jsonResponse(404, {
      error: "unknown sku",
      code: "unknown_sku",
      skus: listSkus().map((row) => row.id),
    });
  }
  const header =
    req.headers.get("payment-signature") || req.headers.get("x-payment");
  if (!header) return paymentRequiredResponse(req, sku);

  const proof = await verifyPaymentProof({
    header,
    sku,
    lookupTx: fetchValidatedTransaction,
    hashSignedTx,
  });
  if (!proof.ok) {
    const keepInvoice =
      proof.code === "payment_not_on_ledger" || proof.code === "payment_not_validated"
        ? proof.invoiceId || undefined
        : undefined;
    const bodyHeaders = {
      "PAYMENT-RESPONSE": encodeHeader({
        success: false,
        transaction: proof.txHash || "",
        network: "xrpl:1",
        payer: "",
        errorReason: proof.error,
      }),
    };
    const invoiceId = keepInvoice || undefined;
    const response = paymentRequiredResponse(req, sku, {
      error: proof.error,
      code: proof.code,
      invoiceId: invoiceId || undefined,
      txHash: proof.txHash,
    });
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(bodyHeaders)) headers.set(key, value);
    return new Response(response.body, { status: 402, headers });
  }

  const duplicate = markDuplicate(sku.id, proof.hash);
  const x402_hit = hitEvent(sku, proof, duplicate);
  const settlement = encodeHeader({
    success: true,
    transaction: proof.hash,
    network: "xrpl:1",
    payer: proof.payer,
  });
  try {
    const resource = await produce(req);
    return jsonResponse(200, { ...resource, x402_hit }, { "PAYMENT-RESPONSE": settlement });
  } catch (err) {
    const message = err instanceof Error ? err.message : "resource failed";
    const status = err instanceof ResourceError ? err.status : 502;
    return jsonResponse(
      status,
      {
        error: message,
        paid: true,
        retry_same_proof: true,
        x402_hit,
      },
      { "PAYMENT-RESPONSE": settlement }
    );
  }
}

export function x402Options(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
