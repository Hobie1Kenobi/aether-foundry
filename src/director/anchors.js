"use strict";

/**
 * Public Director anchors. Addresses and hashes only.
 * No seeds, no Wallet, no signing.
 */

const fs = require("fs");
const path = require("path");
const walkIn = require("../walk-in-public");

const SCHEMA_VERSION = 1;
const KIND = "aether.director-state";
const TIMEZONE = "America/Chicago";
const STATE_REL = path.join("lab", "director-state.json");
const MAX_AGE_HOURS = 36;
const STRANDED_SPENDABLE_DROPS = 1000000n;
const LSF_DISABLE_MASTER = 0x00100000;

const XRPL_HTTP = walkIn.XRPL_HTTP;
const XRPL_WS = walkIn.XRPL_WS;
const XRPL_NETWORK_ID = 1;
const XAHAU_HTTP = "https://xahau-test.net";
const XAHAU_WS = "wss://xahau-test.net";
const XAHAU_NETWORK_ID = 21338;
const XAHAU_MAINNET_ID = 21337;
const AETH_HEX = "4145544800000000000000000000000000000000";
const AMM = "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w";
const DESK_URL = "https://aether-foundry-desk.vercel.app/";
const TOML_URL = "https://aether-foundry-desk.vercel.app/.well-known/xrp-ledger.toml";
const PACK_HOOK_HASH = "B9B6A6D5DDCF4212CC046217500AB3D90D54C7E63684F98E7991F4EBA9BC6C09";

const WALLETS = {
  W0: {
    role: "TREASURY",
    network: "xrpl_testnet",
    address: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
  },
  W1: {
    role: "MARKET",
    network: "xrpl_testnet",
    address: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
  },
  W2: {
    role: "ATELIER",
    network: "xrpl_testnet",
    address: walkIn.W2,
  },
  W3: {
    role: "CHANNELS",
    network: "xrpl_testnet",
    address: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
  },
  W4: {
    role: "ESCROW",
    network: "xrpl_testnet",
    address: "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  },
  W5: {
    role: "R&D",
    network: "xrpl_testnet",
    address: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  },
  W6: {
    role: "GRANTS",
    network: "xrpl_testnet",
    address: "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
  },
  W7: {
    role: "XAHAU treasury (hook account)",
    network: "xahau_testnet",
    address: "r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h",
  },
};

const WALLET_IDS = Object.keys(WALLETS);

const MACHINES = [
  {
    slug: "work-ticket-escrow",
    status: "trialled",
    last_result_hash: "612BD199AB78E7923E4C84226CDB1658ED299E31ACDA3B4BAA193B04543ECFF7",
    results: "machines/work-ticket-escrow/RESULTS.md",
  },
  {
    slug: "drip-pass",
    status: "trialled",
    last_result_hash: "6DFB44BB86E309F995579E92E2294D8F318A142E83F185FA22AB308A638E7737",
    results: "machines/drip-pass/RESULTS.md",
  },
  {
    slug: "walk-in-window",
    status: "open",
    last_result_hash: "2C013A0988DA6610B088D72B8E6F0378CFF52E9D7CB2ED2B181D3546318DDDBC",
    results: "machines/walk-in-window/RESULTS.md",
  },
  {
    slug: "oracle-mid-ticket",
    status: "trialled",
    last_result_hash: "A2D8E84C265DCCDD3E2E7A422B8F60D3439739E7A257154ED857AA7AB380E3A6",
    results: "machines/oracle-mid-ticket/RESULTS.md",
  },
  {
    slug: "lp-badge",
    status: "trialled",
    last_result_hash: "A2956F443B10810E1273A4334DA815599570B186266390D77BEEEDB4648823D1",
    results: "machines/lp-badge/RESULTS.md",
    note: "v0 NFT is honor-system; the ledger door is lp-badge-bound",
  },
  {
    slug: "lp-badge-bound",
    status: "trialled",
    last_result_hash: "D21E08CC086310E2FA15B1F0E717FEF406F8BD3EF29ED5137AE9ACC64875FED2",
    results: "machines/lp-badge-bound/RESULTS.md",
  },
  {
    slug: "batch-heartbeat",
    status: "spec-only",
    last_result_hash: null,
    results: "machines/batch-heartbeat/RESULTS.md",
    note: "no trial hash until atomic Batch is enabled",
  },
  {
    slug: "xahau-split-treasury",
    status: "live",
    last_result_hash: "E6142FB0B82375A01D7E07A3AF0046B6030F4CC34BCB9C3B0A2148E3ED9EEBD6",
    results: "machines/xahau-split-treasury/RESULTS.md",
  },
  {
    slug: "governance-board",
    status: "live",
    last_result_hash: "9162E6DFD7CD2BFB413CC90470A7E8124B66DF241A620442FD39F3FC3F379C24",
    results: "machines/governance-board/RESULTS.md",
  },
  {
    slug: "x402-desk",
    status: "live",
    last_result_hash: null,
    results: "machines/x402-desk/README.md",
    note: "read-only verifier; no single trial hash",
  },
  {
    slug: "x402-outbound",
    status: "live",
    last_result_hash: "D621848B4C66A940CA0DA51507D61A95D7546B4BB46E7925FC1D6FB414090C4C",
    results: "machines/x402-outbound/RESULTS.md",
  },
  {
    slug: "genesis-artifact",
    status: "trialled",
    last_result_hash: "DD7FEFB46E0443A5E9DB7357FD62FC8B501EAACCB8656FC315711F6F056E3995",
    results: "machines/genesis-artifact/RESULTS.md",
  },
];

const DEFAULT_NEXT_ACTIONS = [
  "Morning health: read probes.desk, probes.toml, wallets.W0.spendable_drops, and watched.w0_signer_list before acting.",
  "Batch probe: read watched.batch.atomic_enabled and stay quiet while it is false; do not submit a Batch transaction.",
  "Walk-In: read watched.walk_in_offer.status; leave the v2 shop while open, and remint only on the Foundry box after sold_out.",
];

const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HASH_RE = /^[0-9A-F]{64}$/;
const FAMILY_SEED_RE = /^s[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const EMBEDDED_SEED_RE = /sEd[1-9A-HJ-NP-Za-km-z]{20,}/;
const SECRET_KEY_RE = /(seed|secret|private_?key|passphrase)/i;

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function isMainnetHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "xrpl.org" || host === "www.xrpl.org") return true;
  if (host === "xahau.org" || host.endsWith(".xahau.org")) return true;
  const blocked = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link", "xahau.network"];
  return blocked.some((item) => host === item || host.endsWith(`.${item}`));
}

