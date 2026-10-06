"use strict";

/**
 * Ollama chat client. Cloud default is https://ollama.com model glm-5.3-flash.
 * AETHER_SCRIBE_MOCK=1 skips the network. The API key is never logged.
 */

const protocol = require("./protocol");
const signerPost = require("./signer-post");

function ollamaBase(env) {
  const raw = String((env && env.OLLAMA_BASE_URL) || protocol.OLLAMA_BASE_URL).replace(/\/$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw protocol.coded("refusing OLLAMA_BASE_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw protocol.coded("refusing OLLAMA_BASE_URL");
  return url.toString().replace(/\/$/, "");
}

function ollamaModel(env) {
  const model = String((env && env.OLLAMA_MODEL) || protocol.OLLAMA_MODEL).trim();
  if (!model || model.length > 80) throw protocol.coded("refusing OLLAMA_MODEL");
  return model;
}

function cloudHost(base) {
  const host = new URL(base).hostname.toLowerCase();
  return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
}

function mockForced(env) {
  const source = env || {};
  if (source.AETHER_SCRIBE_MOCK === "1") return true;
  if (source.CI || source.GITHUB_ACTIONS) return true;
  return false;
}

async function ollamaChat(opts) {
  const options = opts || {};
  const env = options.env || {};
  const base = ollamaBase(env);
  const model = ollamaModel(env);
  const key = String(env.OLLAMA_API_KEY || "");
  if (cloudHost(base) && !key) throw protocol.coded("OLLAMA_API_KEY is required for Ollama Cloud");
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const fetchFn = options.fetchImpl || globalThis.fetch;
  let response;
  try {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    response = await fetchFn(`${base}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, stream: false }),
    });
  } catch (err) {
    throw protocol.coded(signerPost.redact(err && err.message ? err.message : "ollama request failed", [key]));
  }
  const text = await response.text();
  if (!response.ok) {
    throw protocol.coded(signerPost.redact(`ollama HTTP ${response.status}`, [key]));
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw protocol.coded("ollama reply is not JSON");
  }
  const content = body && body.message && body.message.content;
  if (typeof content !== "string" || !content.trim()) throw protocol.coded("ollama reply was empty");
  return content.trim();
}

module.exports = {
  ollamaBase,
  ollamaModel,
  cloudHost,
  mockForced,
  ollamaChat,
};
