"use strict";

/**
 * Approved XRPL Testnet RPC hosts.
 * rippletest.net stays a suffix (Ripple's own testnet family, including the faucet).
 * XRPL Labs is an exact host: testnet.xrpl-labs.com. Not *.xrpl-labs.com, and not xrpl.ws.
 */

const PRIMARY_HOST = "s.altnet.rippletest.net";
const PRIMARY_HTTP = "https://s.altnet.rippletest.net:51234";
const PRIMARY_WS = "wss://s.altnet.rippletest.net:51233";
const LABS_HOST = "testnet.xrpl-labs.com";
const LABS_HTTP = "https://testnet.xrpl-labs.com";
const LABS_WS = "wss://testnet.xrpl-labs.com";

function isRippleTestnetHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "rippletest.net" || host.endsWith(".rippletest.net");
}

function isLabsTestnetHost(hostname) {
  return String(hostname || "").toLowerCase() === LABS_HOST;
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
  if (url.protocol === "https:") return LABS_HTTP;
  if (url.protocol === "http:") return "http://testnet.xrpl-labs.com";
  if (url.protocol === "wss:") return LABS_WS;
  if (url.protocol === "ws:") return "ws://testnet.xrpl-labs.com";
  return null;
}

function candidates(raw) {
  const next = fallbackUrl(raw);
  return next ? [raw, next] : [raw];
}

function matchingWs(httpUrl, configuredWs) {
  try {
    if (isLabsTestnetHost(new URL(httpUrl).hostname)) return LABS_WS;
  } catch {
    /* keep the configured socket */
  }
  return configuredWs;
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
    code === "BIND"
  ) {
    return false;
  }
  const name = String(error.name || "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = String(error.message || error);
  if (/refusing|mainnet|network id|NetworkID/i.test(message)) return false;
  return /fetch failed|timed out|timeout|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|network error|other side closed|UND_ERR|HTTP 5\d\d|non-JSON/i.test(message);
}

module.exports = {
  PRIMARY_HOST,
  PRIMARY_HTTP,
  PRIMARY_WS,
  LABS_HOST,
  LABS_HTTP,
  LABS_WS,
  isRippleTestnetHost,
  isLabsTestnetHost,
  isPrimaryHost,
  isApprovedXrplTestnetHost,
  fallbackUrl,
  candidates,
  matchingWs,
  isTransportFailure,
};
