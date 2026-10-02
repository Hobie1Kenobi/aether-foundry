/**
 * X API v2 recent search for the Wall ticker.
 * Server-only bearer. Fixed query. No HTML scrape. Fail soft.
 * The desk does not sign and does not submit.
 */

import { sanitizeHeadlines } from "./ripple-headlines";
import {
  X_POST_LABEL,
  X_POST_SOURCE,
  assertNoSecrets,
  type PressHeadline,
} from "./wall-schema";

export const X_SEARCH_ENDPOINT = "https://api.x.com/2/tweets/search/recent";
/** Official accounts in the fixed query. RippleXDev is the engineering account. */
export const X_ACCOUNT_ALLOWLIST = ["Ripple", "RippleXDev", "RippleX", "bgarlinghouse"] as const;
export const X_HEADLINE_QUERY = `(from:${X_ACCOUNT_ALLOWLIST.join(" OR from:")} OR Ripple OR RLUSD OR XRPL) -is:retweet -is:reply lang:en`;
export const X_HEADLINE_MAX = 10;
export const X_HEADLINE_TIMEOUT_MS = 5000;
/** Short memory cache so a warm server does not repeat the recent-search call. */
export const X_HEADLINE_CACHE_MS = 3 * 60 * 1000;
export const MERGED_HEADLINE_CAP = 15;

const MAX_BODY_CHARS = 1_000_000;
const MAX_TITLE_CHARS = 240;
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID_RE = /^[1-9]\d{0,21}$/;
const TOPIC_RE = /\b(?:ripple|rlusd|xrpl|xrp)\b/i;
const ALLOWED_ACCOUNTS = new Set(X_ACCOUNT_ALLOWLIST.map((name) => name.toLowerCase()));

export type XHeadlineFetch = {
  headlines: PressHeadline[];
  ok: boolean;
  reason?: "unconfigured" | "failed";
};

export type XHeadlineCache = {
  slot: { at: number; key: string; result: XHeadlineFetch } | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const sharedCache: XHeadlineCache = { slot: null };

export function clearXHeadlineCache(): void {
  sharedCache.slot = null;
}

export function readXBearerToken(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN || "").trim();
  if (raw.length < 20 || raw.length > 400) return null;
  if (/[^\x21-\x7E]/.test(raw)) return null;
  return raw;
}

export function xRecentSearchUrl(): string {
  const url = new URL(X_SEARCH_ENDPOINT);
  url.searchParams.set("query", X_HEADLINE_QUERY);
  url.searchParams.set("max_results", String(X_HEADLINE_MAX));
  url.searchParams.set("tweet.fields", "created_at,author_id,lang,referenced_tweets");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");
  return url.toString();
}

export function isXSearchUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "api.x.com" && url.pathname === "/2/tweets/search/recent";
  } catch {
    return false;
  }
}

export function canonicalXStatusUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "x.com" && host !== "www.x.com") return null;
  if (url.search || url.hash) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[1] !== "status") return null;
  const username = parts[0];
  const id = parts[2];
  if (!USERNAME_RE.test(username) || !TWEET_ID_RE.test(id)) return null;
  return `https://x.com/${username}/status/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function banned(value: unknown): boolean {
  try {
    assertNoSecrets(value);
    return false;
  } catch {
    return true;
  }
}

function tokenHash(token: string): string {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function clipTitle(raw: string): string | null {
  const flat = raw
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat || flat.startsWith("RT @")) return null;
  const chars = Array.from(flat);
  if (chars.length <= MAX_TITLE_CHARS) return flat;
  const cut = chars.slice(0, MAX_TITLE_CHARS - 1).join("").trimEnd();
  if (!cut) return null;
  return `${cut}…`;
}

function isShareOrReply(row: Record<string, unknown>): boolean {
  if (!Array.isArray(row.referenced_tweets)) return false;
  return row.referenced_tweets.some((ref) => {
    if (!isRecord(ref)) return false;
    return ref.type === "retweeted" || ref.type === "replied_to";
  });
}

function userNames(body: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  if (!isRecord(body.includes) || !Array.isArray(body.includes.users)) return map;
  for (const user of body.includes.users) {
    if (!isRecord(user)) continue;
    if (typeof user.id !== "string" || typeof user.username !== "string") continue;
    if (!USERNAME_RE.test(user.username)) continue;
    if (!map.has(user.id)) map.set(user.id, user.username);
  }
  return map;
}

function onTopic(username: string, text: string): boolean {
  if (ALLOWED_ACCOUNTS.has(username.toLowerCase())) return true;
  return TOPIC_RE.test(text);
}

export function parseXHeadlines(body: unknown, token: string | null = null): PressHeadline[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const names = userNames(body);
  const rows: PressHeadline[] = [];
  const seen = new Set<string>();
  for (const entry of body.data) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || !TWEET_ID_RE.test(entry.id)) continue;
    if (typeof entry.text !== "string") continue;
    if (token && entry.text.includes(token)) continue;
    if (isShareOrReply(entry)) continue;
    if (typeof entry.lang === "string" && entry.lang !== "en") continue;
    if (typeof entry.author_id !== "string") continue;
    const username = names.get(entry.author_id);
    if (!username) continue;
    const title = clipTitle(entry.text);
    if (!title || !onTopic(username, title)) continue;
    if (typeof entry.created_at !== "string") continue;
    const published = Date.parse(entry.created_at);
    if (Number.isNaN(published)) continue;
    const url = canonicalXStatusUrl(`https://x.com/${username}/status/${entry.id}`);
    if (!url) continue;
    const id = `x-${entry.id}`;
    if (seen.has(url) || seen.has(id)) continue;
    const row: PressHeadline = {
      id,
      ts: new Date(published).toISOString(),
      actor: `@${username}`,
      title,
      stage: "press",
      onchain: { kind: "none" },
      url,
      source_title: X_POST_SOURCE,
      label: X_POST_LABEL,
    };
    if (banned(row)) continue;
    seen.add(url);
    seen.add(id);
    rows.push(row);
  }
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.id.localeCompare(b.id));
  return rows.slice(0, X_HEADLINE_MAX);
}

