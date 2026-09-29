"use strict";

/**
 * Seedless desk status. HTTPS JSON-RPC only. Counts come from public git
 * text the caller already fetched. A failed parse is null plus error.
 */

const facilitator = require("./x402-facilitator");

const LAWS = ["altnets-only", "desk-read-only", "seeds-never-in-git"];
const BANNED_HOSTS = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link", "xahau.network"];
const HASH_RE = /^[0-9A-F]{64}$/;
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const SEED_RE = /sEd[1-9A-HJ-NP-Za-km-z]{15,}/;
const SECRET_KEY_RE = /(^|_)(seed|secret|private_?key)($|_)/i;
const TF_SELL_NFTOKEN = 0x00000001;
const COUNT_KEYS = ["x402_hits", "grants_paid", "inbound_counterparties"];

function emptyHeartbeat() {
  return { hash: null, ledger_index: null, ts: null };
}

function emptyOracle() {
  return {
    account: "",
    oracle_document_id: null,
    last_update_time: null,
    quote_xrp_per_aeth: null,
    asset_price: null,
    scale: null,
    ledger_index: null,
    base_asset: null,
    quote_asset: null,
  };
}

function baseStatus(error) {
  const body = {
    network: null,
    desk: "read-only",
    ledger_index: null,
    walk_in: { status: "error", offer_id: "", amount_drops: null },
    amm: { account: "", spot_xrp_per_aeth: null },
    batch_atomic_enabled: null,
    w7_hook_matches_pack: null,
    x402_hits: null,
    x402_outbound_hits: null,
    x402_foreign_hits: null,
    grants_paid: null,
    inbound_counterparties: null,
    facilitator: facilitator.publicFacilitator({}),
    last_heartbeat: emptyHeartbeat(),
    oracle_id: null,
    oracle: emptyOracle(),
    mpt_issuance_id: null,
    domain_id: null,
    director_updated_at: null,
    laws: LAWS.slice(),
  };
  if (error) body.error = error;
  return body;
}

function assertPublic(value) {
  if (Array.isArray(value)) {
    value.forEach(assertPublic);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) throw new Error("secret field");
      assertPublic(child);
    }
    return;
  }
  if (typeof value === "string" && SEED_RE.test(value)) throw new Error("seed-shaped value");
}

function hostBanned(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "xrpl.org" || host === "www.xrpl.org") return true;
  if (host === "xahau.org" || host.endsWith(".xahau.org")) return true;
  return BANNED_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
}

function httpsUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "refusing unparseable RPC url" };
  }
  if (url.protocol !== "https:") return { error: "refusing non-HTTPS RPC" };
  if (hostBanned(url.hostname)) return { error: `refusing mainnet host ${url.hostname}` };
  return { url: url.toString().replace(/\/$/, "") };
}

function parsePnlCounts(text) {
  const counts = {};
  const errors = [];
  const source = String(text || "");
  for (const key of ["x402_hits", "x402_outbound_hits", "grants_paid", "inbound_counterparties"]) {
    const match = source.match(new RegExp(`^\\| ${key} \\|\\s*\\**(\\d+)\\**`, "m"));
    if (!match) errors.push(`${key} missing`);
    else counts[key] = Number(match[1]);
  }
  return { counts, errors };
}

function hashOrNull(value) {
  if (value == null || value === "") return null;
  const hash = String(value).toUpperCase();
  return HASH_RE.test(hash) ? hash : null;
}

