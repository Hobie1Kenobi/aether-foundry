#!/usr/bin/env node
"use strict";

/**
 * Protocol Devnet amendment probe. Read-only XRPL Devnet HTTP.
 * Expected network id is 2. Refuses mainnet id 0, Testnet id 1, Xahau ids, and any other id.
 * Does not sign, load seeds, submit, or invent hashes.
 * On RPC failure the process exits non-zero and does not write lab/frontier/amendments-devnet.json.
 *
 *   npm run frontier:probe-devnet
 *
 * F8, F9, and F10 call this module's HTTP resolver and the same server_info
 * and feature readers before a dry-run or a --live submit. They do not rewrite
 * amendments-devnet.json.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const { rpcCall } = require("../director/snapshot");
const probe = require("./probe-amendments");

const OUT_REL = path.join("lab", "frontier", "amendments-devnet.json");
const XRPL_DEVNET_HTTP = "https://s.devnet.rippletest.net:51234";
const XRPL_DEVNET_NETWORK_ID = 2;
const NETWORK_LABEL = "XRPL Devnet";

const HELP = `Usage: node src/frontier/probe-devnet.js [--root DIR] [--out FILE] [--xrpl-http URL]

Reads server_info and feature from XRPL Devnet HTTP and writes lab/frontier/amendments-devnet.json.
URL order: --xrpl-http, FOUNDRY_XRPL_DEVNET_HTTP, XRPL_DEVNET_HTTP, then ${XRPL_DEVNET_HTTP}.
Does not read FOUNDRY_XRPL_HTTP (that variable is Testnet).
Refuses network id other than ${XRPL_DEVNET_NETWORK_ID}. Refuses mainnet hosts.
Does not sign. Does not invent an amendment hash.
If RPC fails, exits non-zero and leaves any existing amendments-devnet.json untouched.`;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function parseArgs(argv) {
  const out = {
    root: anchors.repoRoot(),
    out: null,
    xrplHttp: null,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--root" || arg === "--out" || arg === "--xrpl-http") {
      const value = args[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === "--root") out.root = path.resolve(value);
      else if (arg === "--out") out.out = path.resolve(value);
      else out.xrplHttp = value;
    } else {
      throw new Error(`unknown arg ${arg}`);
    }
  }
  return out;
}

function firstEnv(env, keys) {
  for (const key of keys) {
    const value = env && env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function resolveHttp(env, override) {
  const raw = override || firstEnv(env, ["FOUNDRY_XRPL_DEVNET_HTTP", "XRPL_DEVNET_HTTP"]) || XRPL_DEVNET_HTTP;
  const trimmed = String(raw || "").trim();
  let hostname;
  try {
    hostname = new URL(trimmed).hostname;
  } catch {
    fail("refusing unparseable XRPL url", "MAINNET");
  }
  if (anchors.isMainnetHost(hostname)) fail("refusing mainnet XRPL url", "MAINNET");
  return probe.publicRpc(trimmed);
}

function assemble(server, amendments, rpc, now) {
  const base = probe.assemble(server, amendments, rpc, now);
  return {
    probed_at: base.probed_at,
    rpc: base.rpc,
    network: NETWORK_LABEL,
    network_id: base.network_id,
    build_version: base.build_version,
    amendments: base.amendments,
  };
}

async function collect(opts) {
  const http = opts.http;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const info = await rpcCall(http, "server_info", {}, fetchImpl);
  const server = probe.readServer(info, XRPL_DEVNET_NETWORK_ID);
  const feature = await rpcCall(http, "feature", {}, fetchImpl);
  const amendments = probe.readAmendments(feature);
  return assemble(server, amendments, http, opts.now);
}

async function run(argv, deps = {}) {
  const args = parseArgs(argv || process.argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const env = deps.env || process.env;
  const http = resolveHttp(env, args.xrplHttp);
  const outPath = args.out || path.join(args.root, OUT_REL);
  const doc = await collect({
    http,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  if (doc.network_id !== XRPL_DEVNET_NETWORK_ID) fail(`refusing network id ${doc.network_id}`, "MAINNET");
  probe.writeAmendments(outPath, doc);
  if (!deps.silent) {
    const disabled = doc.amendments.filter((row) => row.enabled === false).map((row) => row.name);
    console.log(
      `wrote ${outPath} build=${doc.build_version} network_id=${doc.network_id} disabled=${disabled.join(",")}`
    );
  }
  return 0;
}

if (require.main === module) {
  run(process.argv).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  HELP,
  OUT_REL,
  XRPL_DEVNET_HTTP,
  XRPL_DEVNET_NETWORK_ID,
  NETWORK_LABEL,
  parseArgs,
  resolveHttp,
  assemble,
  collect,
  run,
};
