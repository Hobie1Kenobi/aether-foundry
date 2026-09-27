"use strict";

/**
 * Guards and split math for the W7 Xahau treasury hook.
 * Seeds are never printed. Signing entrypoints call assertCanSign first.
 */

const fs = require("fs");
const crypto = require("crypto");
const xahau = require("xahau");

const XAHAU_WS = "wss://xahau-test.net";
const XAHAU_RPC = "https://xahau-test.net";
const NETWORK_ID = 21338;
const MAINNET_NETWORK_ID = 21337;
const MIN_SPLIT_DROPS = 100000n;
const BPS_DENOM = 10000n;
const SECRETS_PATH = "/workspace/aether-foundry-secrets/.env";
const NAMESPACE_LABEL = "aether-foundry-w7-split";

const SHARES = [
  { key: "MARKET", param: "MARKET", bps: 4000n, tag: 740, xrplTwin: "W1" },
  { key: "ATELIER", param: "ATELIER", bps: 2500n, tag: 725, xrplTwin: "W2" },
  { key: "RESEARCH", param: "RESEARCH", bps: 2000n, tag: 720, xrplTwin: "W5" },
  { key: "GRANTS", param: "GRANTS", bps: 1000n, tag: 710, xrplTwin: "W6" },
  { key: "SINK", param: "SINK", bps: null, tag: 705, xrplTwin: null },
];

const XRPL_TWINS = {
  W1: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
  W2: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  W5: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  W6: "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
};

const IMPORT_ALLOW = new Set([
  "_g",
  "accept",
  "rollback",
  "hook_account",
  "hook_param",
  "otxn_field",
  "otxn_type",
  "etxn_reserve",
  "prepare",
  "emit",
  "trace_num",
]);

function envIsCi(env) {
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
}

function assertCanSign(env) {
  if (envIsCi(env || process.env)) {
    throw Object.assign(new Error("refusing to sign under CI"), { code: "CI" });
  }
}

function isMainnetHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "xahau-test.net" || host.endsWith(".xahau-test.net")) return false;
  const blocked = [
    "xahau.network",
    "ripple.com",
    "xrplcluster.com",
    "rippletest.net",
    "xrpl.ws",
    "xrpl.link",
    "xrpl.org",
  ];
  return blocked.some((item) => host === item || host.endsWith(`.${item}`));
}

function assertXahauTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("refusing unparseable Xahau url"), { code: "HOST" });
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:" && url.protocol !== "https:" && url.protocol !== "http:") {
    throw Object.assign(new Error("refusing Xahau url scheme"), { code: "HOST" });
  }
  const host = url.hostname.toLowerCase();
  const xahauTest = host === "xahau-test.net" || host.endsWith(".xahau-test.net");
  if (!xahauTest || isMainnetHost(host)) {
    throw Object.assign(
      new Error("refusing non-Xahau-Testnet host (no XRPL Testnet Hooks cosplay, no mainnet)"),
      { code: "HOST" }
    );
  }
  return raw;
}

function assertNetworkId(id) {
  const n = Number(id);
  if (n === MAINNET_NETWORK_ID || n === 0) {
    throw Object.assign(new Error(`refusing network id ${n}`), { code: "MAINNET" });
  }
  if (n !== NETWORK_ID) {
    throw Object.assign(new Error(`refusing unexpected network id ${n}`), { code: "HOST" });
  }
  return n;
}