function parseMetrics(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "metrics.json is not JSON" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "metrics.json is not an object" };
  }
  try {
    assertPublic(doc);
  } catch {
    return { ok: false, error: "metrics.json refused" };
  }
  const counts = {};
  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(doc[key]) || doc[key] < 0) {
      return { ok: false, error: `metrics.json ${key} is not a count` };
    }
    counts[key] = doc[key];
  }
  const beat = doc.last_heartbeat && typeof doc.last_heartbeat === "object" ? doc.last_heartbeat : null;
  const fromBeat = beat ? hashOrNull(beat.hash) : null;
  const fromField = hashOrNull(doc.last_heartbeat_hash);
  if ((beat && beat.hash != null && !fromBeat) || (doc.last_heartbeat_hash != null && !fromField)) {
    return { ok: false, error: "metrics.json heartbeat hash is not 64 hex" };
  }
  const ledger = beat && Number.isInteger(beat.ledger_index) && beat.ledger_index > 0 ? beat.ledger_index : null;
  const ts = beat && typeof beat.ts === "string" ? beat.ts : null;
  const oracle = readMetricsOracle(doc);
  if (!oracle.ok) return oracle;
  const mpt = readMetricsMpt(doc);
  if (!mpt.ok) return mpt;
  const domain = readMetricsDomain(doc);
  if (!domain.ok) return domain;
  const outbound = readMetricsOutbound(doc);
  if (!outbound.ok) return outbound;
  return {
    ok: true,
    counts,
    last_heartbeat: {
      hash: fromBeat || fromField,
      ledger_index: fromBeat ? ledger : null,
      ts: fromBeat ? ts : null,
    },
    oracle_id: oracle.oracle_id,
    oracle: oracle.oracle,
    mpt_issuance_id: mpt.mpt_issuance_id,
    domain_id: domain.domain_id,
    x402_outbound_hits: outbound.x402_outbound_hits,
  };
}

function readMetricsOutbound(doc) {
  if (!Object.prototype.hasOwnProperty.call(doc, "x402_outbound_hits") || doc.x402_outbound_hits == null) {
    return { ok: true, x402_outbound_hits: null };
  }
  if (!Number.isInteger(doc.x402_outbound_hits) || doc.x402_outbound_hits < 0) {
    return { ok: false, error: "metrics.json x402_outbound_hits is not a count" };
  }
  return { ok: true, x402_outbound_hits: doc.x402_outbound_hits };
}

function readMetricsDomain(doc) {
  if (doc.domain_id == null) return { ok: true, domain_id: null };
  const id = hashOrNull(doc.domain_id);
  if (!id) return { ok: false, error: "metrics.json domain_id is not 64 hex" };
  return { ok: true, domain_id: id };
}

function readMetricsMpt(doc) {
  if (doc.mpt_issuance_id == null) return { ok: true, mpt_issuance_id: null };
  const id = String(doc.mpt_issuance_id).toUpperCase();
  if (!/^[0-9A-F]{48}$/.test(id)) {
    return { ok: false, error: "metrics.json mpt_issuance_id is not 48 hex" };
  }
  return { ok: true, mpt_issuance_id: id };
}

function decimalFromScaled(assetPrice, scale) {
  const raw = String(assetPrice == null ? "" : assetPrice).trim();
  let n;
  if (/^[0-9]+$/.test(raw)) n = BigInt(raw);
  else if (/^[0-9a-fA-F]+$/.test(raw)) n = BigInt(`0x${raw}`);
  else return null;
  const s = Number(scale);
  if (!Number.isInteger(s) || s < 0 || s > 10 || n < 0n) return null;
  const den = 10n ** BigInt(s);
  const whole = n / den;
  const frac = (n % den).toString().padStart(s, "0").replace(/0+$/, "");
  const quote = s === 0 || !frac ? whole.toString() : `${whole.toString()}.${frac}`;
  return { quote, asset_price: n.toString(10), scale: s };
}

function isAethAsset(asset) {
  const code = String(asset || "").toUpperCase();
  return code === "AETH" || code === "4145544800000000000000000000000000000000";
}

function isXrpAsset(asset) {
  const code = String(asset || "").toUpperCase();
  return code === "XRP" || code === "0000000000000000000000000000000000000000";
}

