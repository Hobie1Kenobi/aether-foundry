"use strict";

/**
 * Approved XRPL Testnet RPC hosts.
 * Primary is XRPL Labs (https://testnet.xrpl-labs.com, wss://testnet.xrpl-labs.com), network id 1.
 * Ripple's s.altnet.rippletest.net is the one-shot fallback (HTTP :51234, WS :51233).
 * rippletest.net stays a suffix (Ripple's own testnet family, including the faucet).
 * XRPL Labs is an exact host: testnet.xrpl-labs.com. Not *.xrpl-labs.com, and not xrpl.ws.
 * The faucet stays on faucet.altnet.rippletest.net. Labs has no faucet.
 *
 * Env overrides, when a caller passes them through resolveHttp / resolveWs:
 *   FOUNDRY_XRPL_HTTP, XRPL_HTTP, XRPL_RPC_URL
 *   XRPL_WS_URL, XRPL_WS, FOUNDRY_XRPL_WS
 */

const LABS_HOST = "testnet.xrpl-labs.com";
const LABS_HTTP = "https://testnet.xrpl-labs.com";
const LABS_WS = "wss://testnet.xrpl-labs.com";

const ALTNET_HOST = "s.altnet.rippletest.net";
const ALTNET_HTTP = "https://s.altnet.rippletest.net:51234";
const ALTNET_WS = "wss://s.altnet.rippletest.net:51233";
const FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";

const PRIMARY_HOST = LABS_HOST;
const PRIMARY_HTTP = LABS_HTTP;
const PRIMARY_WS = LABS_WS;
const FALLBACK_HOST = ALTNET_HOST;
const FALLBACK_HTTP = ALTNET_HTTP;
const FALLBACK_WS = ALTNET_WS;

function isRippleTestnetHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "rippletest.net" || host.endsWith(".rippletest.net");
}

function isLabsTestnetHost(hostname) {
  return String(hostname || "").toLowerCase() === LABS_HOST;
}

function isAltnetHost(hostname) {
  return String(hostname || "").toLowerCase() === ALTNET_HOST;
}

function isPrimaryHost(hostname) {
  return String(hostname || "").toLowerCase() === PRIMARY_HOST;
}

function isApprovedXrplTestnetHost(hostname) {
  return isRippleTestnetHost(hostname) || isLabsTestnetHost(hostname);
}

function fallbackUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isPrimaryHost(url.hostname)) return null;
  if (url.protocol === "https:") return FALLBACK_HTTP;
  if (url.protocol === "http:") return "http://s.altnet.rippletest.net:51234";
  if (url.protocol === "wss:") return FALLBACK_WS;
  if (url.protocol === "ws:") return "ws://s.altnet.rippletest.net:51233";
  return null;
}

function candidates(raw) {
  const next = fallbackUrl(raw);
  return next ? [raw, next] : [raw];
}

function matchingWs(httpUrl, configuredWs) {
  try {
    const httpHost = new URL(httpUrl).hostname.toLowerCase();
    let configuredHost = "";
    try {
      configuredHost = new URL(configuredWs).hostname.toLowerCase();
    } catch {
      configuredHost = "";
    }
    if (configuredHost && httpHost === configuredHost) return configuredWs;
    if (isLabsTestnetHost(httpHost)) return LABS_WS;
    if (isAltnetHost(httpHost)) return ALTNET_WS;
  } catch {
    /* keep the configured socket */
  }
  return configuredWs;
}

function endpointPair(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (isLabsTestnetHost(host)) return { http: LABS_HTTP, ws: LABS_WS };
  if (isAltnetHost(host)) return { http: ALTNET_HTTP, ws: ALTNET_WS };
  return null;
}

function firstSet(source, keys) {
  const env = source || {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function resolveHttp(env, override) {
  if (override != null && String(override).trim()) return String(override).trim();
  return firstSet(env, ["FOUNDRY_XRPL_HTTP", "XRPL_HTTP", "XRPL_RPC_URL"]) || PRIMARY_HTTP;
}

function resolveWs(env, override) {
  if (override != null && String(override).trim()) return String(override).trim();
  return firstSet(env, ["XRPL_WS_URL", "XRPL_WS", "FOUNDRY_XRPL_WS"]) || PRIMARY_WS;
}

function isTransportFailure(error) {
  if (!error) return false;
  const code = error.code;
  if (
    code === "MAINNET" ||
    code === "W0" ||
    code === "HOST" ||
    code === "SCHEMA" ||
    code === "XAHAU" ||
    code === "CI" ||
    code === "AGENT_SIGN" ||
    code === "TOKEN" ||
    code === "BIND" ||
    code === "invalid_network"
  ) {
    return false;
  }
  const name = String(error.name || "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = String(error.message || error);
  if (/refusing|mainnet|network id|NetworkID/i.test(message)) return false;
  return /fetch failed|timed out|timeout|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|network error|other side closed|UND_ERR|HTTP 5\d\d|non-JSON/i.test(message);
}

async function withFailover(rawUrl, attempt) {
  const urls = candidates(rawUrl);
  let last;
  for (let i = 0; i < urls.length; i += 1) {
    try {
      return await attempt(urls[i], i);
    } catch (error) {
      last = error;
      if (i === urls.length - 1 || !isTransportFailure(error)) throw error;
    }
  }
  throw last;
}

async function openClient(rawWs, options = {}) {
  const expectId = Object.prototype.hasOwnProperty.call(options, "networkId") ? options.networkId : 1;
  const assertUrl = options.assertUrl;
  return withFailover(rawWs, async (url) => {
    if (typeof assertUrl === "function") assertUrl(url);
    const xrpl = options.xrpl || require("xrpl");
    const client = options.clientFactory ? options.clientFactory(url) : new xrpl.Client(url);
    try {
      if (client.connect) await client.connect();
      if (expectId !== false && client.request) {
        const info = await client.request({ command: "server_info" });
        const id = info && info.result && info.result.info ? info.result.info.network_id : undefined;
        if (Number(id) !== Number(expectId)) {
          throw Object.assign(new Error(`refusing network id ${id == null ? "missing" : id}`), { code: "MAINNET" });
        }
      }
      return client;
    } catch (error) {
      if (client && client.disconnect) {
        try {
          await client.disconnect();
        } catch {
          /* already closed */
        }
      }
      throw error;
    }
  });
}

async function fundFromRippleFaucet(wallet, options = {}) {
  const xrpl = options.xrpl || require("xrpl");
  const client = new xrpl.Client(ALTNET_WS);
  await client.connect();
  try {
    const info = await client.request({ command: "server_info" });
    const id = info && info.result && info.result.info ? info.result.info.network_id : undefined;
    if (Number(id) !== 1) {
      throw Object.assign(new Error(`refusing network id ${id == null ? "missing" : id}`), { code: "MAINNET" });
    }
    return await client.fundWallet(wallet);
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

module.exports = {
  PRIMARY_HOST,
  PRIMARY_HTTP,
  PRIMARY_WS,
  FALLBACK_HOST,
  FALLBACK_HTTP,
  FALLBACK_WS,
  LABS_HOST,
  LABS_HTTP,
  LABS_WS,
  ALTNET_HOST,
  ALTNET_HTTP,
  ALTNET_WS,
  FAUCET_URL,
  isRippleTestnetHost,
  isLabsTestnetHost,
  isAltnetHost,
  isPrimaryHost,
  isApprovedXrplTestnetHost,
  fallbackUrl,
  candidates,
  matchingWs,
  endpointPair,
  resolveHttp,
  resolveWs,
  isTransportFailure,
  withFailover,
  openClient,
  fundFromRippleFaucet,
};
