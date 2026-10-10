#!/usr/bin/env node
"use strict";

/**
 * F4 credential + permissioned domain shop.
 * Dry-run is the default. --live is the Foundry box.
 *
 *   npm run frontier:credential-domain-shop
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:credential-domain-shop -- --live
 *
 * Issuer is W5 via W5_REGULAR_SEED. W0_SEED is never read.
 * Open Walk-In stays a public NFToken sell offer. This script does not mint one.
 */

const fs = require("fs");
const path = require("path");
const hosts = require("../xrpl-hosts");
const anchors = require("../director/anchors");
const probe = require("./probe-amendments");
const shop = require("./credential-domain");
const policy = require("../runtime/policy");
const metrics = require("../runtime/metrics");
const guard = require("../lp-badge-bound-guard");
const { rpcCall } = require("../director/snapshot");

const HELP = `Usage: node src/frontier/credential-domain-shop.js [--dry-run] [--live] [--xrpl-http URL]

--dry-run is the default. It prints unsigned CredentialCreate, CredentialAccept,
PermissionedDomainSet, and domain OfferCreate transactions. It does not read a seed.
--live requires FOUNDRY_DAEMON_LIVE=yes and refuses CI / GITHUB_ACTIONS.
Network id must be 1. If Credentials, PermissionedDomains, or PermissionedDEX is
disabled, the script prints no transaction and does not submit.
domain_id stays null until PermissionedDomainSet metadata returns the domain keylet.
The uncredentialed OfferCreate is expected to fail tecNO_PERMISSION. That hash is
not invented here.`;

const BOOK_REL = path.join("machines", "credential-domain-shop", "addresses.json");
const SEED_ALLOW = ["W5_REGULAR_SEED", "CDS_AGENT_SEED", "CDS_STRANGER_SEED", "CDS_MINT_SEED"];

function parseArgs(argv) {
  const out = { dryRun: true, live: false, help: false, xrplHttp: null };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw shop.coded("pass only one of --dry-run or --live", "ARGS");
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--live") {
      out.live = true;
      out.dryRun = false;
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--xrpl-http") {
      out.xrplHttp = args[i + 1];
      i += 1;
      if (!out.xrplHttp) throw shop.coded("--xrpl-http needs a value", "ARGS");
    } else throw shop.coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function resolveLedger(env, override) {
  try {
    return probe.resolveHttp(env, override);
  } catch (error) {
    if (error && error.code) throw error;
    const message = error && error.message ? error.message : String(error);
    throw shop.coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
}

async function plan(opts) {
  const options = opts || {};
  const http = resolveLedger(options.env || {}, options.xrplHttp || null);
  const accounts = shop.shapeAccounts();
  try {
    const info = await rpcCall(http, "server_info", {}, options.fetchImpl || globalThis.fetch);
    const server = probe.readServer(info);
    const feature = await rpcCall(http, "feature", {}, options.fetchImpl || globalThis.fetch);
    const amendments = shop.assertShopAmendments(feature);
    let predicted = null;
    try {
      const account = await rpcCall(
        http,
        "account_info",
        { account: anchors.WALLETS.W5.address, ledger_index: "validated" },
        options.fetchImpl || globalThis.fetch
      );
      const seq = account && account.account_data ? account.account_data.Sequence : null;
      if (Number.isInteger(seq)) predicted = shop.domainIndex(anchors.WALLETS.W5.address, seq);
    } catch (error) {
      if (error && error.code === "MAINNET") throw error;
      predicted = null;
    }
    const steps = shop.planSteps(accounts, predicted);
    return {
      allow: true,
      code: "DRY_RUN",
      message: "unsigned credential domain shop on W5; domain_id is null until PermissionedDomainSet",
      http,
      network_id: server.network_id,
      build_version: server.build_version,
      amendments,
      accounts,
      domain_id: null,
      predicted_domain_id: predicted,
      steps,
      adversary: shop.adversaryCase(accounts, predicted),
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return {
      allow: false,
      code: (error && error.code) || "REFUSED",
      message: error && error.message ? error.message : String(error),
      http,
      network_id: anchors.XRPL_NETWORK_ID,
      build_version: null,
      amendments: null,
      accounts,
      domain_id: null,
      predicted_domain_id: null,
      steps: null,
      adversary: {
        case: "uncredentialed OfferCreate with DomainID",
        expected_engine: shop.UNCREDENTIALED_ENGINE,
        live_verified: false,
        hash: null,
        domain_id: null,
        tx: null,
        note: "Amendments are not live. The uncredentialed path is not faked with a Payment.",
      },
    };
  }
}

function publicSteps(steps) {
  if (!steps) return null;
  return steps.map((step) => ({
    id: step.id,
    key_env: step.key_env,
    expect: step.expect,
    tx: step.tx,
  }));
}

function publicBody(mode, draft, seedReads) {
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    network_id: draft.network_id,
    action: shop.INTENT,
    intent: shop.INTENT,
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendments: draft.amendments,
    credential_type: shop.CREDENTIAL_TYPE,
    issuer: anchors.WALLETS.W5.address,
    domain_id: null,
    predicted_domain_id: draft.predicted_domain_id,
    walk_in: "public",
    accounts_are_shape: true,
    steps: publicSteps(draft.steps),
    adversary: draft.adversary,
    signer: "box RegularKey W5 plus faucet accounts; not W0; not the agent allowlist",
  };
}

function directorState(root, options) {
  if (options.state) return options.state;
  const daemon = options.daemon || require("../runtime/daemon");
  const loaded = daemon.loadState(root);
  if (!loaded || loaded.missing || !loaded.state) {
    throw shop.coded("refusing --live without director state", "STALE");
  }
  return loaded.state;
}

function bookPath(root) {
  return path.join(root, BOOK_REL);
}

function readBook(root) {
  const file = bookPath(root);
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  guard.assertPublicRecord(doc);
  return doc;
}

function writeBook(root, accounts) {
  const book = {
    network: "XRPL Testnet",
    network_id: 1,
    issuer: accounts.issuer,
    agent: accounts.agent,
    stranger: accounts.stranger,
    mint: accounts.mint,
    note: "Public addresses only. Seeds are not in this file. These accounts are not W0–W6.",
  };
  guard.assertPublicRecord(book);
  const file = bookPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
  return book;
}

function secretsFile(env) {
  return (env && env.AETHER_SECRETS) || guard.SECRETS_PATH;
}

function writeShopSeeds(env, pairs) {
  const file = secretsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const bag = guard.loadEnvText(prior);
  for (const [key, value] of pairs) {
    if (!SEED_ALLOW.includes(key) || key === "W0_SEED") throw shop.coded(`refusing to store ${key}`, "W0");
    bag[key] = value;
  }
  const body = Object.keys(bag)
    .sort()
    .map((key) => `${key}=${bag[key]}`)
    .join("\n");
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* mode already applied */
  }
}

