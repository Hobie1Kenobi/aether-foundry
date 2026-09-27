/**
 * Read-only XRPL client helpers. No Wallet, no sign, no seeds.
 */
import { Client } from "xrpl";
import {
  AETH_IOU,
  NFT_TAXON,
  XRPL_WS,
  WALLETS,
} from "./xrpl-public";

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(XRPL_WS);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
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
    return await withClient(async (client) => {
      const res = await client.request({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      });
      const bal = res.result.account_data.Balance;
      const drops = typeof bal === "string" ? bal : String(bal);
      const xrp = (Number(drops) / 1_000_000).toFixed(6);
      return {
        address,
        role,
        balanceXrp: xrp,
        sequence: res.result.account_data.Sequence,
      };
    });
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
    return await withClient(async (client) => {
      const res = await client.request({
        command: "amm_info",
        asset: { currency: "XRP" },
        asset2: AETH_IOU,
      });
      const info = res.result.amm;
      return {
        account: info.account,
        amount: info.amount,
        amount2: info.amount2,
        lpToken: info.lp_token,
        tradingFee: info.trading_fee,
      };
    });
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
    return await withClient(async (client) => {
      const [buy, sell] = await Promise.all([
        client.request({
          command: "book_offers",
          taker_gets: AETH_IOU,
          taker_pays: { currency: "XRP" },
          limit: 5,
          ledger_index: "validated",
        }),
        client.request({
          command: "book_offers",
          taker_gets: { currency: "XRP" },
          taker_pays: AETH_IOU,
          limit: 5,
          ledger_index: "validated",
        }),
      ]);
      return {
        buyAeth: {
          side: "buy AETH (pay XRP)",
          offers: (buy.result.offers ?? []).map((o) => ({
            account: o.Account,
            takerPays: o.TakerPays,
            takerGets: o.TakerGets,
          })),
        },
        sellAeth: {
          side: "sell AETH (get XRP)",
          offers: (sell.result.offers ?? []).map((o) => ({
            account: o.Account,
            takerPays: o.TakerPays,
            takerGets: o.TakerGets,
          })),
        },
      };
    });
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
    return await withClient(async (client) => {
      const res = await client.request({
        command: "account_nfts",
        account: address,
        ledger_index: "validated",
      });
      const nfts = (res.result.account_nfts ?? [])
        .filter((n) => n.NFTokenTaxon === taxonFilter)
        .map((n) => ({
          nftokenID: n.NFTokenID,
          taxon: n.NFTokenTaxon,
          issuer: n.Issuer,
        }));
      return { account: address, role, nfts };
    });
  } catch (e) {
    return {
      account: address,
      role,
      nfts: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
