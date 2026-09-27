import { buildMachineSpec } from "./x402-rules";
import {
  AETH_HEX,
  AETH_IOU,
  WALLETS,
  XRPL_HTTP,
} from "./xrpl-public";
import {
  fetchAccountPosture,
  fetchAethObligations,
  fetchAethTrustBalance,
  fetchAmmInfo,
  fetchBookOffers,
  fetchLedgerReserves,
} from "./xrpl-read";

export class ResourceError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ResourceError";
    this.status = status;
  }
}

const POSTURE_ACCOUNTS = [
  WALLETS.W0,
  WALLETS.W1,
  WALLETS.W2,
  WALLETS.W3,
  WALLETS.W4,
  WALLETS.W5,
  WALLETS.W6,
  WALLETS.AMM,
] as const;

const DROP = BigInt(1000000);
const HIGH_SPENDABLE = BigInt(2000000);
const ELEVATED_SPENDABLE = BigInt(10000000);

function dropsToXrp(drops: bigint): string {
  const negative = drops < BigInt(0);
  const abs = negative ? -drops : drops;
  const whole = abs / DROP;
  const frac = (abs % DROP).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function fx(value: number): string {
  return value.toFixed(8);
}

export async function readMachinePrompt(req: Request): Promise<string> {
  const url = new URL(req.url);
  let prompt = url.searchParams.get("prompt")?.trim() ?? "";
  if (!prompt && req.method === "POST") {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      try {
        const body = (await req.json()) as { prompt?: unknown };
        if (typeof body?.prompt === "string") prompt = body.prompt.trim();
      } catch {
        prompt = "";
      }
    }
  }
  return prompt;
}

export function readLaborUnits(req: Request):
  | { ok: true; units: number }
  | { ok: false; error: string } {
  const raw = new URL(req.url).searchParams.get("units");
  if (raw == null || raw === "") return { ok: true, units: 1 };
  const units = Number(raw);
  if (!Number.isFinite(units) || units <= 0 || units > 1_000_000) {
    return { ok: false, error: "units must be a positive number up to 1000000" };
  }
  return { ok: true, units };
}

export function machineSpecResource(prompt: string) {
  return buildMachineSpec(prompt, {
    w0: WALLETS.W0.address,
    w1: WALLETS.W1.address,
    w3: WALLETS.W3.address,
    amm: WALLETS.AMM.address,
    aethHex: AETH_HEX,
  });
}

export async function reserveAuditResource() {
  const accounts = POSTURE_ACCOUNTS.map((wallet) => ({
    id: wallet.id,
    role: wallet.role,
    address: wallet.address,
  }));
  const [reserves, obligations, postures, lines] = await Promise.all([
    fetchLedgerReserves(),
    fetchAethObligations(WALLETS.W0.address),
    Promise.all(accounts.map((account) => fetchAccountPosture(account.address))),
    Promise.all(accounts.map((account) => fetchAethTrustBalance(account.address))),
  ]);
  if (
    reserves.error ||
    reserves.baseReserveDrops == null ||
    reserves.ownerReserveDrops == null
  ) {
    throw new ResourceError(
      reserves.error || "server_state did not return Testnet reserves"
    );
  }
  const base = BigInt(reserves.baseReserveDrops);
  const inc = BigInt(reserves.ownerReserveDrops);
  const rows = accounts.map((account, index) => {
    const posture = postures[index];
    const line = lines[index];
    if (posture.error || posture.balanceDrops == null || posture.ownerCount == null) {
      return {
        id: account.id,
        role: account.role,
        address: account.address,
        balance_xrp: null,
        reserve_xrp: null,
        spendable_xrp: null,
        owner_count: posture.ownerCount,
        sequence: posture.sequence,
        aeth: account.id === "W0" ? obligations.outstanding : line.aeth,
        stranding: "unread",
        error: posture.error || "account_info failed",
      };
    }
    const balance = BigInt(posture.balanceDrops);
    const reserve = base + BigInt(posture.ownerCount) * inc;
    const spendable = balance > reserve ? balance - reserve : BigInt(0);
    const stranding =
      spendable < HIGH_SPENDABLE
        ? "high"
        : spendable < ELEVATED_SPENDABLE
          ? "elevated"
          : "clear";
    return {
      id: account.id,
      role: account.role,
      address: account.address,
      balance_xrp: dropsToXrp(balance),
      reserve_xrp: dropsToXrp(reserve),
      spendable_xrp: dropsToXrp(spendable),
      owner_count: posture.ownerCount,
      sequence: posture.sequence,
      aeth: account.id === "W0" ? obligations.outstanding : line.aeth,
      stranding,
      line_error: line.error,
    };
  });
  let nav = BigInt(0);
  const buckets = { high: [] as string[], elevated: [] as string[], clear: [] as string[], unread: [] as string[] };
  for (const row of rows) {
    buckets[row.stranding as keyof typeof buckets].push(row.id);
    if (row.id === "AMM" || row.spendable_xrp == null) continue;
    const [whole, frac = "0"] = row.spendable_xrp.split(".");
    nav += BigInt(whole) * DROP + BigInt(frac.padEnd(6, "0").slice(0, 6));
  }
  return {
    sku: "reserve-audit",
    network: "xrpl:1",
    rpc: XRPL_HTTP,
    as_of: new Date().toISOString(),
    ledger_index: reserves.ledgerIndex,
    base_reserve_xrp: dropsToXrp(base),
    owner_reserve_xrp: dropsToXrp(inc),
    aeth_outstanding: obligations.outstanding,
    aeth_outstanding_error: obligations.error,
    aeth_currency_hex: AETH_HEX,
    aeth_issuer: WALLETS.W0.address,
    stranding_rule:
      "high when spendable XRP is under 2; elevated when spendable is under 10; otherwise clear. unread means account_info failed. NAV sums W0–W6 spendable and skips AMM.",
    nav_spendable_xrp_w0_w6: dropsToXrp(nav),
    stranding: buckets,
    accounts: rows,
  };
}

