/**
 * Wall of Change merge. Read-only JSON-RPC.
 * Testnet, Devnet, and one public mainnet host.
 * The mainnet host is used for server_info and feature only.
 * A failed probe never becomes enabled.
 * The desk does not sign and does not submit.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import programsJson from "../../lab/wall/programs.json" with { type: "json" };
import sourcesJson from "../../lab/wall/sources.json" with { type: "json" };
import lastSeenJson from "../../lab/wall/last-seen.json" with { type: "json" };
import testnetJson from "../../lab/frontier/amendments.json" with { type: "json" };
import devnetJson from "../../lab/frontier/amendments-devnet.json" with { type: "json" };
import { fetchRippleHeadlines, sanitizeHeadlines } from "./ripple-headlines";
import {
  CLOCK,
  PRESS_HEADLINE_LABEL,
  assertNoSecrets,
  validateProgram,
  validateSources,
  type AmendmentDots,
  type Dot,
  type PressHeadline,
  type Program,
  type Source,
  type WallPayload,
} from "./wall-schema";

export const WALL_ORIGIN = "https://aether-foundry-desk.vercel.app";
export const MAINNET_NOTE =
  "Mainnet dots are read-only server_info and feature on xrplcluster.com (network id 0). This route does not submit.";

const FRESH_MS = 36 * 60 * 60 * 1000;
const TESTNET_HTTP = "https://s.altnet.rippletest.net:51234";
const DEVNET_HTTP = "https://s.devnet.rippletest.net:51234";
const MAINNET_HTTP = "https://xrplcluster.com/";
const MAINNET_NETWORK_ID = 0;
const READ_METHODS = new Set(["server_info", "feature"]);
const ALLOWED_HOSTS = new Set([
  "s.altnet.rippletest.net:51234",
  "s.devnet.rippletest.net:51234",
  "xrplcluster.com",
]);

const LIVE_TWINS = new Set([
  "foundry-heartbeat",
  "foundry-oracle",
  "foundry-labor-mpt",
  "foundry-credential-domain",
]);

type AmendmentRow = { name: string; enabled: boolean; majority: unknown };
type AmendmentFile = {
  probed_at?: string;
  build_version?: string;
  amendments?: AmendmentRow[];
};

type LastSeenFile = {
  amendments?: Record<string, Partial<AmendmentDots>>;
};

export type DeskTwins = {
  last_heartbeat?: { hash?: string | null; ts?: string | null } | null;
  oracle_id?: string | null;
  mpt_issuance_id?: string | null;
  domain_id?: string | null;
};

type SideMode = "file" | "probe" | "failed";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type BuildWallOptions = {
  now?: number;
  fetch?: FetchLike;
  status?: DeskTwins | null;
  programs?: unknown;
  sources?: unknown;
  testnetFile?: unknown;
  devnetFile?: unknown;
  lastSeen?: unknown;
  /** When set, skip the public RSS fetch and use this list (still sanitized). */
  headlines?: PressHeadline[];
};

function readLab(rel: string, fallback: unknown): unknown {
  const candidates = [
    path.resolve(process.cwd(), rel),
    path.resolve(process.cwd(), "..", rel),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch {
      continue;
    }
  }
  return fallback;
}

export function isFresh(probedAt: unknown, now: number): boolean {
  if (typeof probedAt !== "string") return false;
  const t = Date.parse(probedAt);
  if (Number.isNaN(t)) return false;
  const age = now - t;
  return age >= 0 && age < FRESH_MS;
}

