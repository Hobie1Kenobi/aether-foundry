#!/usr/bin/env node
"use strict";

/**
 * Inbound MCP tools. Read tools are seedless. Buy tools return a delegated
 * argv and do not sign. MCP_SIGN=off is the default.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const runtimePolicy = require("../runtime/policy");

const CATALOG_PATH = path.join(anchors.repoRoot(), "machines", "inbound-mcp", "tools.json");
const DESK_URL = String(anchors.DESK_URL).replace(/\/$/, "");
const XRPL_HTTP = anchors.XRPL_HTTP;
const SKUS = ["machine-spec", "reserve-audit", "composition-quote"];
const WALK_IN_DRY = "npm run buy:walk-in -- --dry-run";

function signingEnabled(env) {
  return String((env && env.MCP_SIGN) || "off").trim().toLowerCase() === "on";
}

function loadCatalog(file) {
  const target = file || CATALOG_PATH;
  const doc = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!doc || !Array.isArray(doc.tools)) {
    throw runtimePolicy.coded("inbound MCP catalog has no tools", "SCHEMA");
  }
  return doc;
}

function listTools(file) {
  return loadCatalog(file).tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

function findTool(name, file) {
  return loadCatalog(file).tools.find((tool) => tool.name === name) || null;
}

function resolveIo(io) {
  const input = io || {};
  const env = input.env || process.env;
  return {
    env,
    fetch: input.fetch || globalThis.fetch,
    deskUrl: String(input.deskUrl || env.DESK_URL || DESK_URL).replace(/\/$/, ""),
    xrplHttp: String(input.xrplHttp || env.XRPL_HTTP || env.XRPL_RPC_URL || XRPL_HTTP).replace(/\/$/, ""),
    statePath: input.statePath || path.join(anchors.repoRoot(), "lab", "director-state.json"),
    readFileSync: input.readFileSync || fs.readFileSync,
    existsSync: input.existsSync || fs.existsSync,
    log: input.log || ((line) => console.error(line)),
    now: input.now || new Date(),
    engine: input.engine || null,
    scanArgv: input.scanArgv,
    scanIo: input.scanIo,
    catalogFile: input.catalogFile,
  };
}

function rejectForbidden(args, io) {
  try {
    runtimePolicy.assertNoSeedFields(args == null ? {} : args);
  } catch {
    io.log("mcp rejected forbidden argument name");
    throw runtimePolicy.coded("refusing forbidden argument name", "FORBIDDEN_ARG");
  }
}

function assertSchema(tool, args) {
  const schema = tool.inputSchema || { type: "object", properties: {}, additionalProperties: false };
  const props = schema.properties || {};
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw runtimePolicy.coded("arguments must be an object", "ARGS");
  }
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      throw runtimePolicy.coded(`unknown argument ${key}`, "ARGS");
    }
  }
  for (const key of schema.required || []) {
    if (args[key] == null || args[key] === "") {
      throw runtimePolicy.coded(`missing ${key}`, "ARGS");
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (args[key] == null) continue;
    const value = args[key];
    if (spec.type === "boolean" && typeof value !== "boolean") {
      throw runtimePolicy.coded(`${key} must be a boolean`, "ARGS");
    }
    if (spec.type === "integer") {
      const min = spec.minimum == null ? 0 : spec.minimum;
      if (!Number.isInteger(value) || value < min) {
        throw runtimePolicy.coded(`${key} must be an integer`, "ARGS");
      }
    }
    if (spec.type === "string" && typeof value !== "string") {
      throw runtimePolicy.coded(`${key} must be a string`, "ARGS");
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw runtimePolicy.coded(`${key} is not allowed`, "ARGS");
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      throw runtimePolicy.coded(`${key} does not match`, "ARGS");
    }
  }
  return args;
}

async function readResponse(res) {
  const status = res && res.status != null ? Number(res.status) : 0;
  let text = "";
  if (res && typeof res.text === "function") text = await res.text();
  else if (res && typeof res.body === "string") text = res.body;
  runtimePolicy.assertPrintSafe(text);
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (body) runtimePolicy.assertNoSeedFields(body);
  const ok = res && typeof res.ok === "boolean" ? res.ok : status >= 200 && status < 300;
  return { status, ok, body };
}

async function requestJson(io, url, init) {
  runtimePolicy.assertHostAllowed(url);
  const res = await io.fetch(url, init);
  return readResponse(res);
}

function assertDeskNetwork(body) {
  if (!body || typeof body !== "object") return;
  if (body.network === "xrpl:0" || body.refusedNetwork === "xrpl:1") {
    throw runtimePolicy.coded("refusing mainnet network id 0", "MAINNET");
  }
  if (body.networkId != null) runtimePolicy.assertAltnet({ networkId: body.networkId });
  if (typeof body.rpc === "string") runtimePolicy.assertHostAllowed(body.rpc);
}

function projectWalkIn(body) {
  const offers = Array.isArray(body && body.offers)
    ? body.offers.map((offer) => ({
        offerId: offer.offerId || null,
        nftokenId: offer.nftokenId || null,
        amount: offer.amount || null,
        priceXrp: offer.priceXrp || null,
      }))
    : [];
  return {
    signing: "none",
    deskSigns: false,
    networkId: body && body.networkId != null ? Number(body.networkId) : null,
    status: body && body.status ? body.status : null,
    seller: body && body.seller ? body.seller : null,
    offers,
    error: body && body.error ? body.error : null,
  };
}

async function walkInStatus(io) {
  const url = `${io.deskUrl}/api/inbound/walk-in`;
  const res = await requestJson(io, url, { method: "GET", headers: { accept: "application/json" } });
  assertDeskNetwork(res.body);
  if (!res.body) throw runtimePolicy.coded("walk-in desk response was not JSON", "RPC");
  const projected = projectWalkIn(res.body);
  projected.httpStatus = res.status;
  runtimePolicy.assertNoSeedFields(projected);
  return projected;
}

async function x402Catalog(io) {
  const url = `${io.deskUrl}/api/x402`;
  const res = await requestJson(io, url, { method: "GET", headers: { accept: "application/json" } });
  assertDeskNetwork(res.body);
  if (!res.body) throw runtimePolicy.coded("x402 catalog was not JSON", "RPC");
  const payload = {
    signing: "none",
    deskSigns: false,
    httpStatus: res.status,
    catalog: res.body,
  };
  runtimePolicy.assertNoSeedFields(payload);
  return payload;
}

function summarizeState(raw, now) {
  runtimePolicy.assertNoSeedFields(raw);
  const xrpl = raw.networks && raw.networks.xrpl_testnet;
  const xahau = raw.networks && raw.networks.xahau_testnet;
  if (xrpl && xrpl.network_id != null) runtimePolicy.assertAltnet({ networkId: xrpl.network_id });
  if (xahau && xahau.network_id != null) {
    runtimePolicy.assertAltnet({ networkId: xahau.network_id, kind: "xahau" });
  }
  let stale = null;
  try {
    stale = runtimePolicy.isStale(raw, now);
  } catch {
    stale = null;
  }
  return {
    available: true,
    updated_at: raw.updated_at || null,
    last_session_id: raw.last_session_id == null ? null : raw.last_session_id,
    stale,
    xrpl_network_id: xrpl && xrpl.network_id != null ? xrpl.network_id : null,
    xrpl_validated_ledger_index: xrpl && xrpl.validated_ledger_index != null ? xrpl.validated_ledger_index : null,
    xahau_network_id: xahau && xahau.network_id != null ? xahau.network_id : null,
    xahau_validated_ledger_index:
      xahau && xahau.validated_ledger_index != null ? xahau.validated_ledger_index : null,
    next_actions: Array.isArray(raw.next_actions) ? raw.next_actions.slice(0, 3) : [],
    blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
  };
}

function readDirector(io) {
  if (!io.existsSync(io.statePath)) return { available: false, error: "director-state.json missing" };
  let raw;
  try {
    raw = JSON.parse(io.readFileSync(io.statePath, "utf8"));
  } catch {
    return { available: false, error: "director-state.json unreadable" };
  }
  try {
    return summarizeState(raw, io.now);
  } catch (error) {
    if (error.code === "MAINNET") throw error;
    return { available: false, error: "director-state.json refused" };
  }
}

async function directorStatus(io) {
  const state = readDirector(io);
  const url = `${io.deskUrl}/api/status`;
  let desk;
  try {
    const res = await requestJson(io, url, { method: "GET", headers: { accept: "application/json" } });
    if (res.status === 404) {
      desk = { available: false, status: 404 };
    } else if (!res.ok || !res.body) {
      desk = { available: false, status: res.status };
    } else {
      assertDeskNetwork(res.body);
      desk = { available: true, status: res.status, body: res.body };
    }
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "SCHEMA" || error.code === "SEED")) throw error;
    desk = { available: false, status: null };
  }
  const payload = { signing: "none", deskSigns: false, state, desk };
  runtimePolicy.assertNoSeedFields(payload);
  return payload;
}

async function grantEligibility(io) {
  const engine = io.engine || require("../grants/engine");
  const argv = Array.isArray(io.scanArgv) ? io.scanArgv.slice() : [];
  const scanIo = io.scanIo || { env: { XRPL_HTTP: io.xrplHttp } };
  const result = await engine.executeScan(argv, scanIo);
  const report = (result && result.report) || {};
  const excluded = Array.isArray(report.excluded) ? report.excluded : [];
  const payload = {
    signing: "none",
    signed: false,
    readOnly: true,
    selectable: (report.selectable || []).map((row) => ({
      address: row.address,
      reason: row.reason,
      sources: row.sources || [],
      evidence: row.evidence || null,
    })),
    excluded_labeled: excluded.filter((row) => row.why === "labeled").length,
    excluded_cooldown: excluded.filter((row) => row.why === "cooldown").length,
    rpcError: report.rpcError || null,
    text: result && result.text ? result.text : "",
  };
  runtimePolicy.assertPrintSafe(JSON.stringify(payload));
  runtimePolicy.assertNoSeedFields(payload);
  return payload;
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
  const fracOut = (rem * 1000000n / den).toString().padStart(6, "0").replace(/0+$/, "");
  return fracOut ? `${wholeOut}.${fracOut}` : String(wholeOut);
}

function readPool(result) {
  const amm = result && result.amm;
  if (!amm || !amm.account) throw runtimePolicy.coded("amm_info omitted account", "RPC");
  let amountAeth = null;
  let amountXrp = null;
  for (const part of [amm.amount, amm.amount2]) {
    if (typeof part === "string" && /^[0-9]+$/.test(part)) amountXrp = part;
    else if (part && part.currency && part.currency !== "XRP" && part.value != null) amountAeth = String(part.value);
  }
  const ledger = result.validated === true && Number.isInteger(result.ledger_index) ? result.ledger_index : null;
  return {
    account: amm.account,
    amount_aeth: amountAeth,
    amount_xrp_drops: amountXrp,
    spot_xrp_per_aeth: amountAeth && amountXrp ? spotXrpPerAeth(amountXrp, amountAeth) : null,
    ledger_index: ledger,
  };
}

async function rpcCall(io, method, params) {
  const url = runtimePolicy.assertSigningRpc(io.xrplHttp);
  const res = await requestJson(io, url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  const result = res.body && res.body.result;
  if (!result || result.error || result.status === "error") {
    throw runtimePolicy.coded(`RPC ${method} failed`, "RPC");
  }
  return result;
}

async function ammQuote(io) {
  const info = await rpcCall(io, "server_info", {});
  const networkId = info.info && info.info.network_id;
  if (networkId == null || networkId === "") {
    throw runtimePolicy.coded("RPC did not prove network id", "RPC");
  }
  runtimePolicy.assertAltnet({ networkId, url: io.xrplHttp });
  const amm = readPool(await rpcCall(io, "amm_info", {
    asset: { currency: "XRP" },
    asset2: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address },
    ledger_index: "validated",
  }));
  const quoteUrl = `${io.deskUrl}/api/x402/composition-quote`;
  let deskComposition = { url: quoteUrl, unpaid: null, paid: false, httpStatus: null };
  try {
    const res = await requestJson(io, quoteUrl, { method: "GET", headers: { accept: "application/json" } });
    deskComposition = {
      url: quoteUrl,
      httpStatus: res.status,
      unpaid: res.status === 402,
      paid: false,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "SCHEMA" || error.code === "SEED")) throw error;
    deskComposition = { url: quoteUrl, unpaid: null, paid: false, httpStatus: null };
  }
  const payload = {
    signing: "none",
    deskSigns: false,
    paid: false,
    network_id: Number(networkId),
    amm,
    desk_composition: deskComposition,
  };
  runtimePolicy.assertNoSeedFields(payload);
  return payload;
}

function shellQuote(token) {
  const text = String(token);
  if (/^[A-Za-z0-9_.:/=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function commandFromArgv(argv) {
  return argv.map(shellQuote).join(" ");
}

function walkInWouldSign(argv) {
  return argv.includes("--faucet") || argv.includes("--record") || argv.includes("--with-aeth") || !argv.includes("--dry-run");
}

function walkInBuy(args, io) {
  if (!signingEnabled(io.env)) {
    return {
      delegated: true,
      signed: false,
      executed: false,
      command: WALK_IN_DRY,
      argv: ["npm", "run", "buy:walk-in", "--", "--dry-run"],
    };
  }
  if (args.dry_run && args.record) {
    throw runtimePolicy.coded("--record needs a submitted hash; omit it on --dry-run", "ARGS");
  }
  const argv = ["npm", "run", "buy:walk-in", "--"];
  if (args.dry_run) argv.push("--dry-run");
  if (args.faucet) argv.push("--faucet");
  if (args.with_aeth) argv.push("--with-aeth");
  if (args.offer_id) argv.push("--offer", String(args.offer_id).toUpperCase());
  if (args.record) argv.push("--record");
  if (argv.length === 4) argv.push("--dry-run");
  if (walkInWouldSign(argv)) runtimePolicy.assertNotCi(io.env);
  return {
    delegated: true,
    signed: false,
    executed: false,
    command: commandFromArgv(argv),
    argv,
  };
}

function x402Buy(args, io) {
  const sku = args.sku;
  if (!SKUS.includes(sku)) throw runtimePolicy.coded("unknown sku", "ARGS");
  const argv = ["npm", "run", "x402:pay", "--", sku];
  if (!signingEnabled(io.env)) {
    return {
      delegated: true,
      signed: false,
      executed: false,
      command: commandFromArgv(argv),
      argv,
      desk: io.deskUrl,
    };
  }
  runtimePolicy.assertNotCi(io.env);
  if (args.prompt) argv.push("--prompt", args.prompt);
  if (args.units != null) argv.push("--units", String(args.units));
  if (args.record) argv.push("--record");
  return {
    delegated: true,
    signed: false,
    executed: false,
    command: commandFromArgv(argv),
    argv,
    desk: io.deskUrl,
  };
}

async function callTool(name, args, io) {
  const ctx = resolveIo(io);
  rejectForbidden(args, ctx);
  const tool = findTool(name, ctx.catalogFile);
  if (!tool) throw runtimePolicy.coded(`unknown tool ${name}`, "UNKNOWN_TOOL");
  const parsed = assertSchema(tool, args || {});
  let payload;
  if (name === "walk_in_status") payload = await walkInStatus(ctx);
  else if (name === "x402_catalog") payload = await x402Catalog(ctx);
  else if (name === "director_status") payload = await directorStatus(ctx);
  else if (name === "grant_eligibility") payload = await grantEligibility(ctx);
  else if (name === "amm_quote") payload = await ammQuote(ctx);
  else if (name === "walk_in_buy") payload = walkInBuy(parsed, ctx);
  else if (name === "x402_buy") payload = x402Buy(parsed, ctx);
  else throw runtimePolicy.coded(`unknown tool ${name}`, "UNKNOWN_TOOL");
  runtimePolicy.assertPrintSafe(JSON.stringify(payload));
  runtimePolicy.assertNoSeedFields(payload);
  return payload;
}

module.exports = {
  CATALOG_PATH,
  DESK_URL,
  XRPL_HTTP,
  WALK_IN_DRY,
  signingEnabled,
  loadCatalog,
  listTools,
  findTool,
  resolveIo,
  rejectForbidden,
  callTool,
  spotXrpPerAeth,
  projectWalkIn,
};
