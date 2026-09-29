import { collectStatus, mainGitFiles, type StatusBody } from "@/lib/status-body";
import { AETH_HEX, ORACLE, WALLETS, XAHAU_W7, XRPL_HTTP } from "@/lib/xrpl-public";

/**
 * Same seedless assembly as GET /api/status.
 * The desk does not sign and does not read a seed.
 */
export async function loadDeskStatus(): Promise<StatusBody> {
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
    w5: ORACLE.account,
    oracleDocumentId: ORACLE.documentId,
    ammAccount: WALLETS.AMM.address,
    w7: XAHAU_W7.address,
    aethCurrency: AETH_HEX,
    aethIssuer: WALLETS.W0.address,
    packHookHash: XAHAU_W7.hookHash,
    walkInDrops: "10000000",
    git,
    env: {
      XRPL_FACILITATOR_URL: process.env.XRPL_FACILITATOR_URL,
      XRPL_NETWORK: process.env.XRPL_NETWORK,
    },
    labeled: Object.values(WALLETS).map((wallet) => wallet.address),
  });
  if (gitError) body.error = body.error ? `${gitError}; ${body.error}` : gitError;
  return body;
}