function assertAllowedHost(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("refusing unparseable XRPL url");
  }
  if (url.protocol !== "https:") throw new Error("refusing non-https XRPL url");
  if (url.username || url.password) throw new Error("refusing XRPL url with userinfo");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("refusing XRPL url path");
  if (url.search || url.hash) throw new Error("refusing XRPL url query");
  const key = `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
  if (!ALLOWED_HOSTS.has(key)) throw new Error("refusing non-allowlisted XRPL host");
}

async function rpc(fetchImpl: FetchLike, url: string, method: string): Promise<Record<string, unknown>> {
  if (!READ_METHODS.has(method)) throw new Error("refusing XRPL method");
  assertAllowedHost(url);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [{}] }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
  const body = (await res.json()) as { result?: Record<string, unknown> };
  const result = body?.result;
  if (!result || typeof result !== "object") throw new Error("rpc omitted result");
  if (typeof result.error === "string") throw new Error(result.error);
  return result;
}

function networkId(info: Record<string, unknown>): number | null {
  const inner = info.info;
  if (!inner || typeof inner !== "object") return null;
  const id = (inner as { network_id?: unknown }).network_id;
  if (id == null || id === "") return null;
  const num = Number(id);
  return Number.isInteger(num) ? num : null;
}

function readServer(info: Record<string, unknown>, expected: number): { build: string; ledger: number | null } {
  const id = networkId(info);
  if (id !== expected) throw new Error(`refusing network id ${id == null ? "missing" : id}`);
  const inner = info.info as { build_version?: unknown; validated_ledger?: { seq?: unknown } };
  if (typeof inner.build_version !== "string" || !inner.build_version.trim()) {
    throw new Error("server_info omitted build_version");
  }
  const seq = inner.validated_ledger?.seq;
  const ledger = Number.isInteger(seq) && Number(seq) > 0 ? Number(seq) : null;
  return { build: inner.build_version, ledger };
}

function featureRows(feature: Record<string, unknown>): AmendmentRow[] {
  const raw = feature.features;
  if (!raw || typeof raw !== "object") throw new Error("feature omitted features");
  const list = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
  const rows: AmendmentRow[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { name?: unknown; enabled?: unknown; majority?: unknown };
    if (typeof rec.name !== "string" || typeof rec.enabled !== "boolean") continue;
    rows.push({ name: rec.name, enabled: rec.enabled, majority: rec.majority ?? null });
  }
  if (rows.length === 0) throw new Error("feature omitted boolean amendment flags");
  return rows;
}

async function probeNetwork(fetchImpl: FetchLike, url: string, expected: number): Promise<AmendmentFile & { ledger_index: number | null }> {
  const info = await rpc(fetchImpl, url, "server_info");
  const server = readServer(info, expected);
  const feature = await rpc(fetchImpl, url, "feature");
  return {
    probed_at: new Date().toISOString(),
    build_version: server.build,
    ledger_index: server.ledger,
    amendments: featureRows(feature),
  };
}

function indexRows(file: AmendmentFile | null): Map<string, AmendmentRow> {
  const map = new Map<string, AmendmentRow>();
  if (!file || !Array.isArray(file.amendments)) return map;
  for (const row of file.amendments) {
    if (!row || typeof row.name !== "string" || typeof row.enabled !== "boolean") continue;
    map.set(row.name, row);
  }
  return map;
}

function dotFrom(row: AmendmentRow | undefined): Dot {
  if (!row || typeof row.enabled !== "boolean") return "unknown";
  if (row.enabled === true) return "on";
  if (row.majority != null && row.majority !== false) return "voting";
  return "off";
}

export function resolveAmendmentDots(input: {
  names: string[];
  testnetMode: SideMode;
  testnetFile: AmendmentFile | null;
  testnetProbe: AmendmentFile | null;
  devnetMode: SideMode;
  devnetFile: AmendmentFile | null;
  devnetProbe: AmendmentFile | null;
  mainnetMode?: SideMode;
  mainnetFile?: AmendmentFile | null;
  mainnetProbe?: AmendmentFile | null;
}): Record<string, AmendmentDots> {
  const testnet =
    input.testnetMode === "probe" ? indexRows(input.testnetProbe) : indexRows(input.testnetFile);
  const devnet = input.devnetMode === "probe" ? indexRows(input.devnetProbe) : indexRows(input.devnetFile);
  const mainnetMode = input.mainnetMode ?? "failed";
  const mainnet =
    mainnetMode === "probe" ? indexRows(input.mainnetProbe ?? null) : indexRows(input.mainnetFile ?? null);
  const out: Record<string, AmendmentDots> = {};
  for (const name of input.names) {
    out[name] = {
      testnet: dotFrom(testnet.get(name)),
      devnet: dotFrom(devnet.get(name)),
      mainnet: dotFrom(mainnet.get(name)),
    };
  }
  return out;
}

function asFile(raw: unknown): AmendmentFile | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as AmendmentFile;
}

function hexId(value: unknown, length: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toUpperCase();
  if (!new RegExp(`^[0-9A-F]{${length}}$`).test(text)) return null;
  return text;
}

function explorerTx(id: string): string {
  return `https://testnet.xrpl.org/transactions/${id}`;
}

function explorerSearch(id: string): string {
  return `https://testnet.xrpl.org/search/${id}`;
}

function explorerMpt(id: string): string {
  return `https://testnet.xrpl.org/mpt/${id}`;
}

export function applyFoundryTwins(programs: Program[], status: DeskTwins | null): Program[] {
  return programs.map((program) => {
    if (!LIVE_TWINS.has(program.id)) return program;
    const next: Program = {
      ...program,
      onchain: { kind: "none" },
    };
    if (!status) return next;
    if (program.id === "foundry-heartbeat") {
      const id = hexId(status.last_heartbeat?.hash, 64);
      const ts = status.last_heartbeat?.ts;
      if (!id) return next;
      next.onchain = { kind: "tx", id, url: explorerTx(id) };
      if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) next.ts = ts;
      return next;
    }
    if (program.id === "foundry-oracle") {
      const id = hexId(status.oracle_id, 64);
      if (!id) return next;
      next.onchain = { kind: "object", id, url: explorerSearch(id) };
      return next;
    }
    if (program.id === "foundry-labor-mpt") {
      const id = hexId(status.mpt_issuance_id, 48);
      if (!id) return next;
      next.onchain = { kind: "object", id, url: explorerMpt(id) };
      return next;
    }
    const id = hexId(status.domain_id, 64);
    if (!id) return next;
    next.onchain = { kind: "object", id, url: explorerSearch(id) };
    return next;
  });
}