function assertXrplTestnetUrl(raw) {
  return walkIn.assertTestnetUrl(raw);
}

function assertXahauTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("refusing unparseable Xahau url"), { code: "MAINNET" });
  }
  const host = url.hostname.toLowerCase();
  const ok = host === "xahau-test.net" || host.endsWith(".xahau-test.net");
  if (!ok || isMainnetHost(host) || host.includes("ripple")) {
    throw Object.assign(new Error("refusing non-Xahau-Testnet host"), { code: "MAINNET" });
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:" && url.protocol !== "http:" && url.protocol !== "ws:") {
    throw Object.assign(new Error("refusing Xahau url scheme"), { code: "MAINNET" });
  }
  return raw;
}

function assertNetworkId(id, expected) {
  const n = Number(id);
  if (n === 0 || n === XAHAU_MAINNET_ID) {
    throw Object.assign(new Error(`refusing mainnet network id ${n}`), { code: "MAINNET" });
  }
  if (n !== expected) {
    throw Object.assign(new Error(`refusing network id ${id}`), { code: "MAINNET" });
  }
  return n;
}

function loadActivated(root) {
  const file = path.join(root, "machines", "governance-board", "activated.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    quorum: raw.quorum,
    signers: (raw.signers || []).map((row) => ({
      id: row.id,
      weight: row.weight,
      address: row.address,
    })),
    regular_keys: (raw.regular_keys || []).map((row) => ({
      id: row.id,
      account: row.account,
      regular_key: row.regular_key,
    })),
  };
}

function formatChicago(date) {
  const clock = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(clock.getTime())) {
    throw new Error("updated_at clock is invalid");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(clock);
  const pick = (type) => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error(`missing ${type} in Chicago timestamp`);
    return part.value;
  };
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  const match = pick("timeZoneName").replace(/^GMT/i, "").match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error("unexpected Chicago offset");
  const offset = `${match[1]}${match[2].padStart(2, "0")}:${match[3] || "00"}`;
  return `${pick("year")}-${pick("month")}-${pick("day")}T${hour}:${pick("minute")}:${pick("second")}${offset}`;
}

function spendableDrops(balance, ownerCount, reserveBase, reserveInc) {
  const bal = BigInt(balance);
  const reserve = BigInt(reserveBase) + BigInt(ownerCount) * BigInt(reserveInc);
  const spend = bal - reserve;
  return {
    spendable: spend > 0n ? spend.toString() : "0",
    shortfall: spend < 0n ? (-spend).toString() : "0",
  };
}

function sumDrops(values) {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
}

function dropsToDisplay(drops) {
  const value = BigInt(drops);
  const whole = value / 1000000n;
  const frac = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

module.exports = {
  SCHEMA_VERSION,
  KIND,
  TIMEZONE,
  STATE_REL,
  MAX_AGE_HOURS,
  STRANDED_SPENDABLE_DROPS,
  LSF_DISABLE_MASTER,
  XRPL_HTTP,
  XRPL_WS,
  XRPL_NETWORK_ID,
  XAHAU_HTTP,
  XAHAU_WS,
  XAHAU_NETWORK_ID,
  XAHAU_MAINNET_ID,
  AETH_HEX,
  AMM,
  DESK_URL,
  TOML_URL,
  PACK_HOOK_HASH,
  WALLETS,
  WALLET_IDS,
  MACHINES,
  DEFAULT_NEXT_ACTIONS,
  ADDRESS_RE,
  HASH_RE,
  FAMILY_SEED_RE,
  EMBEDDED_SEED_RE,
  SECRET_KEY_RE,
  repoRoot,
  isMainnetHost,
  assertXrplTestnetUrl,
  assertXahauTestnetUrl,
  assertNetworkId,
  loadActivated,
  formatChicago,
  spendableDrops,
  sumDrops,
  dropsToDisplay,
};
