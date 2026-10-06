/**
 * Read-only net-chat surface for the desk.
 * Hellos and sessions come from lab files or the public git snapshot.
 * This module does not sign and does not submit.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const NETWORK = "xrpl:1";
export const W3 = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
export const DESK = "read-only";
export const SIGNING = "none";

const HASH_RE = /^[A-F0-9]{64}$/;
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const GIT_REPO = "Hobie1Kenobi/aether-foundry";
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SEED_RE = /sEd[1-9A-HJ-NP-Za-km-z]{20,}/;

export type HelloPublic = {
  network: string;
  account: string;
  hash: string;
  ledger: number | null;
  seen_at: string | null;
  repo: string | null;
  x402: string | null;
};

export type SessionPublic = {
  network: string;
  session: string | null;
  state: string | null;
  peer: string | null;
  from: string | null;
  hash: string;
  topic: string | null;
  synthetic: boolean;
  ledger_claim: boolean;
  seen_at: string | null;
};

export type NetSurface = {
  network: typeof NETWORK;
  desk: typeof DESK;
  signing: typeof SIGNING;
  w3: typeof W3;
  source: string;
  hellos: HelloPublic[];
  sessions: SessionPublic[];
  note: string | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function parseJsonl(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as unknown);
    } catch {
      continue;
    }
  }
  return rows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (!value || value.length > max) return null;
  if (SEED_RE.test(value)) return null;
  if (/seed|secret|private/i.test(value)) return null;
  return value;
}

function hashOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hash = value.toUpperCase();
  return HASH_RE.test(hash) ? hash : null;
}

export function toHellos(rows: unknown[], limit = 40): HelloPublic[] {
  const out: HelloPublic[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec || rec.network !== NETWORK) continue;
    if (SEED_RE.test(JSON.stringify(rec))) continue;
    const hash = hashOf(rec.hash);
    const account = typeof rec.account === "string" && ADDRESS_RE.test(rec.account) ? rec.account : null;
    if (!hash || !account) continue;
    const memo = asRecord(rec.memo);
    const ledger = Number.isInteger(rec.ledger) ? Number(rec.ledger) : null;
    out.push({
      network: NETWORK,
      account,
      hash,
      ledger,
      seen_at: safeString(rec.seen_at, 40),
      repo: safeString(memo && memo.repo, 180),
      x402: safeString(memo && memo.x402, 180),
    });
  }
  return out.slice(-limit);
}

export function toSessions(rows: unknown[], limit = 40): SessionPublic[] {
  const out: SessionPublic[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec || rec.network !== NETWORK) continue;
    if (SEED_RE.test(JSON.stringify(rec))) continue;
    const hash = hashOf(rec.hash);
    if (!hash) continue;
    const peer = typeof rec.peer === "string" && ADDRESS_RE.test(rec.peer) ? rec.peer : null;
    out.push({
      network: NETWORK,
      session: safeString(rec.session, 32),
      state: safeString(rec.state, 16),
      peer,
      from: safeString(rec.from, 32),
      hash,
      topic: safeString(rec.topic, 80),
      synthetic: rec.synthetic === true,
      ledger_claim: rec.ledger_claim === true && rec.synthetic !== true,
      seen_at: safeString(rec.seen_at, 40),
    });
  }
  return out.slice(-limit);
}

export function surfaceFromTexts(hellosText: string | null, sessionsText: string | null, source: string): NetSurface {
  const hellos = toHellos(parseJsonl(hellosText || ""));
  const sessions = toSessions(parseJsonl(sessionsText || ""));
  const missing = hellosText == null && sessionsText == null;
  return {
    network: NETWORK,
    desk: DESK,
    signing: SIGNING,
    w3: W3,
    source,
    hellos,
    sessions,
    note: missing ? "No hello or session file is on this disk yet." : null,
  };
}

function readLocal(name: string): string | null {
  const candidates = [
    path.join(process.cwd(), "lab", "peers", name),
    path.join(process.cwd(), "..", "lab", "peers", name),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      return readFileSync(file, "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchGitText(fetchImpl: FetchLike, rel: string): Promise<string | null> {
  try {
    const head = await fetchImpl(`https://api.github.com/repos/${GIT_REPO}/commits/main`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "aether-foundry-desk",
      },
    });
    if (!head.ok) return null;
    const meta = (await head.json()) as { sha?: string };
    const sha = String(meta.sha || "").toLowerCase();
    if (!GIT_SHA_RE.test(sha)) return null;
    const file = await fetchImpl(`https://raw.githubusercontent.com/${GIT_REPO}/${sha}/${rel}`, {
      method: "GET",
      headers: { "user-agent": "aether-foundry-desk" },
    });
    if (file.status === 404) return "";
    if (!file.ok) return null;
    return await file.text();
  } catch {
    return null;
  }
}

export async function loadNetChat(opts?: { fetchImpl?: FetchLike | null }): Promise<NetSurface> {
  let hellos = readLocal("hellos.jsonl");
  let sessions = readLocal("sessions.jsonl");
  let source = "lab/peers";
  const fetchImpl = opts && "fetchImpl" in opts ? opts.fetchImpl : fetch;
  if ((hellos == null || sessions == null) && typeof fetchImpl === "function") {
    if (hellos == null) {
      const remote = await fetchGitText(fetchImpl, "lab/peers/hellos.jsonl");
      if (remote != null) {
        hellos = remote;
        source = "git";
      }
    }
    if (sessions == null) {
      const remote = await fetchGitText(fetchImpl, "lab/peers/sessions.jsonl");
      if (remote != null) source = source === "git" ? "git" : "lab/peers+git";
      if (remote != null) sessions = remote;
    }
  }
  return surfaceFromTexts(hellos, sessions, source);
}