function toDrops(value) {
  if (typeof value === "bigint") {
    if (value < 0n) throw Object.assign(new Error("drops must be >= 0"), { code: "DROPS" });
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw Object.assign(new Error("drops must be a non-negative safe integer"), { code: "DROPS" });
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw Object.assign(new Error("drops must be a non-negative integer"), { code: "DROPS" });
}

function shareOf(drops, bps) {
  const n = toDrops(drops);
  const a = BigInt(bps);
  return (n / BPS_DENOM) * a + ((n % BPS_DENOM) * a) / BPS_DENOM;
}

function splitDrops(value) {
  const drops = toDrops(value);
  const market = shareOf(drops, 4000n);
  const atelier = shareOf(drops, 2500n);
  const research = shareOf(drops, 2000n);
  const grants = shareOf(drops, 1000n);
  const named = market + atelier + research + grants;
  const sink = drops - named;
  const shares = { MARKET: market, ATELIER: atelier, RESEARCH: research, GRANTS: grants, SINK: sink };
  const below = drops < MIN_SPLIT_DROPS;
  return {
    drops,
    min: MIN_SPLIT_DROPS,
    action: below ? "keep" : "split",
    shares,
    emitted: below ? 0n : market + atelier + research + grants + sink,
    kept: below ? drops : 0n,
  };
}

function hookOnPayment() {
  return xahau.calculateHookOn(["Payment"]);
}

function hookOnNone() {
  return xahau.calculateHookOn([]);
}

function bitOf(hex, n) {
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== 32) throw new Error("HookOn must be 32 bytes");
  const byteFromEnd = Math.floor(n / 8);
  const bit = n % 8;
  return (bytes[31 - byteFromEnd] >> bit) & 1;
}

function canHookTT(txType, hookOnHex) {
  const bytes = Buffer.from(hookOnHex, "hex");
  const byteFromEnd = Math.floor(22 / 8);
  bytes[31 - byteFromEnd] ^= 1 << (22 % 8);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= 0xff;
  const ttByte = Math.floor(txType / 8);
  const ttBit = txType % 8;
  return ((bytes[31 - ttByte] >> ttBit) & 1) === 1;
}

function namespaceHex() {
  return crypto.createHash("sha256").update(NAMESPACE_LABEL).digest("hex").toUpperCase();
}

function hookParameters(addresses, treasury) {
  const seen = new Set();
  if (treasury) {
    if (!xahau.isValidClassicAddress(treasury)) {
      throw Object.assign(new Error("treasury address is invalid"), { code: "ADDR" });
    }
    seen.add(treasury);
  }
  return SHARES.map((row) => {
    const classic = addresses[row.key];
    if (!xahau.isValidClassicAddress(classic)) {
      throw Object.assign(new Error(`missing Xahau address for ${row.key}`), { code: "ADDR" });
    }
    if (seen.has(classic)) {
      throw Object.assign(
        new Error(`duplicate or self destination ${row.key}`),
        { code: "ADDR" }
      );
    }
    seen.add(classic);
    const id = xahau.decodeAccountID(classic);
    return {
      HookParameter: {
        HookParameterName: Buffer.from(row.param, "ascii").toString("hex").toUpperCase(),
        HookParameterValue: Buffer.from(id).toString("hex").toUpperCase(),
      },
    };
  });
}

function nativePaymentSkeleton(destination, drops, sourceTag) {
  if (!xahau.isValidClassicAddress(destination)) {
    throw Object.assign(new Error("destination is not a classic address"), { code: "ADDR" });
  }
  const amount = toDrops(drops);
  if (amount <= 0n) throw Object.assign(new Error("skeleton drops must be > 0"), { code: "DROPS" });
  const tag = Number(sourceTag);
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xffffffff) {
    throw Object.assign(new Error("source tag out of range"), { code: "TAG" });
  }
  return xahau.encode({
    TransactionType: "Payment",
    SourceTag: tag,
    Amount: amount.toString(),
    Destination: destination,
  }).toUpperCase();
}

function loadEnvText(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readSecrets(env, io) {
  const file = (env && env.AETHER_SECRETS) || SECRETS_PATH;
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  const fromEnv = {};
  if (env) {
    for (const key of Object.keys(env)) {
      if (/^[A-Z0-9_]+$/.test(key)) fromEnv[key] = env[key];
    }
  }
  if (!exists(file)) return fromEnv;
  return Object.assign(loadEnvText(readFile(file, "utf8")), fromEnv);
}

function walletFromSecret(secret) {
  const decoded = xahau.decodeSeed(secret);
  const algorithm = decoded && decoded.type ? decoded.type : "secp256k1";
  return xahau.Wallet.fromSeed(secret, { algorithm });
}

function lookupSecret(env, names, io) {
  const bag = readSecrets(env, io);
  for (const name of names) {
    if (bag[name]) return bag[name];
  }
  return "";
}

function readLeb(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: i };
    shift += 7;
    if (shift > 35) break;
  }
  throw Object.assign(new Error("bad wasm leb128"), { code: "WASM" });
}

