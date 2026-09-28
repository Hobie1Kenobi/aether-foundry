import { AETH_HEX, WALLETS, XRPL_HTTP } from "@/lib/xrpl-public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DESK = "https://aether-foundry-desk.vercel.app";
const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

const READ_TOOLS = [
  {
    name: "walk_in_status",
    description: "Read the current Walk-In Window sell offer. Does not sign.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "x402_catalog",
    description: "List desk x402 SKUs. Does not sign.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "director_status",
    description: "Desk /api/status. A 404 is reported. The desk does not sign.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "grant_eligibility",
    description: "Grants scan stays on the operator machine. This route does not pay.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "amm_quote",
    description: "Public Testnet amm_info plus the unpaid composition-quote status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "walk_in_buy",
    description: "Delegated. The desk returns a dry-run command and does not sign.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "x402_buy",
    description: "Delegated argv for npm run x402:pay. The desk does not run it.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string", enum: ["machine-spec", "reserve-audit", "composition-quote"] },
      },
      required: ["sku"],
      additionalProperties: false,
    },
  },
];

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, { headers: HEADERS });
}

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: HEADERS }
  );
}

function toolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
  };
}

function forbiddenName(key: string): boolean {
  return /^(seed|secret|private_?key)$/i.test(key);
}

function walkForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => walkForbidden(item));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && /sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenName(key) || walkForbidden(child)) return true;
  }
  return false;
}

function isMainnetHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const blocked = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link", "xahau.network"];
  return blocked.some((item) => host === item || host.endsWith(`.${item}`));
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const parsed = new URL(url);
  if (isMainnetHost(parsed.hostname)) {
    throw new Error("refusing mainnet host");
  }
  const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "error" });
  const text = await res.text();
  if (/sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) {
    throw new Error("refusing seed-shaped output");
  }
  if (!text) return { status: res.status, body: null };
  try {
    const body = JSON.parse(text) as Record<string, unknown> | unknown[];
    if (walkForbidden(body)) throw new Error("refusing forbidden field");
    if (Array.isArray(body)) return { status: res.status, body: null };
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof Error && /refusing/.test(error.message)) throw error;
    return { status: res.status, body: null };
  }
}

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const endpoint = new URL(XRPL_HTTP);
  if (isMainnetHost(endpoint.hostname) || !endpoint.hostname.endsWith("rippletest.net")) {
    throw new Error("refusing non-testnet XRPL url");
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    redirect: "error",
  });
  const text = await res.text();
  if (/sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) throw new Error("refusing seed-shaped output");
  const parsed = JSON.parse(text) as { result?: Record<string, unknown> | null };
  return parsed.result ?? null;
}

async function walkInStatus() {
  const res = await getJson(`${DESK}/api/inbound/walk-in`);
  const body = res.body && typeof res.body === "object" && !Array.isArray(res.body) ? res.body : {};
  const networkId = typeof body.networkId === "number" ? body.networkId : null;
  if (networkId === 0) throw new Error("refusing mainnet network id 0");
  const offers = Array.isArray(body.offers)
    ? body.offers.map((offer) => {
        const row = offer && typeof offer === "object" && !Array.isArray(offer) ? offer : {};
        return {
          offerId: typeof row.offerId === "string" ? row.offerId : null,
          nftokenId: typeof row.nftokenId === "string" ? row.nftokenId : null,
          amount: typeof row.amount === "string" ? row.amount : null,
          priceXrp: typeof row.priceXrp === "string" ? row.priceXrp : null,
        };
      })
    : [];
  return {
    signing: "none",
    deskSigns: false,
    networkId,
    status: typeof body.status === "string" ? body.status : null,
    seller: typeof body.seller === "string" ? body.seller : null,
    offers,
    httpStatus: res.status,
  };
}

async function x402Catalog() {
  const res = await getJson(`${DESK}/api/x402`);
  return { signing: "none", deskSigns: false, httpStatus: res.status, catalog: res.body };
}

async function directorStatus() {
  const res = await getJson(`${DESK}/api/status`);
  const desk =
    res.status === 404
      ? { available: false, status: 404 }
      : { available: res.status >= 200 && res.status < 300 && res.body != null, status: res.status, body: res.body };
  return {
    signing: "none",
    deskSigns: false,
    state: { available: false, error: "director-state.json is not served by the desk" },
    desk,
  };
}

