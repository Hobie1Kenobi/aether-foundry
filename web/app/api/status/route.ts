import { loadDeskStatus } from "@/lib/load-desk-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Public seedless status. HTTPS JSON-RPC to altnets only.
 * Lab files are read at the current main commit SHA so a stale
 * raw.githubusercontent.com /main blob cannot hide a newer heartbeat.
 * The desk does not sign and does not read a seed.
 */
export async function GET() {
  const body = await loadDeskStatus();
  return Response.json(body, {
    status: body.network == null ? 502 : 200,
    headers: HEADERS,
  });
}