export function sanitizeXHeadlines(raw: unknown): PressHeadline[] {
  if (!Array.isArray(raw)) return [];
  const out: PressHeadline[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const item = row as PressHeadline;
    if (item.stage !== "press" || item.onchain?.kind !== "none") continue;
    if (item.label !== X_POST_LABEL || item.source_title !== X_POST_SOURCE) continue;
    if (typeof item.actor !== "string" || !/^@[A-Za-z0-9_]{1,15}$/.test(item.actor)) continue;
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > MAX_TITLE_CHARS) continue;
    if (typeof item.url !== "string" || typeof item.id !== "string" || typeof item.ts !== "string") continue;
    if (!/^x-[1-9]\d{0,21}$/.test(item.id)) continue;
    const url = canonicalXStatusUrl(item.url);
    const handle = item.actor.slice(1);
    const tweetId = item.id.slice(2);
    if (!url || url !== `https://x.com/${handle}/status/${tweetId}`) continue;
    if (Number.isNaN(Date.parse(item.ts))) continue;
    if (seen.has(url) || seen.has(item.id)) continue;
    const next: PressHeadline = {
      id: item.id,
      ts: new Date(item.ts).toISOString(),
      actor: item.actor,
      title: item.title.trim(),
      stage: "press",
      onchain: { kind: "none" },
      url,
      source_title: X_POST_SOURCE,
      label: X_POST_LABEL,
    };
    if (banned(next)) continue;
    seen.add(url);
    seen.add(item.id);
    out.push(next);
  }
  out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.id.localeCompare(b.id));
  return out.slice(0, X_HEADLINE_MAX);
}

export function mergePressHeadlines(cointelegraph: unknown, xPosts: unknown): PressHeadline[] {
  const rows = [...sanitizeHeadlines(cointelegraph), ...sanitizeXHeadlines(xPosts)];
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const out: PressHeadline[] = [];
  for (const row of rows) {
    const urlKey = row.url.toLowerCase();
    if (seen.has(urlKey) || seen.has(row.id)) continue;
    seen.add(urlKey);
    seen.add(row.id);
    out.push(row);
    if (out.length >= MERGED_HEADLINE_CAP) break;
  }
  return out;
}

function copyResult(result: XHeadlineFetch): XHeadlineFetch {
  return { ...result, headlines: result.headlines.slice() };
}

function unconfigured(): XHeadlineFetch {
  return { headlines: [], ok: false, reason: "unconfigured" };
}

function failed(): XHeadlineFetch {
  return { headlines: [], ok: false, reason: "failed" };
}

export async function fetchXHeadlines(
  fetchImpl: FetchLike,
  opts: {
    token?: string | null;
    now?: number;
    env?: Record<string, string | undefined>;
    cache?: XHeadlineCache | null;
  } = {}
): Promise<XHeadlineFetch> {
  const token = opts.token === undefined ? readXBearerToken(opts.env) : opts.token ? readXBearerToken({ X_BEARER_TOKEN: opts.token }) : null;
  if (!token) return unconfigured();
  const now = opts.now ?? Date.now();
  const memory = opts.cache === undefined ? sharedCache : opts.cache;
  const key = tokenHash(token);
  if (memory && memory.slot && memory.slot.key === key && now >= memory.slot.at && now - memory.slot.at < X_HEADLINE_CACHE_MS) {
    return copyResult(memory.slot.result);
  }
  const endpoint = xRecentSearchUrl();
  if (!isXSearchUrl(endpoint) || endpoint.includes(token)) return failed();
  try {
    const res = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "AetherFoundryDesk/1.0",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(X_HEADLINE_TIMEOUT_MS),
    });
    if (!res.ok || (res.url && !isXSearchUrl(res.url))) return remember(memory, now, key, failed());
    const text = await res.text();
    if (!text || text.length > MAX_BODY_CHARS || text.includes(token)) return remember(memory, now, key, failed());
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return remember(memory, now, key, failed());
    }
    if (!isRecord(json)) return remember(memory, now, key, failed());
    if (!Array.isArray(json.data)) {
      const meta = isRecord(json.meta) ? json.meta : null;
      if (meta && meta.result_count === 0 && !json.errors) {
        return remember(memory, now, key, { headlines: [], ok: true });
      }
      return remember(memory, now, key, failed());
    }
    const headlines = parseXHeadlines(json, token);
    if (JSON.stringify(headlines).includes(token)) return remember(memory, now, key, failed());
    return remember(memory, now, key, { headlines, ok: true });
  } catch {
    return remember(memory, now, key, failed());
  }
}

function remember(memory: XHeadlineCache | null, at: number, key: string, result: XHeadlineFetch): XHeadlineFetch {
  if (memory) memory.slot = { at, key, result };
  return copyResult(result);
}