async function faucetAccount(url) {
  guard.assertXrplTestnetUrl(url);
  let last = "faucet failed";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "aether-foundry-credential-domain-shop/1",
        Accept: "application/json",
      },
      body: "{}",
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const parsed = guard.parseFaucetBody(data);
    if (response.ok && parsed) return parsed;
    last = `faucet HTTP ${response.status} attempt ${attempt}`;
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  throw shop.coded(last, "FAUCET");
}

async function ensureAccounts(root, env, loadSeed, options) {
  if (options.accounts) return shop.assertShopAccounts(options.accounts);
  const existing = readBook(root);
  if (existing) {
    return shop.assertShopAccounts({
      issuer: anchors.WALLETS.W5.address,
      agent: existing.agent,
      stranger: existing.stranger,
      mint: existing.mint,
    });
  }
  const funded = {};
  for (const role of ["agent", "stranger", "mint"]) {
    const key = role === "agent" ? "CDS_AGENT_SEED" : role === "stranger" ? "CDS_STRANGER_SEED" : "CDS_MINT_SEED";
    const created = await faucetAccount(guard.FAUCET_URL);
    writeShopSeeds(env, [[key, created.secret]]);
    funded[role] = created.address;
  }
  const accounts = shop.assertShopAccounts({
    issuer: anchors.WALLETS.W5.address,
    agent: funded.agent,
    stranger: funded.stranger,
    mint: funded.mint,
  });
  writeBook(root, accounts);
  return accounts;
}

