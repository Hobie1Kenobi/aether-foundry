/**
 * Wall of Change merge. Read-only JSON-RPC.
 * Testnet, Devnet, and one public mainnet host.
 * The mainnet host is used for server_info, feature, and account_info
 * on allowlisted mainnet-live classic accounts.
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
import { fetchRippleHeadlines } from "./ripple-headlines";
import { fetchXHeadlines, mergePressHeadlines, readXBearerToken, type XHeadlineCache } from "./x-headlines";
import {
  CLOCK,
  PRESS_HEADLINE_LABEL,
  X_POST_LABEL,
  assertNoSecrets,
  validateProgram,
  validateSources,
  type AmendmentDots,
  type Dot,
  type MainnetLedger,
  type PressHeadline,
  type Program,
  type Source,
  type WallPayload,
} from "./wall-schema";

export const WALL_ORIGIN = "https://aether-foundry-desk.vercel.app";
export const MAINNET_NOTE =
  "Mainnet dots are read-only server_info and feature on xrplcluster.com (network id 0). Allowlisted mainnet-live accounts are read with account_info on that same host. This route does not submit.";

const FRESH_MS = 36 * 60 * 60 * 1000;
const TESTNET_HTTP = "https://s.altnet.rippletest.net:51234";
const DEVNET_HTTP = "https://s.devnet.rippletest.net:51234";
const MAINNET_HTTP = "https://xrplcluster.com/";
const MAINNET_NETWORK_ID = 0;
const READ_METHODS = new Set(["server_info", "feature", "account_info"]);
const CLASSIC_ACCOUNT_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
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
  /** Undefined reads X_BEARER_TOKEN. Null skips X. A string is used only for that request. */
  xBearerToken?: string | null;
  /** Undefined uses the module cache. Null skips it. */
  xCache?: XHeadlineCache | null;
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

function accountReadParams(url: string, params: Record<string, unknown>): Record<string, unknown> {
  let host: URL;
  try {
    host = new URL(url);
  } catch {
    throw new Error("refusing unparseable XRPL url");
  }
  const key = `${host.hostname.toLowerCase()}${host.port ? `:${host.port}` : ""}`;
  if (key !== "xrplcluster.com") throw new Error("refusing account_info host");
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== "account" || keys[1] !== "ledger_index") {
    throw new Error("refusing account_info params");
  }
  if (params.ledger_index !== "validated") throw new Error("refusing account_info ledger");
  if (typeof params.account !== "string" || !CLASSIC_ACCOUNT_RE.test(params.account)) {
    throw new Error("refusing account_info account");
  }
  return { account: params.account, ledger_index: "validated" };
}

async function rpc(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  if (!READ_METHODS.has(method)) throw new Error("refusing XRPL method");
  assertAllowedHost(url);
  const bodyParams = method === "account_info" ? accountReadParams(url, params) : null;
  if (method !== "account_info" && Object.keys(params).length !== 0) throw new Error("refusing XRPL params");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [bodyParams ?? {}] }),
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

function isRssHeadline(row: PressHeadline): boolean {
  if (row.stage !== "press" || row.onchain.kind !== "none") return false;
  if (row.label === PRESS_HEADLINE_LABEL && row.url.startsWith("https://cointelegraph.com/news/")) return true;
  return row.label === X_POST_LABEL && /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d{0,21}$/.test(row.url);
}

function headlineRssItems(headlines: PressHeadline[]): string {
  return headlines
    .filter(isRssHeadline)
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
    "    <description>Curated wire of XRPL institutional primitives and named programs. Cointelegraph items and X posts are press headlines, not on-chain claims. Not a bank leaderboard.</description>",
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

export function dropsToXrp(drops: string): string | null {
  if (!/^\d+$/.test(drops)) return null;
  const padded = drops.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-6);
  return `${whole}.${frac}`;
}

function balanceDrops(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** Curated mainnet-live classic accounts. This is the only account_info allowlist. */
export function mainnetAccountTargets(programs: Program[]): { id: string; account: string }[] {
  const out: { id: string; account: string }[] = [];
  for (const program of programs) {
    if (program.stage !== "mainnet-live") continue;
    if (!program.networks.includes("xrpl:0")) continue;
    if (program.onchain.kind !== "account") continue;
    const account = program.onchain.id;
    const url = program.onchain.url;
    if (typeof account !== "string" || !CLASSIC_ACCOUNT_RE.test(account)) continue;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) continue;
    out.push({ id: program.id, account });
  }
  return out;
}

function readAccountFacts(
  result: Record<string, unknown>,
  expected: string
): { sequence: number; balance_xrp: string } {
  if (result.validated !== true) throw new Error("account_info not validated");
  const data = result.account_data;
  if (!data || typeof data !== "object") throw new Error("account_info missing account_data");
  const rec = data as { Account?: unknown; Balance?: unknown; Sequence?: unknown };
  if (rec.Account !== expected) throw new Error("account_info account mismatch");
  if (typeof rec.Sequence !== "number" || !Number.isSafeInteger(rec.Sequence) || rec.Sequence < 0) {
    throw new Error("account_info sequence");
  }
  const drops = balanceDrops(rec.Balance);
  if (!drops) throw new Error("account_info balance");
  const balance = dropsToXrp(drops);
  if (!balance) throw new Error("account_info balance");
  return { sequence: rec.Sequence, balance_xrp: balance };
}

