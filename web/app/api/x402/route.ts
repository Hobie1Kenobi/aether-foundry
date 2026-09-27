import { x402Catalog, x402Options } from "@/lib/x402-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(x402Catalog(), {
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function OPTIONS() {
  return x402Options();
}
