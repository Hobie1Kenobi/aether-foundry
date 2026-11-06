import { publicMissionResponse } from "@/lib/missions-public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export async function GET() {
  const result = publicMissionResponse("GET", "status");
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}

export async function POST() {
  const result = publicMissionResponse("POST", "status");
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}
