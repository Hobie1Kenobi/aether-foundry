import { loadDeskStatus } from "@/lib/load-desk-status";
import { buildWall, downWall } from "@/lib/wall";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Curated programs plus a read-only amendment clock.
 * Mainnet is server_info and feature on one public host.
 * The desk does not sign and does not submit.
 */
export async function GET() {
  try {
    const status = await loadDeskStatus().catch(() => null);
    const payload = await buildWall({ status, fetch });
    return Response.json(payload, { headers: HEADERS });
  } catch {
    return Response.json(downWall(), { status: 503, headers: HEADERS });
  }
}
