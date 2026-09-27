/**
 * Read-only XRPL helpers via HTTPS JSON-RPC. No Wallet, no sign, no seeds.
 * Avoids the xrpl WebSocket Client, which times out on Vercel serverless.
 */
import {
  AETH_HEX,
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
    OwnerCount?: number;
  };
};

type AmmInfoResult = RpcErrorBody & {
  ledger_index?: number;
  ledger_current_index?: number;
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
  ledgerIndex?: number | null;
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
      ledgerIndex: res.ledger_index ?? res.ledger_current_index ?? null,
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

export async function fetchBookOffers(limit = 5): Promise<{
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
        limit,
        ledger_index: "validated",
      }),
      rpc<BookOffersResult>("book_offers", {
        taker_gets: { currency: "XRP" },
        taker_pays: AETH_IOU,
        limit,
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

const TF_SELL_NFTOKEN = 0x00000001;

type NftOfferLedgerObject = {
  Amount?: unknown;
  Flags?: number;
  NFTokenID?: string;
  Owner?: string;
  PreviousTxnID?: string;
  index?: string;
};

type AccountObjectsResult = RpcErrorBody & {
  account_objects?: NftOfferLedgerObject[];
  marker?: unknown;
};

export type WalkInSellOffer = {
  offerId: string;
  nftokenId: string;
  owner: string;
  priceXrp: string | null;
  amountLabel: string;
  previousTxnId?: string;
};

export type WalkInStorefrontSnapshot = {
  account: string;
  status: "OPEN" | "SOLD OUT" | "ERROR";
  offers: WalkInSellOffer[];
  error?: string;
};

function dropsToXrp(drops: string): string | null {
  if (!/^\d+$/.test(drops)) return null;
  const xrp = Number(drops) / 1_000_000;
  if (!Number.isFinite(xrp)) return null;
  if (Number.isInteger(xrp)) return String(xrp);
  return xrp.toFixed(6).replace(/\.?0+$/, "");
}

function offerAmount(amount: unknown): { priceXrp: string | null; amountLabel: string } {
  if (typeof amount === "string") {
    const priceXrp = dropsToXrp(amount);
    if (priceXrp != null) return { priceXrp, amountLabel: `${priceXrp} XRP` };
    return { priceXrp: null, amountLabel: amount };
  }
  if (amount && typeof amount === "object") {
    const row = amount as { value?: string; currency?: string };
    const value = row.value ?? "?";
    const currency =
      row.currency === AETH_HEX ? "AETH" : row.currency ?? "IOU";
    return { priceXrp: null, amountLabel: `${value} ${currency}` };
  }
  return { priceXrp: null, amountLabel: "—" };
}

/** Open NFT sell offers owned by an account. Request-time read so a purchase shows SOLD OUT. */
export async function fetchWalkInSellOffers(
  address: string
): Promise<WalkInStorefrontSnapshot> {
  try {
    const objects: NftOfferLedgerObject[] = [];
    let marker: unknown;
    for (let page = 0; page < 4; page += 1) {
      const params: Record<string, unknown> = {
        account: address,
        type: "nft_offer",
        ledger_index: "validated",
        limit: 200,
      };
      if (marker !== undefined) params.marker = marker;
      const res = await rpc<AccountObjectsResult>("account_objects", params);
      objects.push(...(res.account_objects ?? []));
      if (res.marker == null) break;
      marker = res.marker;
    }
    const offers = objects
      .filter(
        (obj) =>
          ((obj.Flags ?? 0) & TF_SELL_NFTOKEN) === TF_SELL_NFTOKEN &&
          Boolean(obj.index) &&
          Boolean(obj.NFTokenID)
      )
      .map((obj) => {
        const price = offerAmount(obj.Amount);
        return {
          offerId: obj.index as string,
          nftokenId: obj.NFTokenID as string,
          owner: obj.Owner ?? address,
          previousTxnId: obj.PreviousTxnID,
          ...price,
        };
      });
    return {
      account: address,
      status: offers.length > 0 ? "OPEN" : "SOLD OUT",
      offers,
    };
  } catch (e) {
    return {
      account: address,
      status: "ERROR",
      offers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

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

export type LedgerReserves = {
  ledgerIndex: number | null;
  baseReserveDrops: string | null;
  ownerReserveDrops: string | null;
  error?: string;
};

type ServerStateResult = RpcErrorBody & {
  state?: {
    validated_ledger?: {
      reserve_base?: number | string;
      reserve_inc?: number | string;
      seq?: number;
    };
  };
};

function dropsField(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}

export async function fetchLedgerReserves(): Promise<LedgerReserves> {
  try {
    const res = await rpc<ServerStateResult>("server_state", {});
    const ledger = res.state?.validated_ledger;
    const baseReserveDrops = dropsField(ledger?.reserve_base);
    const ownerReserveDrops = dropsField(ledger?.reserve_inc);
    if (!baseReserveDrops || !ownerReserveDrops) {
      throw new Error("server_state missing reserve_base or reserve_inc");
    }
    return {
      ledgerIndex: typeof ledger?.seq === "number" ? ledger.seq : null,
      baseReserveDrops,
      ownerReserveDrops,
    };
  } catch (e) {
    return {
      ledgerIndex: null,
      baseReserveDrops: null,
      ownerReserveDrops: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type AccountPosture = {
  balanceDrops: string | null;
  ownerCount: number | null;
  sequence: number | null;
  error?: string;
};

export async function fetchAccountPosture(address: string): Promise<AccountPosture> {
  try {
    const res = await rpc<AccountInfoResult>("account_info", {
      account: address,
      ledger_index: "validated",
    });
    const data = res.account_data;
    if (!data || data.Balance == null) throw new Error("account_info missing Balance");
    const balanceDrops = dropsField(data.Balance);
    if (!balanceDrops) throw new Error("account_info Balance is not drops");
    return {
      balanceDrops,
      ownerCount: typeof data.OwnerCount === "number" ? data.OwnerCount : 0,
      sequence: typeof data.Sequence === "number" ? data.Sequence : null,
    };
  } catch (e) {
    return {
      balanceDrops: null,
      ownerCount: null,
      sequence: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type AccountLinesResult = RpcErrorBody & {
  lines?: Array<{ currency?: string; balance?: string }>;
};

export async function fetchAethTrustBalance(address: string): Promise<{
  aeth: string | null;
  error?: string;
}> {
  try {
    const res = await rpc<AccountLinesResult>("account_lines", {
      account: address,
      ledger_index: "validated",
    });
    let aeth: string | null = null;
    for (const line of res.lines ?? []) {
      if (line.currency === AETH_HEX && line.balance != null) aeth = line.balance;
    }
    return { aeth };
  } catch (e) {
    return {
      aeth: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type GatewayBalancesResult = RpcErrorBody & {
  obligations?: Record<string, string>;
};

export async function fetchAethObligations(issuer: string): Promise<{
  outstanding: string | null;
  error?: string;
}> {
  try {
    const res = await rpc<GatewayBalancesResult>("gateway_balances", {
      account: issuer,
      ledger_index: "validated",
    });
    const outstanding = res.obligations?.[AETH_HEX] ?? null;
    return { outstanding };
  } catch (e) {
    return {
      outstanding: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function fetchValidatedTransaction(hash: string): Promise<
  | { found: true; tx: Record<string, unknown> }
  | { found: false; code: "txnNotFound" | "rpc_error"; error: string }
> {
  let result: (RpcErrorBody & Record<string, unknown>) | undefined;
  try {
    const res = await fetch(XRPL_HTTP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        method: "tx",
        params: [{ transaction: hash, binary: false }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    try {
      const body = (await res.json()) as { result?: RpcErrorBody & Record<string, unknown> };
      result = body.result;
    } catch {
      result = undefined;
    }
    if (!res.ok && !result) {
      return {
        found: false,
        code: "rpc_error",
        error: `rpc tx: HTTP ${res.status}`,
      };
    }
  } catch (e) {
    return {
      found: false,
      code: "rpc_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!result || result.status === "error" || result.error) {
    const code = result?.error === "txnNotFound" ? "txnNotFound" : "rpc_error";
    return {
      found: false,
      code,
      error: result?.error_message || result?.error || "tx lookup failed",
    };
  }
  return { found: true, tx: result };
}
