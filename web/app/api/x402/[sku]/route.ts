import { handlePaidSku, x402Options } from "@/lib/x402-gate";
import {
  compositionQuoteResource,
  machineSpecResource,
  readLaborUnits,
  readMachinePrompt,
  reserveAuditResource,
  ResourceError,
} from "@/lib/x402-resources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error, code: "bad_request" }, null, 2), {
    status: 400,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handle(
  req: Request,
  ctx: { params: Promise<{ sku: string }> }
): Promise<Response> {
  const { sku } = await ctx.params;
  if (sku === "composition-quote") {
    const units = readLaborUnits(req);
    if (!units.ok) return badRequest(units.error);
  }
  return handlePaidSku(req, sku, async (request) => {
    if (sku === "machine-spec") return machineSpecResource(await readMachinePrompt(request));
    if (sku === "reserve-audit") return reserveAuditResource();
    if (sku === "composition-quote") {
      const units = readLaborUnits(request);
      if (!units.ok) throw new ResourceError(units.error, 400);
      return compositionQuoteResource(units.units);
    }
    throw new ResourceError("unknown sku", 404);
  });
}

export function GET(
  req: Request,
  ctx: { params: Promise<{ sku: string }> }
) {
  return handle(req, ctx);
}

export function POST(
  req: Request,
  ctx: { params: Promise<{ sku: string }> }
) {
  return handle(req, ctx);
}

export function OPTIONS() {
  return x402Options();
}