async function submitStep(step, ctx) {
  policy.assertLiveGate(ctx.env);
  if (step.key_env === "W0_SEED" || step.key_env === "TREASURY_SEED") {
    throw shop.coded("refusing W0 master seed", "W0");
  }
  if (!step.tx || step.tx.Account === anchors.WALLETS.W0.address) {
    throw shop.coded("refusing to sign as W0", "W0");
  }
  policy.assertSigningTx(step.tx);
  shop.assertNotHybrid(step.tx);
  shop.assertNotWalkIn(step.tx);
  const owned = !ctx.client;
  const client = ctx.client || await hosts.openClient(hosts.resolveWs(ctx.env), {
    networkId: anchors.XRPL_NETWORK_ID,
    assertUrl: (url) => policy.assertSigningRpc(url),
  });
  try {
    if (client.networkID != null && Number(client.networkID) !== anchors.XRPL_NETWORK_ID) {
      throw shop.coded(`refusing network id ${client.networkID}`, "MAINNET");
    }
    const seed = ctx.loadSeed(step.key_env);
    if (!seed) throw shop.coded(`${step.key_env} is not loaded. Refusing to sign.`, "NO_SEED");
    const xrpl = require("xrpl");
    let wallet;
    try {
      wallet = xrpl.Wallet.fromSeed(seed);
    } catch {
      throw shop.coded(`${step.key_env} is not a usable seed`, "NO_SEED");
    }
    const signer = wallet.classicAddress || wallet.address;
    if (signer === anchors.WALLETS.W0.address) throw shop.coded("refusing to sign as W0", "W0");
    if (step.key_env === "W5_REGULAR_SEED") {
      if (signer !== ctx.regular) throw shop.coded("W5_REGULAR_SEED address is not the regular key", "SIGNER");
      if (step.tx.Account !== anchors.WALLETS.W5.address) throw shop.coded("W5 transaction Account is not W5", "ACCOUNT");
    } else if (signer !== step.tx.Account) {
      throw shop.coded(`${step.key_env} address is not the transaction Account`, "SIGNER");
    }
    const prepared = await client.autofill(step.tx);
    if (prepared.NetworkID != null && Number(prepared.NetworkID) !== anchors.XRPL_NETWORK_ID) {
      throw shop.coded(`refusing NetworkID ${prepared.NetworkID}`, "MAINNET");
    }
    policy.assertSigningTx(prepared);
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const result = (submitted && submitted.result) || {};
    const meta = result.meta || result.metaData || {};
    const engine = meta.TransactionResult || null;
    if (engine !== step.expect) {
      const code = step.expect === shop.UNCREDENTIALED_ENGINE ? "ADVERSARY" : "SUBMIT";
      throw shop.coded(`${step.id} result ${engine || "missing"} expected ${step.expect}`, code);
    }
    return {
      hash: result.hash ? String(result.hash).toUpperCase() : null,
      result: engine,
      ledger_index: result.ledger_index == null ? null : result.ledger_index,
      sequence: prepared.Sequence,
      meta,
    };
  } finally {
    if (owned) {
      try {
        await client.disconnect();
      } catch {
        /* already closed */
      }
    }
  }
}

function archiveRow(root, row, options) {
  if (options.archive === false) return;
  if (typeof options.archive === "function") {
    options.archive(row);
    return;
  }
  const daemon = options.daemon || require("../runtime/daemon");
  if (row.result === "tesSUCCESS") {
    daemon.archive(root, row);
    return;
  }
  if (row.result !== shop.UNCREDENTIALED_ENGINE) {
    throw shop.coded(`refusing to archive ${row.result}`, "RECORD");
  }
  const hash = String(row.hash || "").toUpperCase();
  if (!anchors.HASH_RE.test(hash)) throw shop.coded("refusing to archive the uncredentialed path without a ledger hash", "RECORD");
  const clean = Object.assign({}, row, { hash, result: shop.UNCREDENTIALED_ENGINE });
  policy.assertNoSeedFields(clean);
  const file = path.join(root, "lab", "ledger-log.jsonl");
  fs.appendFileSync(file, `${JSON.stringify(clean)}\n`);
}