function sortNewest(programs: Program[]): Program[] {
  return programs.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

function changedSince(dots: Record<string, AmendmentDots>, lastSeen: LastSeenFile | null): boolean {
  const rows = lastSeen?.amendments || {};
  for (const name of Object.keys(dots)) {
    const prev = rows[name];
    const cur = dots[name];
    if (!prev) return true;
    if (prev.testnet !== cur.testnet || prev.devnet !== cur.devnet || prev.mainnet !== cur.mainnet) {
      return true;
    }
  }
  return false;
}

export function pulledLabel(iso: string | null, now: number): string {
  if (!iso) return "pulled —";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "pulled —";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 90) return `pulled ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 90) return `pulled ${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `pulled ${hr}h ago`;
  const day = Math.round(hr / 24);
  return `pulled ${day}d ago`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rssItem(parts: {
  title: string;
  link: string;
  guid: string;
  permalink: boolean;
  pubDate: string;
  description: string;
  category?: string;
}): string {
  const category = parts.category ? `\n      <category>${xmlEscape(parts.category)}</category>` : "";
  return [
    "    <item>",
    `      <title>${xmlEscape(parts.title)}</title>`,
    `      <link>${xmlEscape(parts.link)}</link>`,
    `      <guid isPermaLink="${parts.permalink ? "true" : "false"}">${xmlEscape(parts.guid)}</guid>`,
    `      <pubDate>${parts.pubDate}</pubDate>`,
    `      <description>${xmlEscape(parts.description)}</description>${category}`,
    "    </item>",
  ].join("\n");
}

function pubDateOrEpoch(iso: string): string {
  const pub = new Date(iso);
  return Number.isNaN(pub.getTime()) ? new Date(0).toUTCString() : pub.toUTCString();
}

function headlineRssItems(headlines: PressHeadline[]): string {
  return headlines
    .filter(
      (row) =>
        row.stage === "press" &&
        row.onchain.kind === "none" &&
        row.label === PRESS_HEADLINE_LABEL &&
        row.url.startsWith("https://cointelegraph.com/news/")
    )
    .map((row) =>
      rssItem({
        title: `Press · ${row.actor} — ${row.title}`,
        link: row.url,
        guid: row.url,
        permalink: true,
        pubDate: pubDateOrEpoch(row.ts),
        description: `${row.label} ${row.title}`,
        category: "press",
      })
    )
    .join("\n");
}

export function renderRss(
  programs: Program[],
  generatedAt: string,
  headlines: PressHeadline[] = []
): string {
  const items = sortNewest(programs.filter((program) => program.stage !== "rumor"));
  const programBody = items
    .map((program) =>
      rssItem({
        title: `${program.actor} — ${program.claim}`,
        link: `${WALL_ORIGIN}/wall#${program.id}`,
        guid: program.id,
        permalink: false,
        pubDate: pubDateOrEpoch(program.ts),
        description: `${program.claim} Stage ${program.stage}. Rail ${program.networks.join(", ")}.`,
      })
    )
    .join("\n");
  const headlineBody = headlineRssItems(headlines);
  const body = [headlineBody, programBody].filter(Boolean).join("\n");
  const built = new Date(generatedAt);
  const lastBuildDate = Number.isNaN(built.getTime()) ? new Date(0).toUTCString() : built.toUTCString();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    "    <title>Aether Foundry — Wall of Change</title>",
    `    <link>${WALL_ORIGIN}/wall</link>`,
    "    <description>Curated wire of XRPL institutional primitives and named programs. Cointelegraph items are press headlines, not on-chain claims. Not a bank leaderboard.</description>",
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    body,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

export function downWall(now = Date.now()): WallPayload {
  const amendments: Record<string, AmendmentDots> = {};
  for (const row of CLOCK) {
    amendments[row.name] = { testnet: "unknown", devnet: "unknown", mainnet: "unknown" };
  }
  return {
    generated_at: new Date(now).toISOString(),
    ledger_index: null,
    server_build: null,
    amendments,
    programs: [],
    headlines: [],
    wire_status: "down",
    amendment_changed: false,
    mainnet_note: MAINNET_NOTE,
    pulled_label: "pulled —",
    sources: {},
    probe_notes: ["Wire read failed."],
  };
}

export async function buildWall(opts: BuildWallOptions = {}): Promise<WallPayload> {
  const now = opts.now == null ? Date.now() : opts.now;
  const fetchImpl = opts.fetch || fetch;
  const sources = validateSources(
    opts.sources === undefined ? readLab("lab/wall/sources.json", sourcesJson) : opts.sources
  );
  const rawPrograms =
    opts.programs === undefined ? readLab("lab/wall/programs.json", programsJson) : opts.programs;
  if (!Array.isArray(rawPrograms)) throw new Error("programs.json must be an array");
  const programs = rawPrograms.map((row) => validateProgram(row, sources));
  const testnetFile = asFile(
    opts.testnetFile === undefined ? readLab("lab/frontier/amendments.json", testnetJson) : opts.testnetFile
  );
  const devnetFile = asFile(
    opts.devnetFile === undefined
      ? readLab("lab/frontier/amendments-devnet.json", devnetJson)
      : opts.devnetFile
  );
  const lastSeen = (
    opts.lastSeen === undefined ? readLab("lab/wall/last-seen.json", lastSeenJson) : opts.lastSeen
  ) as LastSeenFile | null;

  const notes: string[] = [];
  let degraded = opts.status == null;
  if (opts.status == null) notes.push("Desk status was unavailable. Foundry twin ids were not attached.");

  let mainnetMode: SideMode = "failed";
  let mainnetProbe: AmendmentFile | null = null;
  const mainnetTask = probeNetwork(fetchImpl, MAINNET_HTTP, MAINNET_NETWORK_ID)
    .then((probed) => {
      mainnetProbe = probed;
      mainnetMode = "probe";
    })
    .catch(() => {
      mainnetMode = "failed";
      mainnetProbe = null;
      degraded = true;
      notes.push("Mainnet feature probe failed. Mainnet dots stay unknown.");
    });

  const headlineTask =
    opts.headlines === undefined
      ? fetchRippleHeadlines(fetchImpl)
      : Promise.resolve({ headlines: opts.headlines, ok: true });

  let testnetMode: SideMode = isFresh(testnetFile?.probed_at, now) ? "file" : "failed";
  let devnetMode: SideMode = isFresh(devnetFile?.probed_at, now) ? "file" : "failed";
  let testnetProbe: AmendmentFile | null = null;
  let devnetProbe: AmendmentFile | null = null;
  let ledger: number | null = null;
  let build = typeof testnetFile?.build_version === "string" ? testnetFile.build_version : null;
  let pulledAt = typeof testnetFile?.probed_at === "string" ? testnetFile.probed_at : null;

  if (testnetMode === "file") {
    try {
      const info = await rpc(fetchImpl, TESTNET_HTTP, "server_info");
      const server = readServer(info, 1);
      ledger = server.ledger;
      build = server.build;
    } catch {
      degraded = true;
      notes.push("Testnet server_info failed. Ledger index stays unknown.");
    }
  } else {
    try {
      const probed = await probeNetwork(fetchImpl, TESTNET_HTTP, 1);
      testnetProbe = probed;
      testnetMode = "probe";
      ledger = probed.ledger_index;
      build = probed.build_version || build;
      pulledAt = probed.probed_at || pulledAt;
    } catch {
      testnetMode = "failed";
      degraded = true;
      notes.push("Testnet feature probe failed. Dots stay on the last file or unknown.");
    }
  }

  if (devnetMode !== "file") {
    try {
      devnetProbe = await probeNetwork(fetchImpl, DEVNET_HTTP, 2);
      devnetMode = "probe";
    } catch {
      devnetMode = "failed";
      degraded = true;
      notes.push("Devnet feature probe failed. Dots stay on the last file or unknown.");
    }
  }

  await mainnetTask;

  const amendments = resolveAmendmentDots({
    names: CLOCK.map((row) => row.name),
    testnetMode,
    testnetFile,
    testnetProbe,
    devnetMode,
    devnetFile,
    devnetProbe,
    mainnetMode,
    mainnetFile: null,
    mainnetProbe,
  });

  const merged = sortNewest(applyFoundryTwins(programs, opts.status ?? null));
  const headlineResult = await headlineTask;
  const headlines = sanitizeHeadlines(headlineResult.ok ? headlineResult.headlines : []);
  if (!headlineResult.ok) {
    notes.push("Cointelegraph Ripple press feed was unavailable. Headlines stay empty.");
  }
  assertNoSecrets({ amendments, programs: merged, sources, notes, headlines });

  return {
    generated_at: new Date(now).toISOString(),
    ledger_index: ledger,
    server_build: build,
    amendments,
    programs: merged,
    headlines,
    wire_status: degraded ? "degraded" : "ok",
    amendment_changed: changedSince(amendments, lastSeen),
    mainnet_note: MAINNET_NOTE,
    pulled_label: pulledLabel(pulledAt, now),
    sources,
    probe_notes: notes,
  };
}