function grantEligibility() {
  return {
    signing: "none",
    signed: false,
    readOnly: true,
    available: false,
    command: "npm run grants:scan",
    note: "grants:scan runs in the repo MCP, not on Vercel",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function ammQuote() {
  const info = asRecord(await rpc("server_info", {})) || {};
  const meta = asRecord(info.info) || {};
  const networkId = typeof meta.network_id === "number" ? meta.network_id : null;
  if (networkId == null) throw new Error("RPC did not prove network id");
  if (networkId !== 1) throw new Error("refusing network id");
  const ammBody = asRecord(await rpc("amm_info", {
    asset: { currency: "XRP" },
    asset2: { currency: AETH_HEX, issuer: WALLETS.W0.address },
    ledger_index: "validated",
  })) || {};
  const amm = asRecord(ammBody.amm);
  const quote = await getJson(`${DESK}/api/x402/composition-quote`);
  return {
    signing: "none",
    deskSigns: false,
    paid: false,
    network_id: networkId,
    amm: {
      account: amm && typeof amm.account === "string" ? amm.account : null,
      ledger_index: ammBody.validated === true && typeof ammBody.ledger_index === "number" ? ammBody.ledger_index : null,
    },
    desk_composition: { httpStatus: quote.status, unpaid: quote.status === 402, paid: false },
  };
}

function walkInBuy() {
  return {
    delegated: true,
    signed: false,
    executed: false,
    command: "npm run buy:walk-in -- --dry-run",
    argv: ["npm", "run", "buy:walk-in", "--", "--dry-run"],
    vercel: true,
    note: "desk does not sign",
  };
}

function x402Buy(args: Record<string, unknown>) {
  const sku = args.sku;
  if (sku !== "machine-spec" && sku !== "reserve-audit" && sku !== "composition-quote") {
    throw new Error("unknown sku");
  }
  return {
    delegated: true,
    signed: false,
    executed: false,
    command: `npm run x402:pay -- ${sku}`,
    argv: ["npm", "run", "x402:pay", "--", sku],
    vercel: true,
    note: "desk does not sign",
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (process.env.VERCEL && (name === "walk_in_buy" || name === "x402_buy")) {
    return name === "walk_in_buy" ? walkInBuy() : x402Buy(args);
  }
  if (name === "walk_in_status") return walkInStatus();
  if (name === "x402_catalog") return x402Catalog();
  if (name === "director_status") return directorStatus();
  if (name === "grant_eligibility") return grantEligibility();
  if (name === "amm_quote") return ammQuote();
  if (name === "walk_in_buy") return walkInBuy();
  if (name === "x402_buy") return x402Buy(args);
  throw new Error("unknown tool");
}

export function GET() {
  return Response.json(
    {
      server: "aether-foundry-inbound",
      transport: "http",
      signing: "off",
      deskSigns: false,
      vercel: Boolean(process.env.VERCEL),
      note: "Seedless facade. Signing MCP is not served on Vercel.",
      tools: READ_TOOLS.map((tool) => tool.name),
    },
    { headers: HEADERS }
  );
}

export async function POST(req: Request) {
  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    message = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message && message.id, -32600, "invalid request");
  }
  if (walkForbidden(message.params || {})) {
    console.error("mcp rejected forbidden argument name");
    return rpcResult(message.id, toolResult({ error: "refusing forbidden argument name", code: "FORBIDDEN_ARG" }, true));
  }
  if (message.method === "initialize") {
    return rpcResult(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "aether-foundry-inbound", version: "1" },
      instructions: "Desk facade. MCP_SIGN is ignored. This route does not sign.",
    });
  }
  if (message.method === "tools/list") {
    return rpcResult(message.id, { tools: READ_TOOLS.map((tool) => ({ ...tool })) });
  }
  if (message.method === "tools/call") {
    const name = message.params && message.params.name;
    if (!name) return rpcError(message.id, -32602, "missing tool name");
    try {
      const payload = await callTool(name, (message.params && message.params.arguments) || {});
      return rpcResult(message.id, toolResult(payload, false));
    } catch (error) {
      const text = error instanceof Error ? error.message : "tool failed";
      const safe = /sEd[1-9A-HJ-NP-Za-km-z]{20,}/.test(text) ? "tool failed" : text;
      return rpcResult(message.id, toolResult({ error: safe, code: "ERROR" }, true));
    }
  }
  return rpcError(message.id, -32601, "method not found");
}
