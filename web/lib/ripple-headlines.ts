/**
 * Public Cointelegraph Ripple RSS for the Wall ticker.
 * Fetched on the server from /api/wall. No secrets. Fail soft.
 * The desk does not sign and does not submit.
 */

import {
  PRESS_HEADLINE_ACTOR,
  PRESS_HEADLINE_LABEL,
  assertNoSecrets,
  type PressHeadline,
} from "./wall-schema";

export const RIPPLE_HEADLINE_FEED = "https://cointelegraph.com/rss/tag/ripple";
export const HEADLINE_CAP = 10;
export const HEADLINE_TIMEOUT_MS = 5000;

const MAX_FEED_CHARS = 1_500_000;
const MAX_TITLE_CHARS = 240;

export type HeadlineFetch = {
  headlines: PressHeadline[];
  ok: boolean;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ParsedItem = {
  title: string;
  url: string;
  ts: string;
};

function fromCode(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

export function decodeXml(raw: string): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decoded = withoutCdata
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => fromCode(Number(num)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagText(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

export function canonicalCointelegraphUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "cointelegraph.com" && host !== "www.cointelegraph.com") return null;
  url.hash = "";
  url.search = "";
  url.hostname = "cointelegraph.com";
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/news/") || path.length < "/news/x".length) return null;
  url.pathname = path;
  return url.toString();
}

function headlineId(url: string, used: Set<string>): string | null {
  const part = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
  const slug = part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null;
  let id = `ct-${slug}`.slice(0, 96).replace(/-+$/g, "");
  if (!/^ct-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return null;
  if (used.has(id)) {
    let n = 2;
    while (used.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  used.add(id);
  return id;
}

function banned(value: unknown): boolean {
  try {
    assertNoSecrets(value);
    return false;
  } catch {
    return true;
  }
}

function parseItems(xml: string): ParsedItem[] {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const items: ParsedItem[] = [];
  for (const block of blocks) {
    const title = tagText(block, "title");
    if (!title || title.length > MAX_TITLE_CHARS) continue;
    const url = canonicalCointelegraphUrl(tagText(block, "guid")) || canonicalCointelegraphUrl(tagText(block, "link"));
    if (!url) continue;
    const published = Date.parse(tagText(block, "pubDate"));
    if (Number.isNaN(published)) continue;
    const row = { title, url, ts: new Date(published).toISOString() };
    if (banned(row)) continue;
    items.push(row);
  }
  return items;
}

export function sanitizeHeadlines(raw: unknown): PressHeadline[] {
  if (!Array.isArray(raw)) return [];
  const out: PressHeadline[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const item = row as PressHeadline;
    if (item.stage !== "press" || item.onchain?.kind !== "none") continue;
    if (item.label !== PRESS_HEADLINE_LABEL || item.actor !== PRESS_HEADLINE_ACTOR) continue;
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > MAX_TITLE_CHARS) continue;
    if (typeof item.url !== "string" || typeof item.id !== "string" || typeof item.ts !== "string") continue;
    const url = canonicalCointelegraphUrl(item.url);
    if (!url || !/^ct-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) continue;
    if (Number.isNaN(Date.parse(item.ts))) continue;
    if (seen.has(url) || seen.has(item.id)) continue;
    const next: PressHeadline = {
      id: item.id,
      ts: new Date(item.ts).toISOString(),
      actor: PRESS_HEADLINE_ACTOR,
      title: item.title.trim(),
      stage: "press",
      onchain: { kind: "none" },
      url,
      source_title: PRESS_HEADLINE_ACTOR,
      label: PRESS_HEADLINE_LABEL,
    };
    if (banned(next)) continue;
    seen.add(url);
    seen.add(item.id);
    out.push(next);
    if (out.length >= HEADLINE_CAP) break;
  }
  return out;
}

export function parseRippleHeadlines(xml: string): PressHeadline[] {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const items = parseItems(xml);
  items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const usedIds = new Set<string>();
  const headlines: PressHeadline[] = [];
  for (const item of items) {
    if (headlines.length >= HEADLINE_CAP) break;
    const titleKey = item.title.toLowerCase();
    if (seenUrl.has(item.url) || seenTitle.has(titleKey)) continue;
    const id = headlineId(item.url, usedIds);
    if (!id) continue;
    seenUrl.add(item.url);
    seenTitle.add(titleKey);
    const row: PressHeadline = {
      id,
      ts: item.ts,
      actor: PRESS_HEADLINE_ACTOR,
      title: item.title,
      stage: "press",
      onchain: { kind: "none" },
      url: item.url,
      source_title: PRESS_HEADLINE_ACTOR,
      label: PRESS_HEADLINE_LABEL,
    };
    if (banned(row)) continue;
    headlines.push(row);
  }
  return headlines;
}

function isRippleFeedResponse(raw: string): boolean {
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "cointelegraph.com" &&
      url.pathname === "/rss/tag/ripple"
    );
  } catch {
    return false;
  }
}

export async function fetchRippleHeadlines(fetchImpl: FetchLike): Promise<HeadlineFetch> {
  try {
    const res = await fetchImpl(RIPPLE_HEADLINE_FEED, {
      method: "GET",
      headers: {
        accept: "application/rss+xml, application/xml, text/xml",
        "user-agent": "AetherFoundryDesk/1.0",
      },
      signal: AbortSignal.timeout(HEADLINE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok || !isRippleFeedResponse(res.url || "")) {
      return { headlines: [], ok: false };
    }
    const text = await res.text();
    if (!text || text.length > MAX_FEED_CHARS) return { headlines: [], ok: false };
    const headlines = parseRippleHeadlines(text);
    if (headlines.length === 0 && !/<item\b/i.test(text)) return { headlines: [], ok: false };
    return { headlines, ok: true };
  } catch {
    return { headlines: [], ok: false };
  }
}
