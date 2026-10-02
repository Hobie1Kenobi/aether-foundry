import { loadDeskStatus } from "@/lib/load-desk-status";
import { buildWall, downWall, renderRss } from "@/lib/wall";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/rss+xml; charset=utf-8",
};

/**
 * RSS 2.0 for the Wall of Change. Rumor rows are omitted.
 * Press items are Cointelegraph titles and X posts. Neither is an on-chain claim.
 * The desk does not sign and does not submit.
 */
export async function GET() {
  try {
    const status = await loadDeskStatus().catch(() => null);
    const payload = await buildWall({ status, fetch });
    return new Response(renderRss(payload.programs, payload.generated_at, payload.headlines), {
      headers: HEADERS,
    });
  } catch {
    const down = downWall();
    return new Response(renderRss(down.programs, down.generated_at), {
      status: 503,
      headers: HEADERS,
    });
  }
}
