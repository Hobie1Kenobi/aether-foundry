export const LAWS: string[];

export type StatusBody = {
  network: "xrpl:1" | null;
  desk: "read-only";
  ledger_index: number | null;
  walk_in: {
    status: "open" | "sold_out" | "error";
    offer_id: string;
    amount_drops: string | null;
  };
  amm: { account: string; spot_xrp_per_aeth: string | null };
  batch_atomic_enabled: boolean | null;
  w7_hook_matches_pack: boolean | null;
  x402_hits: number | null;
  x402_outbound_hits: number | null;
  x402_foreign_hits: number | null;
  grants_paid: number | null;
  inbound_counterparties: number | null;
  facilitator: {
    mode: "self-verify" | "dual" | "refused";
    host: string | null;
    url: string | null;
    network: "xrpl:1";
    networkId: 1;
    advertised: string;
    settles: false;
    verifyOnly: true;
    code?: string;
    error?: string;
  };
  last_heartbeat: { hash: string | null; ledger_index: number | null; ts: string | null };
  oracle_id: string | null;
  oracle: {
    account: string;
    oracle_document_id: number | null;
    last_update_time: number | null;
    quote_xrp_per_aeth: string | null;
    asset_price: string | null;
    scale: number | null;
    ledger_index: number | null;
    base_asset: string | null;
    quote_asset: string | null;
  };
  mpt_issuance_id: string | null;
  domain_id: string | null;
  director_updated_at: string | null;
  laws: string[];
  error?: string;
};

export function gitUrlsAtSha(sha: string): {
  metrics: string;
  pnl: string;
  director: string;
  ledger: string;
};

export function mainGitFiles(
  fetchImpl: typeof fetch,
  opts?: { now?: number; cacheMs?: number }
): Promise<{
  metrics: string;
  pnl: string;
  director: string;
  ledger: string;
}>;

export function collectStatus(opts: {
  fetch: typeof fetch;
  xrplHttp: string;
  xahauHttp: string;
  w2: string;
  ammAccount: string;
  w7: string;
  aethCurrency: string;
  aethIssuer: string;
  packHookHash: string;
  walkInDrops?: string;
  w5?: string;
  oracleDocumentId?: number;
  git?: {
    metrics?: string;
    pnl?: string;
    director?: string;
    ledger?: string;
  };
  env?: Record<string, string | undefined>;
  labeled?: string[];
}): Promise<StatusBody>;