function readLedgerOracle(result, expectedAccount, documentId) {
  const node = result && result.node && typeof result.node === "object" ? result.node : result;
  if (!node || !Array.isArray(node.PriceDataSeries)) return { ok: false, error: "ledger_entry omitted the Oracle node" };
  const owner = typeof node.Owner === "string" ? node.Owner : "";
  if (expectedAccount && owner && owner !== expectedAccount) {
    return { ok: false, error: "oracle Owner is not W5" };
  }
  const docId = node.OracleDocumentID == null ? null : Number(node.OracleDocumentID);
  if (documentId != null && docId != null && docId !== documentId) {
    return { ok: false, error: "oracle document id drifted" };
  }
  const series = node.PriceDataSeries.map((row) => (row && row.PriceData) || row);
  const pair = series.find((row) => row && isAethAsset(row.BaseAsset) && isXrpAsset(row.QuoteAsset));
  if (!pair) return { ok: false, error: "oracle omitted the AETH/XRP pair" };
  const decoded = decimalFromScaled(pair.AssetPrice, pair.Scale);
  if (!decoded) return { ok: false, error: "oracle AssetPrice is not an integer" };
  const index = result && (result.index || result.node_index);
  const oracleId = hashOrNull(index);
  if (index != null && !oracleId) return { ok: false, error: "oracle index is not 64 hex" };
  const updated = Number(node.LastUpdateTime);
  const ledger = result && Number.isInteger(result.ledger_index) && result.ledger_index > 0 ? result.ledger_index : null;
  return {
    ok: true,
    oracle_id: oracleId,
    oracle: {
      account: owner,
      oracle_document_id: docId,
      last_update_time: Number.isInteger(updated) && updated > 0 ? updated : null,
      quote_xrp_per_aeth: decoded.quote,
      asset_price: decoded.asset_price,
      scale: decoded.scale,
      ledger_index: ledger,
      base_asset: "AETH",
      quote_asset: "XRP",
    },
  };
}

function readMetricsOracle(doc) {
  const blank = { ok: true, oracle_id: null, oracle: emptyOracle() };
  if (doc.oracle_id == null && doc.last_oracle == null) return blank;
  const id = hashOrNull(doc.oracle_id);
  if (doc.oracle_id != null && !id) return { ok: false, error: "metrics.json oracle_id is not 64 hex" };
  const row = doc.last_oracle;
  if (row == null) return { ok: true, oracle_id: id, oracle: emptyOracle() };
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { ok: false, error: "metrics.json last_oracle is not an object" };
  }
  const rowId = hashOrNull(row.oracle_id);
  const rowHash = hashOrNull(row.hash);
  if ((row.oracle_id != null && !rowId) || (row.hash != null && !rowHash)) {
    return { ok: false, error: "metrics.json last_oracle hash is not 64 hex" };
  }
  if (row.quote_xrp_per_aeth != null && !/^\d+(\.\d+)?$/.test(String(row.quote_xrp_per_aeth))) {
    return { ok: false, error: "metrics.json last_oracle quote is not a decimal" };
  }
  const ledger = Number.isInteger(row.ledger_index) && row.ledger_index > 0 ? row.ledger_index : null;
  const updated = Number.isInteger(row.last_update_time) && row.last_update_time > 0 ? row.last_update_time : null;
  return {
    ok: true,
    oracle_id: id || rowId,
    oracle: {
      account: "",
      oracle_document_id: 1,
      last_update_time: updated,
      quote_xrp_per_aeth: row.quote_xrp_per_aeth == null ? null : String(row.quote_xrp_per_aeth),
      asset_price: null,
      scale: null,
      ledger_index: ledger,
      base_asset: row.quote_xrp_per_aeth ? "AETH" : null,
      quote_asset: row.quote_xrp_per_aeth ? "XRP" : null,
    },
  };
}

function lastHeartbeatFromLog(text) {
  let last = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || (row.action !== "heartbeat" && row.event !== "heartbeat")) continue;
    const hash = hashOrNull(row.hash);
    if (!hash) continue;
    last = {
      hash,
      ledger_index: Number.isInteger(row.ledger_index) && row.ledger_index > 0 ? row.ledger_index : null,
      ts: typeof row.ts === "string" ? row.ts : null,
    };
  }
  return last;
}

function spotXrpPerAeth(drops, aethValue) {
  if (!/^[0-9]+$/.test(String(drops || ""))) return null;
  const raw = String(aethValue || "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const scale = 10n ** BigInt(frac.length);
  const scaled = frac ? BigInt(whole + frac) : BigInt(whole) * scale;
  if (scaled === 0n) return null;
  const num = BigInt(drops) * scale;
  const den = 1000000n * scaled;
  const wholeOut = num / den;
  const rem = num % den;
  const fracOut = ((rem * 1000000n) / den).toString().padStart(6, "0").replace(/0+$/, "");
  return fracOut ? `${wholeOut}.${fracOut}` : String(wholeOut);
}

function readBatch(feature) {
  const raw = feature && feature.features;
  if (!raw || typeof raw !== "object") return { ok: false, error: "feature response omitted amendments" };
  const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([hash, row]) => Object.assign({ hash }, row));
  const amendments = rows.filter((row) => row && /batch/i.test(row.name || ""));
  const names = new Set(amendments.map((row) => row.name));
  if (!names.has("BatchV1_1") || !names.has("fixBatchV1_2")) {
    return { ok: false, error: "feature response omitted BatchV1 amendments" };
  }
  const atomic = amendments.some((row) => /^Batch/i.test(row.name) && row.enabled && !/^TicketBatch$/i.test(row.name));
  return { ok: true, atomic_enabled: atomic };
}

