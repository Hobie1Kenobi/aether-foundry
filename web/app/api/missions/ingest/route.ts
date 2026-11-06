import { createRequire } from "node:module";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const require = createRequire(import.meta.url);
const ingest = require("../../../../lib/mission-ingest.js") as {
  BLOB_PATH: string;
  handlePost: (input: {
    secret: string;
    authorization: string;
    raw: string;
    blobToken: string;
    read: () => Promise<Record<string, unknown> | null>;
    write: (pathname: string, doc: Record<string, unknown>) => Promise<void>;
  }) => Promise<{ status: number; body: Record<string, unknown> }>;
};

const HEADERS = { "Cache-Control": "no-store" };

async function readStored() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const blob = await import("@vercel/blob");
  const result = await blob.get(ingest.BLOB_PATH, { access: "private", useCache: false });
  if (!result || !result.stream) return null;
  return JSON.parse(await new Response(result.stream).text()) as Record<string, unknown>;
}

async function writeStored(_pathname: string, doc: Record<string, unknown>) {
  const blob = await import("@vercel/blob");
  await blob.put(ingest.BLOB_PATH, JSON.stringify(doc), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function GET() {
  return Response.json(
    { ok: false, code: "PUBLIC_WRITE", error: "ingest is not a public read" },
    { status: 405, headers: HEADERS },
  );
}

export async function POST(request: Request) {
  const result = await ingest.handlePost({
    secret: process.env.FOUNDRY_MISSION_INGEST_SECRET || "",
    authorization: request.headers.get("authorization") || "",
    raw: await request.text(),
    blobToken: process.env.BLOB_READ_WRITE_TOKEN || "",
    read: readStored,
    write: writeStored,
  });
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}
