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
  grants_paid: number | null;
  inbound_counterparties: number | null;
  last_heartbeat: { hash: string | null; ledger_index: number | null; ts: string | null };
  director_updated_at: string | null;
  laws: string[];
  error?: string;
};

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
  git?: {
    metrics?: string;
    pnl?: string;
    director?: string;
    ledger?: string;
  };
}): Promise<StatusBody>;
