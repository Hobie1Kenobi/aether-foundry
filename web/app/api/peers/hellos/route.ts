import { loadNetChat } from "@/lib/net-chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Inbound aether-peer-hello rows. Read-only.
 * The desk does not sign and does not submit.
 */
export async function GET() {
  const surface = await loadNetChat();
  return Response.json(
    {
      network: surface.network,
      desk: surface.desk,
      signing: surface.signing,
      w3: surface.w3,
      source: surface.source,
      note: surface.note,
      hellos: surface.hellos,
    },
    { headers: HEADERS }
  );
}
