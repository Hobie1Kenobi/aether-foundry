/**
 * Wall of Change schema. Editorial rows only.
 * Rejects mainnet-live without an explorer URL, and any seed-shaped text.
 * The desk does not sign and does not submit.
 */

export type Stage =
  | "rumor"
  | "press"
  | "sandbox"
  | "devnet"
  | "testnet"
  | "mainnet-pilot"
  | "mainnet-live";

export type Class =
  | "protocol"
  | "payments"
  | "stablecoin"
  | "rwa"
  | "lending"
  | "custody"
  | "agentic"
  | "foundry-twin";

export type Network = "xrpl:0" | "xrpl:1" | "xrpl:devnet" | "sandbox" | "other";

export type OnchainKind = "tx" | "account" | "object" | "none";

export type Dot = "on" | "off" | "voting" | "unknown";

export interface Onchain {
  kind: OnchainKind;
  url?: string;
  id?: string;
}

export interface Program {
  id: string;
  ts: string;
  actor: string;
  claim: string;
  stage: Stage;
  networks: Network[];
  class: Class;
  depends_on: string[];
  onchain: Onchain;
  foundry_twin?: string;
  sources: string[];
  last_verified: string;
}

export interface Source {
  title: string;
  url: string;
  retrieved_at: string;
}

export interface AmendmentDots {
  testnet: Dot;
  devnet: Dot;
  mainnet: Dot;
}

/** Cointelegraph Ripple tag item. A headline, not a curated program or a ledger read. */
export interface PressHeadline {
  id: string;
  ts: string;
  actor: string;
  title: string;
  stage: "press";
  onchain: { kind: "none" };
  url: string;
  source_title: string;
  label: string;
}

export const PRESS_HEADLINE_ACTOR = "Cointelegraph";
export const PRESS_HEADLINE_LABEL = "Press headline. Not on-chain.";
/** Full marquee loop. The previous 28s pass was too fast to read. */
export const WALL_TICKER_LOOP_S = 80;

export interface WallPayload {
  generated_at: string;
  ledger_index: number | null;
  server_build: string | null;
  amendments: Record<string, AmendmentDots>;
  programs: Program[];
  headlines: PressHeadline[];
  wire_status: "ok" | "degraded" | "down";
  amendment_changed: boolean;
  mainnet_note: string;
  pulled_label: string;
  sources: Record<string, Source>;
  probe_notes: string[];
}

export type WallFilter =
  | "all"
  | "on-chain"
  | "press"
  | "devnet"
  | "mainnet"
  | "foundry-twin";

export const CLOCK: { name: string; twin: string }[] = [
  { name: "BatchV1_1", twin: "F6" },
  { name: "TokenEscrow", twin: "F3" },
  { name: "Credentials", twin: "F4" },
  { name: "PermissionedDomains", twin: "F4" },
  { name: "PermissionedDEX", twin: "F4" },
  { name: "MPTokensV1", twin: "F2" },
  { name: "PriceOracle", twin: "F1" },
  { name: "DynamicNFT", twin: "F5" },
  { name: "SingleAssetVault", twin: "F9" },
  { name: "LendingProtocol", twin: "F9" },
  { name: "Sponsor", twin: "F8" },
  { name: "ConfidentialTransfer", twin: "F10" },
  { name: "DID", twin: "W0" },
];

export const TWIN_HREF: Record<string, string> = {
  F1: "/#f1",
  F2: "/#f2",
  F3: "/#f3",
  F4: "/#f4",
  F5: "/#frontier-title",
  F6: "/#f6",
  F7: "/#frontier-title",
  F8: "/#f8",
  F9: "/#f9",
  F10: "/#f10",
  W0: "/#accounts-title",
  heartbeat: "/#f6",
  x402: "/#x402-frontier",
  "Walk-In": "/#storefront-title",
};

const STAGES = new Set<Stage>([
  "rumor",
  "press",
  "sandbox",
  "devnet",
  "testnet",
  "mainnet-pilot",
  "mainnet-live",
]);

const CLASSES = new Set<Class>([
  "protocol",
  "payments",
  "stablecoin",
  "rwa",
  "lending",
  "custody",
  "agentic",
  "foundry-twin",
]);

const NETWORKS = new Set<Network>([
  "xrpl:0",
  "xrpl:1",
  "xrpl:devnet",
  "sandbox",
  "other",
]);

const KINDS = new Set<OnchainKind>(["tx", "account", "object", "none"]);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TWIN_RE = /^(F([1-9]|10)|Walk-In|x402|heartbeat|W0)$/;
const SECRET_RE = /seed|secret|private_key|sEd[0-9A-Za-z]/i;

const ON_CHAIN_STAGES = new Set<Stage>([
  "devnet",
  "testnet",
  "mainnet-pilot",
  "mainnet-live",
]);

