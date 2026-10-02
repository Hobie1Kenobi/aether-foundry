"use strict";

/**
 * Shared checks for the W3 outbound payer.
 * Refuses mainnet and every Foundry anchor in web/lib/xrpl-public.ts WALLETS.
 */

const fs = require("fs");
const path = require("path");
const rules = require("../web/lib/x402-rules");

const ROOT = path.resolve(__dirname, "..");
const WALLETS_FILE = path.join(ROOT, "web", "lib", "xrpl-public.ts");
const ACTIVATED_FILE = path.join(ROOT, "machines", "governance-board", "activated.json");
const CANDIDATES_FILE = path.join(ROOT, "machines", "x402-citizen", "candidates.json");
const SECRETS_PATH = "/workspace/aether-foundry-secrets/.env";
const W3_ADDRESS = "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw";
const XRPL_WS = "wss://s.altnet.rippletest.net:51233";
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function envIsCi(env) {
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
}

function isMainnetUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const blocked = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link"];
    return blocked.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function assertTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("refusing unparseable XRPL url"), { code: "MAINNET" });
  }
  if (isMainnetUrl(raw)) {
    throw Object.assign(new Error("refusing mainnet XRPL url"), { code: "MAINNET" });
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".rippletest.net") && host !== "rippletest.net") {
    throw Object.assign(new Error("refusing non-testnet XRPL url"), { code: "MAINNET" });
  }
  return raw;
}

function foundryIndex(text) {
  const src = text == null ? fs.readFileSync(WALLETS_FILE, "utf8") : text;
  const start = src.indexOf("export const WALLETS");
  if (start < 0) throw new Error("WALLETS export missing from web/lib/xrpl-public.ts");
  const end = src.indexOf("} as const;", start);
  if (end < 0) throw new Error("WALLETS block missing from web/lib/xrpl-public.ts");
  const block = src.slice(start, end);
  const map = new Map();
  const re = /id:\s*"([^"]+)"[\s\S]*?address:\s*"(r[^"]+)"/g;
  let match = re.exec(block);
  while (match) {
    map.set(match[2], match[1]);
    match = re.exec(block);
  }
  if (map.size === 0) throw new Error("no Foundry addresses parsed from WALLETS");
  if (map.get(W3_ADDRESS) !== "W3") {
    throw new Error("W3 CHANNELS anchor missing from WALLETS");
  }
  return map;
}

function assertForeignPayTo(payTo, index) {
  const id = payTo === W3_ADDRESS ? "W3" : index.get(payTo);
  if (id) {
    throw Object.assign(
      new Error(
        `refusing Foundry payTo ${payTo} (${id}). W3 does not buy Foundry anchors.`
      ),
      { code: "FOUNDRY_PAYTO" }
    );
  }
}

function normalizeDrops(amount) {
  if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0) {
    return String(amount);
  }
  if (typeof amount === "string" && /^[0-9]+$/.test(amount)) return amount;
  return null;
}

function schemeOk(row) {
  return row.scheme == null || row.scheme === "exact";
}

function assetOk(row) {
  return row.asset == null || row.asset === "XRP";
}

function selectAccept(required) {
  if (!required || typeof required !== "object") {
    throw Object.assign(new Error("PAYMENT-REQUIRED is empty"), { code: "PARSE" });
  }
  if (required.x402Version !== 2) {
    throw Object.assign(new Error("x402Version must be 2"), { code: "PARSE" });
  }
  const accepts = Array.isArray(required.accepts) ? required.accepts : [];
  if (accepts.length === 0) {
    throw Object.assign(new Error("PAYMENT-REQUIRED has no accepts"), { code: "NO_ACCEPT" });
  }
  const mainnet = accepts.some(
    (row) => row && (row.network === "xrpl:0" || row.network === "xrpl-mainnet")
  );
  const chosen = accepts.find(
    (row) => row && row.network === "xrpl:1" && schemeOk(row) && assetOk(row)
  );
  if (!chosen) {
    throw Object.assign(
      new Error(mainnet ? "refusing mainnet xrpl:0" : "no xrpl:1 exact XRP accept"),
      { code: mainnet ? "MAINNET" : "NO_ACCEPT" }
    );
  }
  const amount = normalizeDrops(chosen.amount);
  if (amount == null) {
    throw Object.assign(new Error("accept.amount must be XRP drops"), { code: "AMOUNT" });
  }
  if (typeof chosen.payTo !== "string" || chosen.payTo.length === 0) {
    throw Object.assign(new Error("accept.payTo is missing"), { code: "PAYTO" });
  }
  return Object.assign({}, chosen, { amount });
}

