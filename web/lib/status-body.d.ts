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
    remoteVerify: boolean;
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
  devnet: {
    network: "XRPL Devnet";
    networkId: 2;
    accounts: { D0: string | null; D1: string | null; D2: string | null; D3: string | null };
    f8: {
      sponsor: string | null;
      sponsoree: string | null;
      prior_sponsee: string | null;
      create_hash: string | null;
      object_hash: string | null;
      ledger_index: number | null;
    };
    f9: {
      owner: string | null;
      depositor: string | null;
      vault_id: string | null;
      broker_id: string | null;
      loan_id: string | null;
      asset: string | null;
      accounting: string | null;
      create_hash: string | null;
      repay_hash: string | null;
      ledger_index: number | null;
    };
    f10: {
      issuer: string | null;
      counterparty: string | null;
      sender: string | null;
      symbol: string | null;
      issuance_id: string | null;
      payment_hash: string | null;
      clawback_hash: string | null;
      ledger_index: number | null;
      public_ledger: string | null;
    };
  };
  director_updated_at: string | null;
  laws: string[];
  error?: string;
};

export function gitUrlsAtSha(sha: string): {
  metrics: string;
  pnl: string;
  director: string;
  ledger: string;
  wallets: string;
  devnetLedger: string;
};

export function mainGitFiles(
  fetchImpl: typeof fetch,
  opts?: { now?: number; cacheMs?: number }
): Promise<{
  metrics: string;
  pnl: string;
  director: string;
  ledger: string;
  wallets: string;
  devnetLedger: string;
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
    wallets?: string;
    devnetLedger?: string;
  };
  env?: Record<string, string | undefined>;
  labeled?: string[];
}): Promise<StatusBody>;