type OfferRow = { account: string; takerPays: unknown; takerGets: unknown };

function xrpPerAeth(xrpSide: unknown, aethSide: unknown): number | null {
  if (typeof xrpSide !== "string" || !/^[0-9]+$/.test(xrpSide)) return null;
  if (!aethSide || typeof aethSide !== "object") return null;
  const row = aethSide as { currency?: string; issuer?: string; value?: string };
  if (row.currency !== AETH_IOU.currency) return null;
  if (row.issuer && row.issuer !== AETH_IOU.issuer) return null;
  const qty = Number(row.value);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return Number(xrpSide) / 1_000_000 / qty;
}

function bestPrice(
  offers: OfferRow[],
  price: (offer: OfferRow) => number | null,
  onlyAccount?: string
): { price: number | null; account: string | null; levels: number } {
  let first: { price: number; account: string } | null = null;
  let levels = 0;
  for (const offer of offers) {
    if (onlyAccount && offer.account !== onlyAccount) continue;
    const px = price(offer);
    if (px == null) continue;
    levels += 1;
    if (!first) first = { price: px, account: offer.account };
  }
  return {
    price: first ? first.price : null,
    account: first ? first.account : null,
    levels,
  };
}

function poolSides(amount: unknown, amount2: unknown): { aeth: number; xrp: number } | null {
  const asAeth = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const row = value as { currency?: string; value?: string };
    if (row.currency !== AETH_HEX || row.value == null) return null;
    const qty = Number(row.value);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    return qty;
  };
  const asXrp = (value: unknown) => {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
    return Number(value) / 1_000_000;
  };
  const aethFirst = asAeth(amount);
  const xrpSecond = asXrp(amount2);
  if (aethFirst != null && xrpSecond != null) return { aeth: aethFirst, xrp: xrpSecond };
  const aethSecond = asAeth(amount2);
  const xrpFirst = asXrp(amount);
  if (aethSecond != null && xrpFirst != null) return { aeth: aethSecond, xrp: xrpFirst };
  return null;
}

export async function compositionQuoteResource(units: number) {
  const [amm, books] = await Promise.all([fetchAmmInfo(), fetchBookOffers(20)]);
  if (amm.error) throw new ResourceError(`amm_info failed: ${amm.error}`);
  if (books.buyAeth.error || books.sellAeth.error) {
    throw new ResourceError(
      books.buyAeth.error || books.sellAeth.error || "book_offers failed"
    );
  }
  const pool = poolSides(amm.amount, amm.amount2);
  if (!pool) throw new ResourceError("amm_info did not return an AETH/XRP pool");
  const spot = pool.xrp / pool.aeth;
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new ResourceError("AMM spot is not a positive number");
  }

  const askOf = (offer: OfferRow) => xrpPerAeth(offer.takerPays, offer.takerGets);
  const bidOf = (offer: OfferRow) => xrpPerAeth(offer.takerGets, offer.takerPays);
  const w1 = WALLETS.W1.address;
  const w1Bid = bestPrice(books.sellAeth.offers, bidOf, w1);
  const w1Ask = bestPrice(books.buyAeth.offers, askOf, w1);
  const bookBid = bestPrice(books.sellAeth.offers, bidOf);
  const bookAsk = bestPrice(books.buyAeth.offers, askOf);

  let bid = w1Bid.price;
  let ask = w1Ask.price;
  let clobSource: "W1" | "book" | "amm-only" = "W1";
  if (bid == null || ask == null) {
    bid = bookBid.price;
    ask = bookAsk.price;
    clobSource = bid != null && ask != null ? "book" : "amm-only";
  }
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const weights = mid == null ? { amm: 1, clob: 0 } : { amm: 0.7, clob: 0.3 };
  const quote = mid == null ? spot : weights.amm * spot + weights.clob * mid;

  return {
    sku: "composition-quote",
    network: "xrpl:1",
    rpc: XRPL_HTTP,
    as_of: new Date().toISOString(),
    pair: "AETH/XRP",
    issuer: AETH_IOU.issuer,
    currency_hex: AETH_HEX,
    amm: {
      account: amm.account,
      pool_aeth: String(pool.aeth),
      pool_xrp: pool.xrp.toFixed(6),
      spot_xrp_per_aeth: fx(spot),
      trading_fee: amm.tradingFee ?? null,
      ledger_index: amm.ledgerIndex ?? null,
    },
    clob: {
      source: clobSource,
      w1,
      best_bid_xrp_per_aeth: bid == null ? null : fx(bid),
      best_ask_xrp_per_aeth: ask == null ? null : fx(ask),
      mid_xrp_per_aeth: mid == null ? null : fx(mid),
      w1_bid_levels: w1Bid.levels,
      w1_ask_levels: w1Ask.levels,
      book_bid_levels: bookBid.levels,
      book_ask_levels: bookAsk.levels,
    },
    weights,
    formula:
      mid == null
        ? "spot_amm (CLOB mid unavailable)"
        : "0.7 * spot_amm + 0.3 * mid_clob",
    quote_xrp_per_aeth: fx(quote),
    labor_units_aeth: units,
    labor_xrp: fx(quote * units),
  };
}