function sellOffers(objects) {
  return (objects || [])
    .filter((obj) => obj && ((obj.Flags ?? 0) & TF_SELL_NFTOKEN) === TF_SELL_NFTOKEN && obj.index && obj.NFTokenID)
    .map((obj) => ({
      offerId: String(obj.index).toUpperCase(),
      amount: typeof obj.Amount === "string" && /^[0-9]+$/.test(obj.Amount) ? obj.Amount : null,
    }))
    .sort((a, b) => a.offerId.localeCompare(b.offerId));
}

function readAmm(result, expectedAccount) {
  const amm = result && result.amm;
  if (!amm || !ADDRESS_RE.test(amm.account || "")) return { ok: false, error: "amm_info omitted account" };
  if (expectedAccount && amm.account !== expectedAccount) {
    return { ok: false, error: "amm_info account is not the Foundry pool" };
  }
  let amountAeth = null;
  let amountXrp = null;
  for (const part of [amm.amount, amm.amount2]) {
    if (typeof part === "string" && /^[0-9]+$/.test(part)) amountXrp = part;
    else if (part && part.currency && part.currency !== "XRP" && part.value != null) amountAeth = String(part.value);
  }
  return {
    ok: true,
    account: amm.account,
    spot_xrp_per_aeth: amountAeth && amountXrp ? spotXrpPerAeth(amountXrp, amountAeth) : null,
  };
}

function readHook(objects, packHash) {
  const pack = String(packHash || "").toUpperCase();
  if (!HASH_RE.test(pack)) return { ok: false, error: "pack hook hash is not 64 hex" };
  const hooks = (objects || []).filter((row) => row && row.LedgerEntryType === "Hook");
  if (hooks.length !== 1) return { ok: false, error: `expected one Hook, found ${hooks.length}` };
  const hashes = [];
  for (const item of hooks[0].Hooks || []) {
    const hook = item.Hook || item;
    if (hook && hook.HookHash) hashes.push(String(hook.HookHash).toUpperCase());
  }
  if (hashes.length !== 1 || !HASH_RE.test(hashes[0])) {
    return { ok: false, error: "Hook object omitted HookHash" };
  }
  return { ok: true, matches: hashes[0] === pack };
}

async function rpc(fetchImpl, url, method, params) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const result = body && body.result;
  if (!res.ok || !result || result.status === "error" || result.error) {
    const detail = (result && (result.error_message || result.error)) || `HTTP ${res.status}`;
    throw new Error(`${method} failed: ${detail}`);
  }
  return result;
}