async function executeLive(draft, options, ctx) {
  const accounts = await ensureAccounts(ctx.root, ctx.env, ctx.loadSeed, options);
  let domainId = null;
  const done = [];
  const submit = options.submit || ((step) => submitStep(step, ctx));
  for (const id of shop.STEP_IDS) {
    const tx = shop.buildStep(id, accounts, domainId);
    const step = {
      id,
      tx,
      key_env: shop.keyEnv(id),
      expect: shop.expectEngine(id),
    };
    const submitted = await submit(step);
    if (!submitted || submitted.result !== step.expect) {
      const code = step.expect === shop.UNCREDENTIALED_ENGINE ? "ADVERSARY" : "SUBMIT";
      throw shop.coded(`${id} result ${submitted && submitted.result ? submitted.result : "missing"}`, code);
    }
    if (id === "permissioned_domain_set") {
      const fromMeta = shop.domainIdFromMeta(submitted.meta);
      const fromKey = shop.domainIndex(accounts.issuer, submitted.sequence);
      if (!fromMeta || fromMeta !== fromKey) {
        throw shop.coded("PermissionedDomainSet metadata did not match the domain keylet", "DOMAIN");
      }
      domainId = fromMeta;
    }
    if ((id === "domain_offer" || id === "uncredentialed_offer" || id === "credentialed_take") && tx.DomainID !== domainId) {
      throw shop.coded(`${id} DomainID is not the created domain`, "DOMAIN");
    }
    done.push({
      id,
      hash: submitted.hash ? String(submitted.hash).toUpperCase() : null,
      result: submitted.result,
      ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    });
    if (submitted.hash && anchors.HASH_RE.test(String(submitted.hash).toUpperCase())) {
      archiveRow(ctx.root, {
        ts: ctx.now.toISOString(),
        action: shop.INTENT,
        intent: shop.INTENT,
        step: id,
        network: "XRPL Testnet",
        network_id: 1,
        account: tx.Account,
        hash: String(submitted.hash).toUpperCase(),
        result: submitted.result,
        ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
        domain_id: domainId,
        credential_type: shop.CREDENTIAL_TYPE,
      }, options);
    }
  }
  const refused = done.find((row) => row.id === "uncredentialed_offer");
  const taken = done.find((row) => row.id === "credentialed_take");
  if (!refused || refused.result !== shop.UNCREDENTIALED_ENGINE) {
    throw shop.coded("uncredentialed OfferCreate was not refused", "ADVERSARY");
  }
  if (!taken || taken.result !== "tesSUCCESS") {
    throw shop.coded("credentialed take did not succeed", "SUBMIT");
  }
  if (!domainId) throw shop.coded("domain_id is null after PermissionedDomainSet", "DOMAIN");
  if (options.recordMetrics !== false) {
    metrics.recordDomain(ctx.root, {
      hash: done.find((row) => row.id === "permissioned_domain_set").hash,
      domain_id: domainId,
      ledger_index: done.find((row) => row.id === "permissioned_domain_set").ledger_index,
      ts: ctx.now.toISOString(),
      now: ctx.now,
    }, options.io);
  }
  return { accounts, domainId, done, refused, taken };
}

async function run(argv, deps) {
  const options = deps || {};
  const mode = parseArgs(argv);
  const write = options.stdout || ((text) => console.log(text));
  if (mode.help) {
    write(HELP);
    return 0;
  }
  const env = options.env || process.env;
  const now = options.now || new Date();
  const root = options.root || anchors.repoRoot();
  let seedReads = 0;
  const loadSeed = (name) => {
    if (name === "W0_SEED" || name === "TREASURY_SEED") throw shop.coded("refusing W0 master seed", "W0");
    seedReads += 1;
    if (!mode.live) throw shop.coded("dry-run read a seed", "SEED");
    const reader = options.loadSeed || ((key) => require("../runtime/daemon").readSeed(key, env, options.io, SEED_ALLOW));
    return reader(name);
  };
  if (mode.live) {
    policy.assertLiveGate(env);
    policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: mode.xrplHttp || anchors.XRPL_HTTP });
  }
  const draft = await plan({
    env,
    xrplHttp: mode.xrplHttp,
    fetchImpl: options.fetchImpl,
  });
  if (!mode.live) {
    const body = publicBody(mode, draft, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    return draft.allow ? 0 : 2;
  }
  if (!draft.allow) throw shop.coded(draft.message || "domain shop refused", draft.code || "REFUSED");
  const state = directorState(root, options);
  policy.assertFreshForSign(state, now);
  const regular = policy.regularKey(state, "W5");
  const live = await executeLive(draft, options, { env, loadSeed, regular, root, now, client: options.client });
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    key_env: "W5_REGULAR_SEED",
    network: "xrpl:1",
    network_id: 1,
    action: shop.INTENT,
    intent: shop.INTENT,
    allow: true,
    code: "SUBMITTED",
    credential_type: shop.CREDENTIAL_TYPE,
    issuer: anchors.WALLETS.W5.address,
    domain_id: live.domainId,
    predicted_domain_id: draft.predicted_domain_id,
    walk_in: "public",
    accounts_are_shape: false,
    accounts: live.accounts,
    steps: live.done,
    adversary: {
      case: "uncredentialed OfferCreate with DomainID",
      expected_engine: shop.UNCREDENTIALED_ENGINE,
      live_verified: true,
      hash: live.refused.hash,
      result: live.refused.result,
      domain_id: live.domainId,
    },
    credentialed_take: live.taken.hash,
  };
  policy.assertNoSeedFields(body);
  const text = JSON.stringify(body, null, 2);
  policy.assertPrintSafe(text);
  write(text);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      console.error(`${code}: ${policy.redact(error && error.message)}`);
      process.exit(1);
    });
}

module.exports = {
  HELP,
  BOOK_REL,
  SEED_ALLOW,
  parseArgs,
  plan,
  run,
  submitStep,
};