async function readMainnetAccounts(
  fetchImpl: FetchLike,
  targets: { id: string; account: string }[],
  seenAt: string
): Promise<{ reads: Map<string, MainnetLedger>; missing: string[]; failed: string[] }> {
  const reads = new Map<string, MainnetLedger>();
  const missing: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    targets.map(async (target) => {
      try {
        const result = await rpc(fetchImpl, MAINNET_HTTP, "account_info", {
          account: target.account,
          ledger_index: "validated",
        });
        const facts = readAccountFacts(result, target.account);
        reads.set(target.id, { present: true, ...facts, seen_at: seenAt });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (message === "actNotFound") missing.push(target.id);
        else failed.push(target.id);
      }
    })
  );
  const order = new Map(targets.map((target, index) => [target.id, index]));
  const byOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  missing.sort(byOrder);
  failed.sort(byOrder);
  return { reads, missing, failed };
}

export function applyMainnetAccountReads(
  programs: Program[],
  reads: ReadonlyMap<string, MainnetLedger>
): Program[] {
  if (reads.size === 0) return programs;
  return programs.map((program) => {
    const ledger = reads.get(program.id);
    if (!ledger) return program;
    return { ...program, ledger };
  });
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

  const accountTargets = mainnetAccountTargets(programs);
  const seenAt = new Date(now).toISOString();
  let mainnetMode: SideMode = "failed";
  let mainnetProbe: AmendmentFile | null = null;
  const mainnetInfoTask = rpc(fetchImpl, MAINNET_HTTP, "server_info")
    .then((info) => readServer(info, MAINNET_NETWORK_ID))
    .catch(() => null);
  const mainnetFeatureTask = mainnetInfoTask.then(async (server) => {
    if (!server) {
      mainnetMode = "failed";
      mainnetProbe = null;
      degraded = true;
      notes.push("Mainnet feature probe failed. Mainnet dots stay unknown.");
      return;
    }
    try {
      const feature = await rpc(fetchImpl, MAINNET_HTTP, "feature");
      mainnetProbe = {
        probed_at: seenAt,
        build_version: server.build,
        amendments: featureRows(feature),
      };
      mainnetMode = "probe";
    } catch {
      mainnetMode = "failed";
      mainnetProbe = null;
      degraded = true;
      notes.push("Mainnet feature probe failed. Mainnet dots stay unknown.");
    }
  });
  const accountTask = mainnetInfoTask.then(async (server) => {
    if (accountTargets.length === 0) return new Map<string, MainnetLedger>();
    if (!server) {
      degraded = true;
      notes.push("Mainnet account probe was not applied. The network id read failed. Curated cards stay.");
      return new Map<string, MainnetLedger>();
    }
    const outcome = await readMainnetAccounts(fetchImpl, accountTargets, seenAt);
    if (outcome.missing.length > 0) {
      degraded = true;
      notes.push(
        `Mainnet account was not on the validated ledger for ${outcome.missing.join(", ")}. Curated cards stay.`
      );
    }
    if (outcome.failed.length > 0) {
      degraded = true;
      notes.push(`Mainnet account probe failed for ${outcome.failed.join(", ")}. Curated cards stay.`);
    }
    return outcome.reads;
  });

  const xToken = opts.xBearerToken === undefined ? readXBearerToken() : opts.xBearerToken;
  const headlineTask =
    opts.headlines === undefined
      ? fetchRippleHeadlines(fetchImpl)
      : Promise.resolve({ headlines: opts.headlines, ok: true });
  const xTask = fetchXHeadlines(fetchImpl, { token: xToken, now, cache: opts.xCache });

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

  const [ledgerReads] = await Promise.all([accountTask, mainnetFeatureTask]);

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

  const merged = applyMainnetAccountReads(
    sortNewest(applyFoundryTwins(programs, opts.status ?? null)),
    ledgerReads
  );
  const [headlineResult, xResult] = await Promise.all([headlineTask, xTask]);
  const headlines = mergePressHeadlines(
    headlineResult.ok ? headlineResult.headlines : [],
    xResult.ok ? xResult.headlines : []
  );
  if (!headlineResult.ok) {
    const tail = headlines.length === 0 && !xResult.ok ? " Headlines stay empty." : "";
    notes.push(`Cointelegraph Ripple press feed was unavailable.${tail}`);
  }
  if (!xResult.ok) {
    notes.push(
      xResult.reason === "unconfigured"
        ? "X press feed was unavailable. No X bearer is configured. X headlines stay empty."
        : "X press feed was unavailable. X headlines stay empty."
    );
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
