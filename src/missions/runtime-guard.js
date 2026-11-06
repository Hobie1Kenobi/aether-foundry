"use strict";

const path = require("path");
const { coded } = require("./ledger");

const HOUSE_ENVS = [
  "W0_SEED",
  "W1_SEED",
  "W2_SEED",
  "W3_SEED",
  "W4_SEED",
  "W5_SEED",
  "W6_SEED",
  "W7_SEED",
  "W1_REGULAR_SEED",
  "W2_REGULAR_SEED",
  "W3_REGULAR_SEED",
  "W4_REGULAR_SEED",
  "W5_REGULAR_SEED",
  "W6_REGULAR_SEED",
  "AETHER_SECRETS",
];

const RESERVED_PORTS = new Set([8787, 8792, 8793]);
const MIN_INTERVAL_MS = 15000;
const DEFAULT_INTERVAL_MS = 60000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const CHECKOUT = "/workspace/aether-foundry";

function present(value) {
  return typeof value === "string" && value.length > 0;
}

function assertNoHouseSeeds(env) {
  const source = env || {};
  for (const name of HOUSE_ENVS) {
    if (present(source[name])) throw coded(`refusing house environment ${name}`, "HOUSE_SEED");
  }
}

function assertIsolated(dir) {
  const resolved = path.resolve(String(dir || ""));
  if (resolved === CHECKOUT || resolved.startsWith(`${CHECKOUT}/`)) {
    throw coded("refusing the existing aether-foundry checkout", "ISOLATED");
  }
  return resolved;
}

function assertLoopback(host) {
  const value = String(host == null || host === "" ? "127.0.0.1" : host).trim().toLowerCase();
  if (value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  throw coded("refusing non-loopback bind", "BIND");
}

function assertFreePort(raw, fallback) {
  const port = Number(raw == null || raw === "" ? fallback : raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw coded("refusing port", "BIND");
  if (RESERVED_PORTS.has(port)) throw coded(`refusing port ${port} because an existing service owns it`, "BIND");
  return port;
}

function clampInterval(raw) {
  const parsed = Number(raw == null || raw === "" ? DEFAULT_INTERVAL_MS : raw);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(parsed)));
}

module.exports = {
  HOUSE_ENVS,
  RESERVED_PORTS,
  MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  MAX_INTERVAL_MS,
  CHECKOUT,
  present,
  assertNoHouseSeeds,
  assertIsolated,
  assertLoopback,
  assertFreePort,
  clampInterval,
};
