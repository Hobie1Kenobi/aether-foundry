import { publicMissionResponse } from "@/lib/missions-public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = publicMissionResponse("GET", "replay", id);
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}

export async function POST() {
  const result = publicMissionResponse("POST", "replay");
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}
