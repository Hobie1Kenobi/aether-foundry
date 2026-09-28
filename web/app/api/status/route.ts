import { collectStatus, mainGitFiles } from "@/lib/status-body";
import { AETH_HEX, WALLETS, XAHAU_W7, XRPL_HTTP } from "@/lib/xrpl-public";

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
  let git;
  let gitError = "";
  try {
    git = await mainGitFiles(fetch);
  } catch (error) {
    gitError = error instanceof Error ? error.message : "git ref failed";
  }
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
    git,
  });
  if (gitError) body.error = body.error ? `${gitError}; ${body.error}` : gitError;
  return Response.json(body, {
    status: body.network == null ? 502 : 200,
    headers: HEADERS,
  });
}
