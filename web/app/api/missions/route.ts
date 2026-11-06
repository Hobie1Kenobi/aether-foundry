import { publicMissionResponse } from "@/lib/missions-public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: HEADERS });
}

export async function GET() {
  const result = publicMissionResponse("GET", "feed");
  return json(result.status, result.body);
}

export async function POST() {
  const result = publicMissionResponse("POST", "feed");
  return json(result.status, result.body);
}

export async function PUT() {
  const result = publicMissionResponse("PUT", "feed");
  return json(result.status, result.body);
}

export async function DELETE() {
  const result = publicMissionResponse("DELETE", "feed");
  return json(result.status, result.body);
}
