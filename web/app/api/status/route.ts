import { collectStatus } from "@/lib/status-body";
import { AETH_HEX, WALLETS, XAHAU_W7, XRPL_HTTP } from "@/lib/xrpl-public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

const GIT = "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main";

/**
 * Public seedless status. HTTPS JSON-RPC to altnets only.
 * The desk does not sign and does not read a seed.
 */
export async function GET() {
  const body = await collectStatus({
    fetch,
    xrplHttp: XRPL_HTTP,
    xahauHttp: XAHAU_W7.rpc,
    w2: WALLETS.W2.address,
    ammAccount: WALLETS.AMM.address,
    w7: XAHAU_W7.address,
    aethCurrency: AETH_HEX,
    aethIssuer: WALLETS.W0.address,
    packHookHash: XAHAU_W7.hookHash,
    walkInDrops: "10000000",
    git: {
      metrics: `${GIT}/lab/metrics.json`,
      pnl: `${GIT}/market/pnl.md`,
      director: `${GIT}/lab/director-state.json`,
      ledger: `${GIT}/lab/ledger-log.jsonl`,
    },
  });
  return Response.json(body, {
    status: body.network == null ? 502 : 200,
    headers: HEADERS,
  });
}