async function getText(fetchImpl, url) {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json, text/plain, */*" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { ok: Boolean(res.ok), status: res.status, text };
}

const GIT_REPO = "Hobie1Kenobi/aether-foundry";
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const GIT_PATHS = {
  metrics: "lab/metrics.json",
  pnl: "market/pnl.md",
  director: "lab/director-state.json",
  ledger: "lab/ledger-log.jsonl",
};
let mainShaCache = { sha: "", at: 0 };

function gitUrlsAtSha(sha) {
  const ref = String(sha || "").toLowerCase();
  if (!GIT_SHA_RE.test(ref)) throw new Error("refusing git ref");
  const base = `https://raw.githubusercontent.com/${GIT_REPO}/${ref}`;
  return {
    metrics: `${base}/${GIT_PATHS.metrics}`,
    pnl: `${base}/${GIT_PATHS.pnl}`,
    director: `${base}/${GIT_PATHS.director}`,
    ledger: `${base}/${GIT_PATHS.ledger}`,
  };
}

async function mainGitFiles(fetchImpl, opts) {
  if (typeof fetchImpl !== "function") throw new Error("git ref fetch is missing");
  const options = opts || {};
  const now = options.now == null ? Date.now() : options.now;
  const cacheMs = options.cacheMs == null ? 60000 : options.cacheMs;
  if (cacheMs > 0 && mainShaCache.sha && now - mainShaCache.at < cacheMs) {
    return gitUrlsAtSha(mainShaCache.sha);
  }
  const res = await fetchImpl(`https://api.github.com/repos/${GIT_REPO}/commits/main`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "aether-foundry-desk",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`git ref HTTP ${res.status}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("git ref is not JSON");
  }
  const sha = body && body.sha;
  if (!GIT_SHA_RE.test(String(sha || "").toLowerCase())) throw new Error("git ref omitted sha");
  const ref = String(sha).toLowerCase();
  if (cacheMs > 0) mainShaCache = { sha: ref, at: now };
  return gitUrlsAtSha(ref);
}

function networkIdOf(info) {
  const id = info && info.info ? info.info.network_id : undefined;
  if (id == null || id === "") return null;
  const num = Number(id);
  return Number.isInteger(num) ? num : null;
}

function ledgerSeq(state) {
  const seq = state && state.state && state.state.validated_ledger ? state.state.validated_ledger.seq : null;
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}

async function accountObjects(fetchImpl, url, params) {
  const objects = [];
  let marker;
  for (let page = 0; page < 4; page += 1) {
    const request = Object.assign({}, params);
    if (marker !== undefined) request.marker = marker;
    const result = await rpc(fetchImpl, url, "account_objects", request);
    objects.push(...(result.account_objects || []));
    if (result.marker == null) return objects;
    marker = result.marker;
  }
  throw new Error("account_objects pagination exceeded 4 pages");
}

function resolveCounts(metricsText, metricsStatus, pnlText, pnlStatus, errors) {
  if (metricsStatus === 200 && metricsText) {
    const parsed = parseMetrics(metricsText);
    if (parsed.ok) {
      return {
        counts: parsed.counts,
        heartbeat: parsed.last_heartbeat,
        oracle_id: parsed.oracle_id || null,
        oracle: parsed.oracle || emptyOracle(),
        mpt_issuance_id: parsed.mpt_issuance_id || null,
        domain_id: parsed.domain_id || null,
        x402_outbound_hits: parsed.x402_outbound_hits,
        metricsOk: true,
      };
    }
    errors.push(parsed.error);
    return { counts: null, heartbeat: null, oracle_id: null, oracle: emptyOracle(), mpt_issuance_id: null, domain_id: null, x402_outbound_hits: null, metricsOk: false };
  }
  if (metricsStatus != null && metricsStatus !== 404) errors.push(`metrics.json HTTP ${metricsStatus}`);
  if (pnlStatus === 200 && pnlText) {
    const parsed = parsePnlCounts(pnlText);
    if (parsed.errors.length) {
      errors.push(parsed.errors.join("; "));
      return { counts: null, heartbeat: null, oracle_id: null, oracle: emptyOracle(), mpt_issuance_id: null, domain_id: null, x402_outbound_hits: null, metricsOk: false };
    }
    return {
      counts: {
        x402_hits: parsed.counts.x402_hits,
        grants_paid: parsed.counts.grants_paid,
        inbound_counterparties: parsed.counts.inbound_counterparties,
      },
      heartbeat: null,
      oracle_id: null,
      oracle: emptyOracle(),
      mpt_issuance_id: null,
      domain_id: null,
      x402_outbound_hits: parsed.counts.x402_outbound_hits,
      metricsOk: false,
    };
  }
  errors.push(pnlStatus == null ? "pnl.md was not fetched" : `pnl.md HTTP ${pnlStatus}`);
  return { counts: null, heartbeat: null, oracle_id: null, oracle: emptyOracle(), mpt_issuance_id: null, domain_id: null, x402_outbound_hits: null, metricsOk: false };
}

function resolveHeartbeat(metricsBeat, ledgerText, ledgerStatus, errors) {
  const fromLog = ledgerStatus === 200 ? lastHeartbeatFromLog(ledgerText) : null;
  if (ledgerStatus != null && ledgerStatus !== 200) errors.push(`ledger-log HTTP ${ledgerStatus}`);
  if (fromLog && fromLog.hash) return fromLog;
  if (metricsBeat && metricsBeat.hash) return metricsBeat;
  return emptyHeartbeat();
}

function resolveDirector(text, status, errors) {
  if (status !== 200 || !text) {
    errors.push(status == null ? "director-state.json was not fetched" : `director-state.json HTTP ${status}`);
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    errors.push("director-state.json is not JSON");
    return null;
  }
  try {
    assertPublic(doc);
  } catch {
    errors.push("director-state.json refused");
    return null;
  }
  const stamp = doc && typeof doc.updated_at === "string" ? doc.updated_at : "";
  if (!stamp || Number.isNaN(Date.parse(stamp))) {
    errors.push("director-state.json updated_at missing");
    return null;
  }
  return stamp;
}

async function loadXrpl(opts, errors) {
  const checked = httpsUrl(opts.xrplHttp);
  if (checked.error) {
    errors.push(checked.error);
    return { network: null, ledger_index: null, walk_in: baseStatus().walk_in, amm: baseStatus().amm, batch: null, oracle_id: null, oracle: emptyOracle() };
  }
  try {
    const info = await rpc(opts.fetch, checked.url, "server_info", {});
    const id = networkIdOf(info);
    if (id !== 1) {
      errors.push(id == null ? "RPC did not prove XRPL network id" : `refusing network id ${id}`);
      return { network: null, ledger_index: null, walk_in: baseStatus().walk_in, amm: baseStatus().amm, batch: null, oracle_id: null, oracle: emptyOracle() };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { network: null, ledger_index: null, walk_in: baseStatus().walk_in, amm: baseStatus().amm, batch: null, oracle_id: null, oracle: emptyOracle() };
  }
  const out = {
    network: "xrpl:1",
    ledger_index: null,
    walk_in: { status: "error", offer_id: "", amount_drops: null },
    amm: { account: "", spot_xrp_per_aeth: null },
    batch: null,
    oracle_id: null,
    oracle: emptyOracle(),
  };
  try {
    const state = await rpc(opts.fetch, checked.url, "server_state", {});
    const seq = ledgerSeq(state);
    if (seq == null) errors.push("server_state omitted validated_ledger.seq");
    else out.ledger_index = seq;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const objects = await accountObjects(opts.fetch, checked.url, {
      account: opts.w2,
      type: "nft_offer",
      ledger_index: "validated",
      limit: 200,
    });
    const offers = sellOffers(objects).filter((row) => HASH_RE.test(row.offerId));
    if (!offers.length) {
      out.walk_in = { status: "sold_out", offer_id: "", amount_drops: opts.walkInDrops || "10000000" };
    } else if (!offers[0].amount) {
      errors.push("walk-in amount is not XRP drops");
      out.walk_in = { status: "open", offer_id: offers[0].offerId, amount_drops: null };
    } else {
      out.walk_in = { status: "open", offer_id: offers[0].offerId, amount_drops: offers[0].amount };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const amm = await rpc(opts.fetch, checked.url, "amm_info", {
      asset: { currency: opts.aethCurrency, issuer: opts.aethIssuer },
      asset2: { currency: "XRP" },
      ledger_index: "validated",
    });
    const read = readAmm(amm, opts.ammAccount);
    if (!read.ok) errors.push(read.error);
    else out.amm = { account: read.account, spot_xrp_per_aeth: read.spot_xrp_per_aeth };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (opts.w5 && ADDRESS_RE.test(opts.w5)) {
    const documentId = opts.oracleDocumentId == null ? 1 : opts.oracleDocumentId;
    try {
      const entry = await rpc(opts.fetch, checked.url, "ledger_entry", {
        oracle: { account: opts.w5, oracle_document_id: documentId },
        ledger_index: "validated",
      });
      const read = readLedgerOracle(entry, opts.w5, documentId);
      if (!read.ok) errors.push(read.error);
      else {
        out.oracle_id = read.oracle_id;
        out.oracle = read.oracle;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/entryNotFound|actNotFound/i.test(message)) errors.push(message);
    }
  }
  try {
    const feature = await rpc(opts.fetch, checked.url, "feature", {});
    const batch = readBatch(feature);
    if (!batch.ok) errors.push(batch.error);
    else out.batch = batch.atomic_enabled;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return out;
}

async function loadHook(opts, errors) {
  const checked = httpsUrl(opts.xahauHttp);
  if (checked.error) {
    errors.push(checked.error);
    return null;
  }
  try {
    const info = await rpc(opts.fetch, checked.url, "server_info", {});
    const id = networkIdOf(info);
    if (id !== 21338) {
      errors.push(id == null ? "RPC did not prove Xahau network id" : `refusing Xahau network id ${id}`);
      return null;
    }
    const objects = await accountObjects(opts.fetch, checked.url, {
      account: opts.w7,
      type: "hook",
      ledger_index: "validated",
      limit: 200,
    });
    const hook = readHook(objects, opts.packHookHash);
    if (!hook.ok) {
      errors.push(hook.error);
      return null;
    }
    return hook.matches;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function collectStatus(opts) {
  const options = opts || {};
  const errors = [];
  if (typeof options.fetch !== "function") {
    return baseStatus("status fetch is missing");
  }
  const git = options.git || {};
  const [metricsRes, pnlRes, directorRes, ledgerRes, xrpl, hook] = await Promise.all([
    git.metrics ? getText(options.fetch, git.metrics).catch((error) => ({ ok: false, status: 0, text: "", error })) : Promise.resolve(null),
    git.pnl ? getText(options.fetch, git.pnl).catch((error) => ({ ok: false, status: 0, text: "", error })) : Promise.resolve(null),
    git.director ? getText(options.fetch, git.director).catch((error) => ({ ok: false, status: 0, text: "", error })) : Promise.resolve(null),
    git.ledger ? getText(options.fetch, git.ledger).catch((error) => ({ ok: false, status: 0, text: "", error })) : Promise.resolve(null),
    loadXrpl(options, errors),
    loadHook(options, errors),
  ]);
  if (metricsRes && metricsRes.error) errors.push("metrics.json fetch failed");
  if (pnlRes && pnlRes.error) errors.push("pnl.md fetch failed");
  if (directorRes && directorRes.error) errors.push("director-state.json fetch failed");
  if (ledgerRes && ledgerRes.error) errors.push("ledger-log fetch failed");
  const counts = resolveCounts(
    metricsRes && metricsRes.text,
    metricsRes && metricsRes.status,
    pnlRes && pnlRes.text,
    pnlRes && pnlRes.status,
    errors
  );
  const director = resolveDirector(directorRes && directorRes.text, directorRes && directorRes.status, errors);
  const heartbeat = resolveHeartbeat(
    counts.heartbeat,
    ledgerRes && ledgerRes.text,
    ledgerRes && ledgerRes.status,
    errors
  );
  const deskFacilitator = facilitator.publicFacilitator(options.env || {});
  if (deskFacilitator.mode === "refused") {
    errors.push(deskFacilitator.error || "facilitator env refused");
  }
  const body = {
    network: xrpl.network,
    desk: "read-only",
    ledger_index: xrpl.ledger_index,
    walk_in: xrpl.walk_in,
    amm: xrpl.amm,
    batch_atomic_enabled: xrpl.batch,
    w7_hook_matches_pack: hook,
    x402_hits: counts.counts ? counts.counts.x402_hits : null,
    x402_outbound_hits: counts.x402_outbound_hits == null ? null : counts.x402_outbound_hits,
    x402_foreign_hits:
      ledgerRes && ledgerRes.status === 200
        ? facilitator.countForeignX402Hits(ledgerRes.text, options.labeled)
        : null,
    grants_paid: counts.counts ? counts.counts.grants_paid : null,
    facilitator: deskFacilitator,
    inbound_counterparties: counts.counts ? counts.counts.inbound_counterparties : null,
    last_heartbeat: heartbeat,
    oracle_id: xrpl.oracle_id || (counts.oracle_id || null),
    oracle: xrpl.oracle_id ? xrpl.oracle : (counts.oracle_id ? counts.oracle : xrpl.oracle),
    mpt_issuance_id: counts.mpt_issuance_id || null,
    domain_id: counts.domain_id || null,
    director_updated_at: director,
    laws: LAWS.slice(),
  };
  if (errors.length) body.error = errors.join("; ");
  try {
    assertPublic(body);
  } catch {
    return baseStatus("status refused a secret-shaped field");
  }
  return body;
}

module.exports = {
  LAWS,
  parsePnlCounts,
  parseMetrics,
  lastHeartbeatFromLog,
  spotXrpPerAeth,
  readBatch,
  readLedgerOracle,
  collectStatus,
  httpsUrl,
  gitUrlsAtSha,
  mainGitFiles,
};