function parsePaymentRequired(header, bodyText) {
  if (header) {
    const trimmed = String(header).trim();
    try {
      return rules.decodeHeader(trimmed);
    } catch {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* body fallback */
      }
    }
  }
  if (bodyText) {
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    if (body && body.paymentRequired && typeof body.paymentRequired === "object") {
      return body.paymentRequired;
    }
    if (body && Array.isArray(body.accepts)) return body;
  }
  throw Object.assign(new Error("could not parse PAYMENT-REQUIRED"), { code: "PARSE" });
}

function statedDiyDrops(required, accept, body) {
  const extra = accept && accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  const candidates = [
    extra.diyCostDrops,
    required && required.diyCostDrops,
    body && body.diyCostDrops,
    body && body.paymentRequired && body.paymentRequired.diyCostDrops,
  ];
  for (const candidate of candidates) {
    const drops = normalizeDrops(candidate);
    if (drops != null) return drops;
  }
  return null;
}

function resolveCeiling({ maxDropsFlag, envMax, statedDiy }) {
  if (maxDropsFlag != null && String(maxDropsFlag).length > 0) {
    if (!/^[0-9]+$/.test(String(maxDropsFlag))) {
      throw Object.assign(new Error("cost ceiling must be drops"), { code: "AMOUNT" });
    }
    return { ceiling: String(maxDropsFlag), source: "MAX_DROPS" };
  }
  if (envMax != null && String(envMax).length > 0) {
    if (!/^[0-9]+$/.test(String(envMax))) {
      throw Object.assign(new Error("MAX_DROPS must be drops"), { code: "AMOUNT" });
    }
    return { ceiling: String(envMax), source: "MAX_DROPS" };
  }
  if (statedDiy != null) return { ceiling: statedDiy, source: "stated DIY" };
  return { ceiling: null, source: null };
}

function priceVerdict(amount, ceiling) {
  if (ceiling == null) return { pay: true };
  if (BigInt(amount) > BigInt(ceiling)) {
    return { pay: false, message: "too expensive vs DIY" };
  }
  return { pay: true };
}

