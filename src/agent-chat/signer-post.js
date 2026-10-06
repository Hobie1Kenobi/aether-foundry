"use strict";

/**
 * Loopback signer client for net-chat live frames.
 * The desk never calls this. CI and Vercel never call this.
 */

const protocol = require("./protocol");

function assertLiveEnv(env) {
  const source = env || {};
  if (source.CI || source.GITHUB_ACTIONS || source.VERCEL) {
    throw protocol.coded("refusing to sign under CI or on the desk");
  }
  if (source.FOUNDRY_AGENT_SIGN !== "yes") {
    throw protocol.coded("refusing to sign without FOUNDRY_AGENT_SIGN=yes");
  }
  if (source.AETHER_NET_CHAT_LIVE !== "yes") {
    throw protocol.coded("refusing to sign without AETHER_NET_CHAT_LIVE=yes");
  }
  const token = String(source.FOUNDRY_SIGNER_TOKEN || "");
  if (token.length < 16) throw protocol.coded("refusing empty signer token");
  return source;
}

function signerBase(env) {
  const source = env || {};
  const host = String(source.FOUNDRY_SIGNER_BIND || "127.0.0.1").trim().toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw protocol.coded("refusing non-loopback signer");
  }
  const port = Number(source.FOUNDRY_SIGNER_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw protocol.coded("refusing signer port");
  }
  const hostname = host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${hostname}:${port}`;
}

function redact(text, secrets) {
  let out = String(text || "");
  for (const secret of secrets || []) {
    if (secret) out = out.split(String(secret)).join("[redacted]");
  }
  return out;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: "signer body is not JSON" };
  }
}

async function signerHealth(env, fetchImpl) {
  assertLiveEnv(env);
  const base = signerBase(env);
  const fetchFn = fetchImpl || globalThis.fetch;
  const response = await fetchFn(`${base}/health`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const body = await readJson(response);
  if (!response.ok || !body || body.signing !== true) {
    throw protocol.coded("signer health is not signing");
  }
  if (Number(body.network_id) !== protocol.NETWORK_ID) {
    throw protocol.coded(`refusing signer network id ${body.network_id}`);
  }
  return body;
}

async function postSign(env, payload, fetchImpl) {
  const source = assertLiveEnv(env);
  const base = signerBase(source);
  const token = String(source.FOUNDRY_SIGNER_TOKEN);
  const fetchFn = fetchImpl || globalThis.fetch;
  await signerHealth(source, fetchFn);
  const response = await fetchFn(`${base}/sign`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await readJson(response);
  const packed = JSON.stringify(body || {});
  if (packed.includes(token)) throw protocol.coded("signer echoed the token");
  if (!response.ok || !body || body.result !== "tesSUCCESS") {
    const message = body && body.error ? body.error : "signer did not return tesSUCCESS";
    throw protocol.coded(redact(message, [token]));
  }
  const hash = String(body.hash || "").toUpperCase();
  if (!protocol.HASH_RE.test(hash)) throw protocol.coded("signer omitted a ledger hash");
  const ledgerNum = Number(body.ledger_index);
  return {
    hash,
    ledger_index: Number.isInteger(ledgerNum) && ledgerNum > 0 ? ledgerNum : null,
    result: "tesSUCCESS",
  };
}

module.exports = {
  assertLiveEnv,
  signerBase,
  redact,
  signerHealth,
  postSign,
};
