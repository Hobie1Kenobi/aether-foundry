/**
 * Read-only XRPL helpers via HTTPS JSON-RPC. No Wallet, no sign, no seeds.
 * Avoids the xrpl WebSocket Client, which times out on Vercel serverless.
 */
import {
  AETH_IOU,
  NFT_TAXON,
  WALLETS,
  XRPL_HTTP,
} from "./xrpl-public";

const RPC_TIMEOUT_MS = 8_000;

type RpcErrorBody = {
  status?: string;
  error?: string;
  error_message?: string;
};

type AccountInfoResult = RpcErrorBody & {
  account_data?: {
    Balance?: string | number;
    Sequence?: number;
  };
};

type AmmInfoResult = RpcErrorBody & {
  amm?: {
    account: string;
    amount?: unknown;
    amount2?: unknown;
    lp_token?: unknown;
    trading_fee?: number;
  };
};

type BookOffer = {
  Account: string;
  TakerPays: unknown;
  TakerGets: unknown;
};

type BookOffersResult = RpcErrorBody & {
  offers?: BookOffer[];
};

type AccountNft = {
  NFTokenID: string;
  NFTokenTaxon: number;
  Issuer: string;
};

type AccountNftsResult = RpcErrorBody & {
  account_nfts?: AccountNft[];
};

async function rpc<T extends RpcErrorBody>(
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const res = await fetch(XRPL_HTTP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ method, params: [params] }),
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  let result: T | undefined;
  try {
    const body = (await res.json()) as { result?: T };
    result = body.result;
  } catch {
    result = undefined;
  }

  if (!res.ok) {
    const detail = result?.error_message || result?.error || res.statusText;
    throw new Error(
      `rpc ${method}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`
    );
  }
  if (!result || result.status === "error" || result.error) {
    throw new Error(
      result?.error_message || result?.error || `rpc ${method} failed`
    );
  }
  return result;
}

export type AccountSnapshot = {
  address: string;
  role: string;
  balanceXrp: string | null;
  sequence: number | null;
  error?: string;
};

export async function fetchAccountInfo(
  address: string,
  role: string
): Promise<AccountSnapshot> {
  try {
    const res = await rpc<AccountInfoResult>("account_info", {
      account: address,
      ledger_index: "validated",
    });
    const data = res.account_data;
    if (!data || data.Balance == null || data.Sequence == null) {
      throw new Error("account_info missing account_data");
    }
    const drops = typeof data.Balance === "string" ? data.Balance : String(data.Balance);
    const xrp = (Number(drops) / 1_000_000).toFixed(6);
    return {
      address,
      role,
      balanceXrp: xrp,
      sequence: data.Sequence,
    };
  } catch (e) {
    return {
      address,
      role,
      balanceXrp: null,
      sequence: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type AmmSnapshot = {
  account: string;
  amount?: unknown;
  amount2?: unknown;
  lpToken?: unknown;
  tradingFee?: number;
  error?: string;
};

export async function fetchAmmInfo(): Promise<AmmSnapshot> {
  try {
    const res = await rpc<AmmInfoResult>("amm_info", {
      asset: { currency: "XRP" },
      asset2: AETH_IOU,
    });
    const info = res.amm;
    if (!info?.account) {
      throw new Error("amm_info missing amm");
    }
    return {
      account: info.account,
      amount: info.amount,
      amount2: info.amount2,
      lpToken: info.lp_token,
      tradingFee: info.trading_fee,
    };
  } catch (e) {
    return {
      account: WALLETS.AMM.address,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type BookSnapshot = {
  side: string;
  offers: Array<{ account: string; takerPays: unknown; takerGets: unknown }>;
  error?: string;
};

export async function fetchBookOffers(): Promise<{
  buyAeth: BookSnapshot;
  sellAeth: BookSnapshot;
}> {
  const empty = (side: string, error?: string): BookSnapshot => ({
    side,
    offers: [],
    error,
  });
  try {
    const [buy, sell] = await Promise.all([
      rpc<BookOffersResult>("book_offers", {
        taker_gets: AETH_IOU,
        taker_pays: { currency: "XRP" },
        limit: 5,
        ledger_index: "validated",
      }),
      rpc<BookOffersResult>("book_offers", {
        taker_gets: { currency: "XRP" },
        taker_pays: AETH_IOU,
        limit: 5,
        ledger_index: "validated",
      }),
    ]);
    const mapOffers = (offers: BookOffer[] | undefined) =>
      (offers ?? []).map((o) => ({
        account: o.Account,
        takerPays: o.TakerPays,
        takerGets: o.TakerGets,
      }));
    return {
      buyAeth: {
        side: "buy AETH (pay XRP)",
        offers: mapOffers(buy.offers),
      },
      sellAeth: {
        side: "sell AETH (get XRP)",
        offers: mapOffers(sell.offers),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      buyAeth: empty("buy AETH (pay XRP)", msg),
      sellAeth: empty("sell AETH (get XRP)", msg),
    };
  }
}

export type NftSnapshot = {
  account: string;
  role: string;
  nfts: Array<{ nftokenID: string; taxon: number; issuer: string }>;
  error?: string;
};

export async function fetchAccountNfts(
  address: string,
  role: string,
  taxonFilter = NFT_TAXON
): Promise<NftSnapshot> {
  try {
    const res = await rpc<AccountNftsResult>("account_nfts", {
      account: address,
      ledger_index: "validated",
    });
    const nfts = (res.account_nfts ?? [])
      .filter((n) => n.NFTokenTaxon === taxonFilter)
      .map((n) => ({
        nftokenID: n.NFTokenID,
        taxon: n.NFTokenTaxon,
        issuer: n.Issuer,
      }));
    return { account: address, role, nfts };
  } catch (e) {
    return {
      account: address,
      role,
      nfts: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