function buildPaymentTx({ account, accept }) {
  const tx = {
    TransactionType: "Payment",
    Account: account,
    Destination: accept.payTo,
    Amount: accept.amount,
  };
  const extra = accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  if (extra.sourceTag != null && extra.sourceTag !== "") {
    const tag = Number(extra.sourceTag);
    if (!Number.isInteger(tag) || tag < 0 || tag > 4294967295) {
      throw Object.assign(new Error("sourceTag is not a uint32"), { code: "AMOUNT" });
    }
    tx.SourceTag = tag;
  }
  if (typeof extra.invoiceId === "string" && extra.invoiceId.length > 0) {
    tx.Memos = [
      {
        Memo: {
          MemoType: Buffer.from("invoice", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from(extra.invoiceId, "utf8").toString("hex").toUpperCase(),
        },
      },
    ];
  }
  return tx;
}

function buildSignaturePayload({ required, accept, txBlob, hash }) {
  const payload = {};
  if (typeof txBlob === "string" && txBlob.length > 0) payload.signedTxBlob = txBlob;
  if (typeof hash === "string" && hash.length > 0) payload.transaction = hash;
  const extra = accept && accept.extra && typeof accept.extra === "object" ? accept.extra : {};
  if (typeof extra.invoiceId === "string" && extra.invoiceId.length > 0) {
    payload.invoiceId = extra.invoiceId;
  }
  return {
    x402Version: 2,
    resource: required && required.resource,
    accepted: accept,
    payload,
  };
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeHash(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^[0-9A-F]{64}$/.test(text) ? text : null;
}

function ledgerIndexFrom(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed.ledger_index != null ? parsed.ledger_index : parsed.ledgerIndex;
  return typeof value === "number" ? value : null;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  return headers[name] || headers[name.toLowerCase()] || "";
}

function hashFromResponse(last) {
  const raw = headerValue(last && last.headers, "payment-response");
  if (raw) {
    try {
      const decoded = rules.decodeHeader(raw);
      const fromHeader = normalizeHash(decoded && decoded.transaction);
      if (fromHeader) return fromHeader;
    } catch {
      /* body fallback */
    }
  }
  const parsed = last && last.parsed;
  if (!parsed) return null;
  return normalizeHash(parsed.transaction || parsed.hash || parsed.txHash);
}

function codeOf(parsed) {
  return parsed && typeof parsed.code === "string" ? parsed.code : "";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resourceRequest(input) {
  if (typeof input === "string") {
    return { url: assertResourceUrl(input.trim()), method: "GET", body: null };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("resource request is not a URL"), { code: "PARSE" });
  }
  const url = assertResourceUrl(String(input.url || input.resourceUrl || "").trim());
  const method = String(input.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw Object.assign(new Error("resource method must be GET or POST"), { code: "PARSE" });
  }
  if (input.body == null) return { url, method, body: null };
  if (method !== "POST" || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw Object.assign(new Error("resource body must be a JSON object on POST"), { code: "PARSE" });
  }
  return { url, method, body: Object.assign({}, input.body) };
}

function matchResource(url, requests) {
  const normalized = assertResourceUrl(String(url || "").trim());
  const list = Array.isArray(requests) ? requests : [];
  for (const item of list) {
    const request = resourceRequest(item);
    if (request.url === normalized) return request;
  }
  return resourceRequest(normalized);
}

function fetchInit(request, headers) {
  const call = resourceRequest(request);
  const init = {
    method: call.method,
    headers: Object.assign({ Accept: "application/json" }, headers || {}),
  };
  if (call.body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(call.body);
  }
  return init;
}

function loadCandidateRequests(file, io) {
  const target = file || CANDIDATES_FILE;
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  if (!exists(target)) return [];
  let doc;
  try {
    doc = JSON.parse(readFile(target, "utf8"));
  } catch {
    throw Object.assign(new Error("candidates.json is not JSON"), { code: "PARSE" });
  }
  const urls = doc && Array.isArray(doc.urls) ? doc.urls : [];
  const out = [];
  for (const item of urls) {
    if (typeof item === "string" && !item.trim()) continue;
    out.push(resourceRequest(item));
  }
  return out;
}

function requestForUrl(url, io) {
  return matchResource(url, loadCandidateRequests(CANDIDATES_FILE, io));
}

/**
 * Offer a presigned Payment first. Shops that settle the blob (CryptoBuddy / t54)
 * return 200. A verify-only shop answers payment_not_on_ledger; submit that same
 * blob once, then retry. Do not submit on any other refusal.
 * The retry uses the same method and JSON body as the unpaid probe.
 */
async function deliverForeignPayment(opts) {
  const options = opts || {};
  const fetchImpl = options.fetchImpl;
  const sleep = options.sleep || defaultSleep;
  if (typeof fetchImpl !== "function") {
    throw Object.assign(new Error("deliverForeignPayment needs fetchImpl"), { code: "PARSE" });
  }
  if (!options.resourceUrl) {
    throw Object.assign(new Error("deliverForeignPayment needs a resource url"), { code: "PARSE" });
  }
  const call = resourceRequest({
    url: options.resourceUrl,
    method: options.method,
    body: options.body,
  });
  let activeHash = normalizeHash(options.hash);

  async function send(includeTxHash) {
    const payload = buildSignaturePayload({
      required: options.required,
      accept: options.accept,
      txBlob: options.txBlob,
      hash: includeTxHash ? activeHash : null,
    });
    const response = await fetchImpl(
      call.url,
      fetchInit(call, { "PAYMENT-SIGNATURE": rules.encodeHeader(payload) })
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      parsed: parseJsonObject(text),
      payload,
    };
  }

  function finish(mode, submitted, last, ledgerIndex) {
    const echoed = hashFromResponse(last);
    let hash = null;
    if (last.status === 200) hash = echoed || activeHash;
    else if (submitted) hash = activeHash;
    const fromBody = ledgerIndexFrom(last.parsed);
    return {
      mode,
      submitted,
      http_status: last.status,
      body: last.text,
      parsed: last.parsed,
      hash,
      ledger_index: fromBody != null ? fromBody : ledgerIndex,
      result: last.status === 200 || submitted ? "tesSUCCESS" : null,
      payload: last.payload,
    };
  }

  async function confirm(times) {
    let last = null;
    for (let attempt = 0; attempt < times; attempt += 1) {
      if (attempt > 0) await sleep(1000 * attempt);
      last = await send(true);
      if (last.status === 200) return last;
      const code = codeOf(last.parsed);
      if (code !== "payment_not_on_ledger" && code !== "payment_not_validated") return last;
    }
    return last;
  }

  let last = await send(false);
  if (last.status === 200) return finish("shop-settle", false, last, null);

  if (codeOf(last.parsed) === "payment_not_validated") {
    last = await confirm(4);
    return finish(last.status === 200 ? "shop-settle" : "refused", false, last, null);
  }

  if (codeOf(last.parsed) !== "payment_not_on_ledger") {
    return finish("refused", false, last, null);
  }

  if (typeof options.submit !== "function") {
    throw Object.assign(new Error("shop does not settle signed blobs"), { code: "SUBMIT" });
  }
  const submittedView = await options.submit();
  if (!submittedView || submittedView.result !== "tesSUCCESS" || !submittedView.hash) {
    throw Object.assign(
      new Error(`payment result ${(submittedView && submittedView.result) || "missing"}`),
      { code: "SUBMIT" }
    );
  }
  activeHash = normalizeHash(submittedView.hash) || activeHash;
  const ledgerIndex = submittedView.ledger_index == null ? null : submittedView.ledger_index;
  last = await confirm(4);
  return finish(last.status === 200 ? "client-submit" : "submitted-unpaid", true, last, ledgerIndex);
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

function loadW3SignerSeed(env, io) {
  const source = env || {};
  const file = source.AETHER_SECRETS || SECRETS_PATH;
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  const fromFile = exists(file) ? loadEnvText(readFile(file, "utf8")) : {};
  const merged = Object.assign({}, fromFile);
  if (source.W3_REGULAR_SEED) merged.W3_REGULAR_SEED = source.W3_REGULAR_SEED;
  if (source.W3_SEED) merged.W3_SEED = source.W3_SEED;
  if (merged.W3_REGULAR_SEED) return { seed: merged.W3_REGULAR_SEED, key_env: "W3_REGULAR_SEED" };
  if (merged.W3_SEED) return { seed: merged.W3_SEED, key_env: "W3_SEED" };
  return { seed: "", key_env: "" };
}

function w3RegularAddress(env, io) {
  if (env && String(env.W3_REGULAR_ADDRESS || "").trim()) {
    const address = String(env.W3_REGULAR_ADDRESS).trim();
    if (!ADDRESS_RE.test(address)) {
      throw Object.assign(new Error("W3_REGULAR_ADDRESS is not a classic address"), { code: "ACCOUNT" });
    }
    if (address === W3_ADDRESS) {
      throw Object.assign(new Error("W3 regular key must not equal W3 CHANNELS"), { code: "ACCOUNT" });
    }
    return address;
  }
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  const file = (io && io.activatedFile) || ACTIVATED_FILE;
  let doc;
  try {
    doc = JSON.parse(readFile(file, "utf8"));
  } catch {
    throw Object.assign(new Error("W3 regular key is missing from activated.json"), { code: "ACCOUNT" });
  }
  const row = (doc.regular_keys || []).find((item) => item && item.id === "W3");
  if (!row || !ADDRESS_RE.test(row.regular_key || "") || row.regular_key === W3_ADDRESS) {
    throw Object.assign(new Error("W3 regular key is missing from activated.json"), { code: "ACCOUNT" });
  }
  if (row.account !== W3_ADDRESS) {
    throw Object.assign(new Error("activated.json W3 account drifted"), { code: "ACCOUNT" });
  }
  return row.regular_key;
}

function assertW3Signer(wallet, loaded, env, io) {
  const keyEnv = loaded && loaded.key_env;
  const classic = (wallet && (wallet.classicAddress || wallet.address)) || "";
  if (keyEnv === "W3_REGULAR_SEED") {
    const expected = w3RegularAddress(env, io);
    if (classic !== expected) {
      throw Object.assign(
        new Error(`signer address ${classic} is not the W3 regular key ${expected}`),
        { code: "ACCOUNT" }
      );
    }
    return { account: W3_ADDRESS, signer: classic, key_env: keyEnv };
  }
  if (keyEnv === "W3_SEED" && classic === W3_ADDRESS) {
    return { account: W3_ADDRESS, signer: classic, key_env: keyEnv };
  }
  throw Object.assign(
    new Error(`signer address ${classic} is not W3 CHANNELS ${W3_ADDRESS}`),
    { code: "ACCOUNT" }
  );
}

function assertResourceUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("RESOURCE_URL is not a URL"), { code: "PARSE" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("RESOURCE_URL must be http or https"), { code: "PARSE" });
  }
  return url.toString();
}

module.exports = {
  W3_ADDRESS,
  XRPL_WS,
  WALLETS_FILE,
  ACTIVATED_FILE,
  SECRETS_PATH,
  loadW3SignerSeed,
  w3RegularAddress,
  assertW3Signer,
  envIsCi,
  isMainnetUrl,
  assertTestnetUrl,
  foundryIndex,
  assertForeignPayTo,
  normalizeDrops,
  selectAccept,
  parsePaymentRequired,
  statedDiyDrops,
  resolveCeiling,
  priceVerdict,
  buildPaymentTx,
  buildSignaturePayload,
  resourceRequest,
  matchResource,
  fetchInit,
  loadCandidateRequests,
  requestForUrl,
  CANDIDATES_FILE,
  deliverForeignPayment,
  assertResourceUrl,
  encodeHeader: rules.encodeHeader,
};