export function assertNoSecrets(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (SECRET_RE.test(text)) {
    throw new Error("wall JSON matched a banned secret pattern");
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateSource(id: string, raw: unknown): Source {
  if (!ID_RE.test(id)) fail(`source id ${id} is not kebab-case`);
  if (!isRecord(raw)) fail(`source ${id} is not an object`);
  const title = raw.title;
  const url = raw.url;
  const retrieved = raw.retrieved_at;
  if (typeof title !== "string" || !title.trim()) fail(`source ${id} needs a title`);
  if (typeof url !== "string" || !/^https:\/\//.test(url)) {
    fail(`source ${id} needs an https url`);
  }
  if (typeof retrieved !== "string" || !DAY_RE.test(retrieved)) {
    fail(`source ${id} retrieved_at must be YYYY-MM-DD`);
  }
  return { title, url, retrieved_at: retrieved };
}

export function validateSources(raw: unknown): Record<string, Source> {
  if (!isRecord(raw)) fail("sources.json must be a map");
  const out: Record<string, Source> = {};
  for (const [id, row] of Object.entries(raw)) {
    out[id] = validateSource(id, row);
  }
  assertNoSecrets(out);
  return out;
}

export function validateProgram(raw: unknown, sources: Record<string, Source>): Program {
  if (!isRecord(raw)) fail("program is not an object");
  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) fail("program id must be kebab-case");
  const ts = raw.ts;
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) fail(`${id} ts must be ISO-8601`);
  const actor = raw.actor;
  if (typeof actor !== "string" || !actor.trim() || actor.length > 80) {
    fail(`${id} needs an actor`);
  }
  const claim = raw.claim;
  if (typeof claim !== "string" || !claim.trim()) fail(`${id} needs a claim`);
  if (claim.length > 160) fail(`${id} claim is over 160 characters`);
  const stage = raw.stage;
  if (typeof stage !== "string" || !STAGES.has(stage as Stage)) fail(`${id} stage is not in the vocabulary`);
  if (!Array.isArray(raw.networks) || raw.networks.length === 0) fail(`${id} needs networks`);
  const networks: Network[] = [];
  for (const network of raw.networks) {
    if (typeof network !== "string" || !NETWORKS.has(network as Network)) {
      fail(`${id} network is not in the vocabulary`);
    }
    networks.push(network as Network);
  }
  const klass = raw.class;
  if (typeof klass !== "string" || !CLASSES.has(klass as Class)) fail(`${id} class is not in the vocabulary`);
  if (!Array.isArray(raw.depends_on)) fail(`${id} depends_on must be an array`);
  const depends_on: string[] = [];
  for (const name of raw.depends_on) {
    if (typeof name !== "string" || !name.trim()) fail(`${id} depends_on entry is empty`);
    depends_on.push(name);
  }
  if (!isRecord(raw.onchain)) fail(`${id} onchain is missing`);
  const kind = raw.onchain.kind;
  if (typeof kind !== "string" || !KINDS.has(kind as OnchainKind)) fail(`${id} onchain.kind is invalid`);
  const onchain: Onchain = { kind: kind as OnchainKind };
  if (raw.onchain.url != null) {
    if (typeof raw.onchain.url !== "string" || !/^https:\/\//.test(raw.onchain.url)) {
      fail(`${id} onchain.url must be https`);
    }
    onchain.url = raw.onchain.url;
  }
  if (raw.onchain.id != null) {
    if (typeof raw.onchain.id !== "string" || !raw.onchain.id.trim()) fail(`${id} onchain.id is empty`);
    onchain.id = raw.onchain.id;
  }
  if (stage === "mainnet-live" && (onchain.kind === "none" || !onchain.url)) {
    fail(`${id} mainnet-live requires onchain.url and a kind other than none`);
  }
  let foundry_twin: string | undefined;
  if (raw.foundry_twin != null) {
    if (typeof raw.foundry_twin !== "string" || !TWIN_RE.test(raw.foundry_twin)) {
      fail(`${id} foundry_twin is not F1–F10, Walk-In, x402, heartbeat, or W0`);
    }
    foundry_twin = raw.foundry_twin;
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) fail(`${id} needs sources`);
  const sourceIds: string[] = [];
  for (const key of raw.sources) {
    if (typeof key !== "string" || !sources[key]) fail(`${id} source ${String(key)} is not in sources.json`);
    sourceIds.push(key);
  }
  const last_verified = raw.last_verified;
  if (typeof last_verified !== "string" || !DAY_RE.test(last_verified)) {
    fail(`${id} last_verified must be YYYY-MM-DD`);
  }
  const program: Program = {
    id,
    ts,
    actor,
    claim,
    stage: stage as Stage,
    networks,
    class: klass as Class,
    depends_on,
    onchain,
    sources: sourceIds,
    last_verified,
  };
  if (foundry_twin) program.foundry_twin = foundry_twin;
  assertNoSecrets(program);
  return program;
}

export function filterPrograms(
  programs: Program[],
  filter: WallFilter,
  query = "",
  amendment = ""
): Program[] {
  const needle = query.trim().toLowerCase();
  return programs.filter((program) => {
    if (filter !== "all" && program.stage === "rumor") return false;
    if (filter === "on-chain") {
      if (!ON_CHAIN_STAGES.has(program.stage) || program.onchain.kind === "none") return false;
    } else if (filter === "press") {
      if (program.stage !== "press") return false;
    } else if (filter === "devnet") {
      if (program.stage !== "devnet" && !program.networks.includes("xrpl:devnet")) return false;
    } else if (filter === "mainnet") {
      if (
        program.stage !== "mainnet-pilot" &&
        program.stage !== "mainnet-live" &&
        !program.networks.includes("xrpl:0")
      ) {
        return false;
      }
    } else if (filter === "foundry-twin") {
      if (!program.foundry_twin) return false;
    }
    if (amendment && !program.depends_on.includes(amendment)) return false;
    if (needle && !`${program.actor} ${program.claim}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}
