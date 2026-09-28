#!/usr/bin/env node
"use strict";

/**
 * stdio MCP server for machines/inbound-mcp/tools.json.
 * Default MCP_SIGN=off. Optional HTTP binds loopback only.
 * Never call from Vercel. The desk facade does not use this process.
 */

const http = require("http");
const tools = require("./tools");
const runtimePolicy = require("../runtime/policy");

const PROTOCOL = "2024-11-05";

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id == null ? null : id, result };
}

function rpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id == null ? null : id,
    error: { code, message: runtimePolicy.redact(message, []) },
  };
}

function toolResult(payload, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: Boolean(isError),
  };
}

function contextFromEnv(env) {
  return {
    env: env || process.env,
    fetch: globalThis.fetch,
  };
}

function assertLoopback(host) {
  const value = String(host || "127.0.0.1").trim().toLowerCase();
  if (value === "localhost") return "127.0.0.1";
  if (value === "127.0.0.1" || value === "::1") return value;
  throw runtimePolicy.coded("refusing non-loopback MCP bind", "BIND");
}

function assertNotVercel(env) {
  if (env && (env.VERCEL || env.VERCEL === "1")) {
    throw runtimePolicy.coded("refusing HTTP MCP on Vercel", "DESK");
  }
}

async function handleRpc(message, ctx) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message && message.id, -32600, "invalid request");
  }
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const notify = id === undefined;
  try {
    if (message.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aether-foundry-inbound", version: "1" },
        instructions:
          "XRPL Testnet only. MCP_SIGN=off. This process does not accept a seed argument and does not sign.",
      });
    }
    if (message.method === "notifications/initialized" || message.method === "initialized") {
      return null;
    }
    if (message.method === "ping") return notify ? null : rpcResult(id, {});
    if (message.method === "tools/list") {
      return rpcResult(id, { tools: tools.listTools(ctx && ctx.catalogFile) });
    }
    if (message.method === "tools/call") {
      const params = message.params || {};
      if (!params.name || typeof params.name !== "string") {
        return rpcError(id, -32602, "missing tool name");
      }
      try {
        const payload = await tools.callTool(params.name, params.arguments || {}, ctx);
        return rpcResult(id, toolResult(payload, false));
      } catch (error) {
        const code = error && error.code ? error.code : "ERROR";
        const text = runtimePolicy.redact(error && error.message ? error.message : "tool failed", []);
        return rpcResult(id, toolResult({ error: text, code }, true));
      }
    }
    if (notify) return null;
    return rpcError(id, -32601, "method not found");
  } catch (error) {
    if (notify) return null;
    return rpcError(id, -32603, error && error.message ? error.message : "internal error");
  }
}

function writeMessage(write, message) {
  if (!message) return;
  write(`${JSON.stringify(message)}\n`);
}

function startStdio(ctx) {
  const context = ctx || contextFromEnv(process.env);
  let buffer = "";
  let chain = Promise.resolve();
  const write = (line) => process.stdout.write(line);

  function enqueue(raw) {
    chain = chain
      .then(async () => {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          writeMessage(write, rpcError(null, -32700, "parse error"));
          return;
        }
        const response = await handleRpc(message, context);
        writeMessage(write, response);
      })
      .catch(() => {
        console.error("mcp dispatch failed");
      });
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      buffer = "";
      writeMessage(write, rpcError(null, -32700, "message too large"));
      return;
    }
    let splitAt = buffer.indexOf("\n");
    while (splitAt >= 0) {
      const line = buffer.slice(0, splitAt).replace(/\r$/, "").trim();
      buffer = buffer.slice(splitAt + 1);
      if (line) enqueue(line);
      splitAt = buffer.indexOf("\n");
    }
  });
}

function startHttp(ctx, options) {
  const context = ctx || contextFromEnv(process.env);
  assertNotVercel(context.env);
  const host = assertLoopback(options && options.host);
  const port = Number((options && options.port) || (context.env && context.env.MCP_HTTP_PORT) || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw runtimePolicy.coded("refusing MCP HTTP port", "BIND");
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      const body = JSON.stringify({
        server: "aether-foundry-inbound",
        transport: "http",
        bind: host,
        signing: "off",
        deskSigns: false,
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length > 65536) {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rpcError(null, -32700, "message too large")));
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
      return;
    }
    const response = await handleRpc(message, context);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(response || rpcResult(message.id, {})));
  });
  server.listen(port, host);
  return server;
}

if (require.main === module) {
  const env = process.env;
  if (process.argv.includes("--http")) {
    try {
      assertNotVercel(env);
      const host = assertLoopback(env.MCP_HTTP_HOST || "127.0.0.1");
      startHttp(contextFromEnv(env), { host, port: env.MCP_HTTP_PORT || 8787 });
      console.error(`mcp http ${host}`);
    } catch (error) {
      console.error(runtimePolicy.redact(error && error.message ? error.message : "mcp http refused", []));
      process.exit(1);
    }
  } else {
    startStdio(contextFromEnv(env));
  }
}

module.exports = {
  PROTOCOL,
  handleRpc,
  startStdio,
  startHttp,
  assertLoopback,
  assertNotVercel,
  contextFromEnv,
  toolResult,
};