function readName(buf, offset) {
  const len = readLeb(buf, offset);
  const end = len.offset + len.value;
  if (end > buf.length) throw Object.assign(new Error("wasm name overrun"), { code: "WASM" });
  return { name: buf.subarray(len.offset, end).toString("utf8"), offset: end };
}

function wasmInfo(buf) {
  if (buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
    throw Object.assign(new Error("not a wasm module"), { code: "WASM" });
  }
  const imports = [];
  const exports = [];
  const custom = [];
  let start = false;
  let offset = 8;
  while (offset < buf.length) {
    const id = buf[offset];
    offset += 1;
    const size = readLeb(buf, offset);
    const startAt = size.offset;
    const end = startAt + size.value;
    if (end > buf.length) throw Object.assign(new Error("wasm section overrun"), { code: "WASM" });
    if (id === 0) {
      const name = readName(buf, startAt);
      custom.push(name.name);
    } else if (id === 2) {
      let cursor = startAt;
      const count = readLeb(buf, cursor);
      cursor = count.offset;
      for (let n = 0; n < count.value; n += 1) {
        const mod = readName(buf, cursor);
        const field = readName(buf, mod.offset);
        const kind = buf[field.offset];
        cursor = field.offset + 1;
        if (kind === 0) {
          const typeIdx = readLeb(buf, cursor);
          cursor = typeIdx.offset;
        }
        imports.push({ module: mod.name, name: field.name, kind });
      }
    } else if (id === 7) {
      let cursor = startAt;
      const count = readLeb(buf, cursor);
      cursor = count.offset;
      for (let n = 0; n < count.value; n += 1) {
        const field = readName(buf, cursor);
        const kind = buf[field.offset];
        const idx = readLeb(buf, field.offset + 1);
        cursor = idx.offset;
        exports.push({ name: field.name, kind });
      }
    } else if (id === 8) {
      start = true;
    }
    offset = end;
  }
  return { imports, exports, start, custom };
}

function assertHookWasm(buf) {
  const info = wasmInfo(buf);
  const exportNames = new Set(info.exports.map((row) => row.name));
  if (!exportNames.has("hook")) {
    throw Object.assign(new Error("wasm does not export hook"), { code: "WASM" });
  }
  if (info.start) {
    throw Object.assign(new Error("wasm has a start section"), { code: "WASM" });
  }
  if (info.custom.length) {
    throw Object.assign(
      new Error(`wasm has custom sections (${info.custom.join(", ")}); run wasm-strip`),
      { code: "WASM" }
    );
  }
  for (const row of info.imports) {
    if (row.module !== "env" || row.kind !== 0 || !IMPORT_ALLOW.has(row.name)) {
      throw Object.assign(
        new Error(`wasm import not on the hook allowlist: ${row.module}.${row.name}`),
        { code: "WASM" }
      );
    }
  }
  if (!info.imports.some((row) => row.name === "_g")) {
    throw Object.assign(new Error("wasm does not import _g"), { code: "WASM" });
  }
  const needed = ["accept", "rollback", "prepare", "emit", "etxn_reserve", "hook_param"];
  for (const name of needed) {
    if (!info.imports.some((row) => row.name === name)) {
      throw Object.assign(new Error(`wasm does not import ${name}`), { code: "WASM" });
    }
  }
  return info;
}

module.exports = {
  XAHAU_WS,
  XAHAU_RPC,
  NETWORK_ID,
  MAINNET_NETWORK_ID,
  MIN_SPLIT_DROPS,
  SHARES,
  XRPL_TWINS,
  SECRETS_PATH,
  NAMESPACE_LABEL,
  IMPORT_ALLOW,
  envIsCi,
  assertCanSign,
  assertXahauTestnetUrl,
  assertNetworkId,
  toDrops,
  splitDrops,
  hookOnPayment,
  hookOnNone,
  bitOf,
  canHookTT,
  namespaceHex,
  hookParameters,
  nativePaymentSkeleton,
  loadEnvText,
  readSecrets,
  walletFromSecret,
  lookupSecret,
  wasmInfo,
  assertHookWasm,
};
