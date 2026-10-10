#!/usr/bin/env node
"use strict";

/**
 * Read-only Director snapshot. Public XRPL Testnet and Xahau Testnet RPC.
 * Refuses mainnet hosts. Does not load seeds and does not sign.
 *
 *   npm run director:snapshot
 */

const fs = require("fs");
const path = require("path");
const anchors = require("./anchors");
const hosts = require("../xrpl-hosts");
const schema = require("./schema");
const walkIn = require("../walk-in-public");

const HELP = `Usage: node src/director/snapshot.js [--root DIR] [--state FILE] [--xrpl-http URL] [--xahau-http URL]

Reads balances and watched ledger objects into lab/director-state.json.
Preserves next_actions, blockers, and last_session_id when the current file is valid.
Does not sign, read seeds, or invent a ledger index when RPC fails.
Primary HTTP is https://testnet.xrpl-labs.com. FOUNDRY_XRPL_HTTP, XRPL_HTTP, or
XRPL_RPC_URL may select that host or https://s.altnet.rippletest.net:51234.
If the labs host times out, the XRPL reads retry altnet once. The card still
records network id 1 and the host that answered.`;

function parseArgs(argv) {
  const out = {
    root: anchors.repoRoot(),
    state: null,
    xrplHttp: null,
    xrplHttpSet: false,
    xahauHttp: anchors.XAHAU_HTTP,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--root" || arg === "--state" || arg === "--xrpl-http" || arg === "--xahau-http") {
      const value = args[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === "--root") out.root = path.resolve(value);
      else if (arg === "--state") out.state = path.resolve(value);
      else if (arg === "--xrpl-http") {
        out.xrplHttp = value;
        out.xrplHttpSet = true;
      }
      else out.xahauHttp = value;
    } else {
      throw new Error(`unknown arg ${arg}`);
    }
  }
  return out;
}

function resolveSnapshotHttp(raw) {
  const checked = anchors.assertXrplTestnetUrl(raw || anchors.XRPL_HTTP);
  const host = new URL(checked).hostname.toLowerCase();
  if (hosts.isLabsTestnetHost(host)) return canonicalRpc(checked, hosts.LABS_HTTP, "XRPL Labs Testnet");
  if (hosts.isAltnetHost(host)) return canonicalRpc(checked, hosts.ALTNET_HTTP, "XRPL Testnet");
  throw Object.assign(new Error("refusing non-canonical XRPL Testnet url"), { code: "MAINNET" });
}

function canonicalRpc(actual, expected, label) {
  const got = new URL(actual);
  const want = new URL(expected);
  if (got.protocol !== want.protocol || got.host !== want.host || got.pathname.replace(/\/$/, "") !== want.pathname.replace(/\/$/, "")) {
    throw Object.assign(new Error(`refusing non-canonical ${label} url`), { code: "MAINNET" });
  }
  return expected;
}

async function rpcCall(url, method, params, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw Object.assign(new Error(`${method} failed: ${error.message || error}`), { code: "RPC" });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw Object.assign(new Error(`${method} returned non-JSON HTTP ${response.status}`), { code: "RPC" });
  }
  const result = body && body.result;
  if (!response.ok || !result || result.status === "error" || result.error) {
    const detail = (result && (result.error_message || result.error)) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`${method} failed: ${detail}`), { code: "RPC" });
  }
  return result;
}

function requireValidated(result, label) {
  if (!result || result.validated !== true) {
    throw Object.assign(new Error(`${label} was not a validated ledger`), { code: "RPC" });
  }
}

function ledgerSeq(result, label) {
  requireValidated(result, label);
  const seq = result.ledger_index;
  if (!Number.isInteger(seq) || seq < 1) {
    throw Object.assign(new Error(`${label} omitted validated ledger_index`), { code: "RPC" });
  }
  return seq;
}

function readValidatedLedger(serverState) {
  const ledger = serverState && serverState.state && serverState.state.validated_ledger;
  if (!ledger || !Number.isInteger(ledger.seq) || ledger.seq < 1) {
    throw Object.assign(new Error("server_state omitted validated_ledger.seq"), { code: "RPC" });
  }
  if (ledger.reserve_base == null || ledger.reserve_inc == null) {
    throw Object.assign(new Error("server_state omitted reserves"), { code: "RPC" });
  }
  return {
    validated_ledger_index: ledger.seq,
    reserve_base_drops: String(ledger.reserve_base),
    reserve_inc_drops: String(ledger.reserve_inc),
  };
}

function masterDisabled(info) {
  const flags = Number((info.account_data && info.account_data.Flags) || 0);
  const fromFlags = (flags & anchors.LSF_DISABLE_MASTER) !== 0;
  const named = info.account_flags && info.account_flags.disableMasterKey;
  if (typeof named === "boolean" && named !== fromFlags) {
    throw Object.assign(new Error("disableMasterKey disagrees with Flags"), { code: "RPC" });
  }
  return fromFlags;
}

function readAccount(info) {
  requireValidated(info, "account_info");
  const data = info.account_data || {};
  for (const [key, value] of Object.entries(data)) {
    if (anchors.SECRET_KEY_RE.test(key)) {
      throw Object.assign(new Error(`refusing secret field from account_info: ${key}`), { code: "SCHEMA" });
    }
    if (typeof value === "string" && (anchors.FAMILY_SEED_RE.test(value) || anchors.EMBEDDED_SEED_RE.test(value))) {
      throw Object.assign(new Error("refusing seed-shaped account_info value"), { code: "SCHEMA" });
    }
  }
  if (!anchors.ADDRESS_RE.test(data.Account || "")) {
    throw Object.assign(new Error("account_info omitted Account"), { code: "RPC" });
  }
  if (!/^[0-9]+$/.test(String(data.Balance || ""))) {
    throw Object.assign(new Error("account_info omitted Balance"), { code: "RPC" });
  }
  if (!Number.isInteger(data.Sequence) || data.Sequence < 1) {
    throw Object.assign(new Error("account_info omitted Sequence"), { code: "RPC" });
  }
  return {
    address: data.Account,
    balance_drops: String(data.Balance),
    owner_count: Number(data.OwnerCount || 0),
    sequence: data.Sequence,
    regular_key: data.RegularKey || null,
    master_disabled: masterDisabled(info),
    ledger_index: ledgerSeq(info, "account_info"),
  };
}

async function accountObjects(url, params, fetchImpl) {
  const objects = [];
  let marker;
  let ledgerIndex = null;
  for (let page = 0; page < 4; page += 1) {
    const request = Object.assign({}, params);
    if (marker !== undefined) request.marker = marker;
    const result = await rpcCall(url, "account_objects", request, fetchImpl);
    ledgerIndex = ledgerSeq(result, "account_objects");
    objects.push(...(result.account_objects || []));
    if (result.marker == null) return { objects, ledger_index: ledgerIndex };
    marker = result.marker;
  }
  throw Object.assign(new Error("account_objects pagination exceeded 4 pages"), { code: "RPC" });
}

function readSignerList(objects) {
  const lists = objects.filter((row) => row.LedgerEntryType === "SignerList");
  if (lists.length !== 1) {
    throw Object.assign(new Error(`expected one SignerList, found ${lists.length}`), { code: "RPC" });
  }
  const list = lists[0];
  const entries = (list.SignerEntries || []).map((item) => {
    const entry = item.SignerEntry || item;
    return {
      account: entry.Account,
      weight: Number(entry.SignerWeight),
    };
  });
  if (!Number.isInteger(list.SignerQuorum)) {
    throw Object.assign(new Error("SignerList omitted SignerQuorum"), { code: "RPC" });
  }
  return {
    quorum: list.SignerQuorum,
    entries,
    previous_txn_id: list.PreviousTxnID ? String(list.PreviousTxnID).toUpperCase() : null,
  };
}

function signersMatch(entries, expected) {
  const live = entries.map((row) => `${row.account}:${row.weight}`).sort();
  const pack = expected.map((row) => `${row.address}:${row.weight}`).sort();
  return live.length === pack.length && live.every((value, index) => value === pack[index]);
}

function readHook(objects) {
  const hooks = objects.filter((row) => row.LedgerEntryType === "Hook");
  if (hooks.length !== 1) {
    throw Object.assign(new Error(`expected one Hook, found ${hooks.length}`), { code: "RPC" });
  }
  const row = hooks[0];
  const hashes = [];
  for (const item of row.Hooks || []) {
    const hook = item.Hook || item;
    if (hook && hook.HookHash) hashes.push(String(hook.HookHash).toUpperCase());
  }
  if (hashes.length !== 1) {
    throw Object.assign(new Error(`expected one HookHash, found ${hashes.length}`), { code: "RPC" });
  }
  if (!row.index) throw Object.assign(new Error("Hook object omitted index"), { code: "RPC" });
  return {
    hook_hash: hashes[0],
    hook_object_id: String(row.index).toUpperCase(),
    previous_txn_id: row.PreviousTxnID ? String(row.PreviousTxnID).toUpperCase() : null,
  };
}

function readAmm(result) {
  requireValidated(result, "amm_info");
  const amm = result.amm;
  if (!amm || !amm.account) throw Object.assign(new Error("amm_info omitted account"), { code: "RPC" });
  const parts = [amm.amount, amm.amount2];
  let amountAeth = null;
  let amountXrp = null;
  for (const part of parts) {
    if (typeof part === "string") amountXrp = part;
    else if (part && part.currency && part.currency !== "XRP") amountAeth = part.value;
  }
  if (!amountAeth || !/^[0-9]+$/.test(String(amountXrp || ""))) {
    throw Object.assign(new Error("amm_info omitted AETH/XRP amounts"), { code: "RPC" });
  }
  const lp = amm.lp_token && amm.lp_token.currency;
  if (!lp) throw Object.assign(new Error("amm_info omitted lp_token"), { code: "RPC" });
  return {
    account: amm.account,
    amount_aeth: String(amountAeth),
    amount_xrp_drops: String(amountXrp),
    lp_token_currency: String(lp).toUpperCase(),
    trading_fee: Number(amm.trading_fee),
    ledger_index: ledgerSeq(result, "amm_info"),
  };
}

function readBatch(feature) {
  const raw = (feature && feature.features) || null;
  if (!raw || typeof raw !== "object") {
    throw Object.assign(new Error("feature response omitted features"), { code: "RPC" });
  }
  const rows = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([hash, row]) => Object.assign({ hash }, row));
  const amendments = rows
    .filter((row) => row && /batch/i.test(row.name || ""))
    .map((row) => ({
      name: row.name,
      hash: String(row.hash || "").toUpperCase(),
      enabled: Boolean(row.enabled),
      supported: Boolean(row.supported),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(amendments.map((row) => row.name));
  if (!names.has("BatchV1_1") || !names.has("fixBatchV1_2")) {
    throw Object.assign(new Error("feature response omitted BatchV1 amendments"), { code: "RPC" });
  }
  const atomic = amendments.some(
    (row) => /^Batch/i.test(row.name) && row.enabled && !/^TicketBatch$/i.test(row.name)
  );
  return {
    atomic_enabled: atomic,
    ticket_batch_enabled: amendments.some((row) => row.name === "TicketBatch" && row.enabled),
    amendments,
  };
}

function readOutstanding(result) {
  requireValidated(result, "gateway_balances");
  const obligations = result.obligations || {};
  const value = obligations[anchors.AETH_HEX];
  if (value == null) {
    throw Object.assign(new Error("gateway_balances omitted AETH obligation"), { code: "RPC" });
  }
  return String(value);
}

function machineTable(walkInStatus) {
  const machines = {};
  for (const row of anchors.MACHINES) {
    const entry = {
      status: row.slug === "walk-in-window" ? walkInStatus : row.status,
      results: row.results,
      last_result_hash: row.last_result_hash,
    };
    if (row.note) entry.note = row.note;
    machines[row.slug] = entry;
  }
  return machines;
}

function readOffers(objects) {
  const offers = walkIn.sellOffersFromObjects(objects).map((row) => ({
    offerId: String(row.offerId).toUpperCase(),
    nftokenId: String(row.nftokenId).toUpperCase(),
    amount: typeof row.amount === "string" ? row.amount : null,
  }));
  offers.sort((a, b) => a.offerId.localeCompare(b.offerId));
  return offers;
}

async function probeGet(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (response.url && anchors.isMainnetHost(new URL(response.url).hostname)) {
      return { url, http_status: null, error: "refusing mainnet redirect" };
    }
    return { url, http_status: response.status, error: null };
  } catch (error) {
    return { url, http_status: null, error: error.message || String(error) };
  }
}

async function collectAt(xrplHttp, opts, fetchImpl) {
  const xahauHttp = canonicalRpc(anchors.assertXahauTestnetUrl(opts.xahauHttp || anchors.XAHAU_HTTP), anchors.XAHAU_HTTP, "Xahau Testnet");
  const xrplInfo = await rpcCall(xrplHttp, "server_info", {}, fetchImpl);
  anchors.assertNetworkId(xrplInfo.info && xrplInfo.info.network_id, anchors.XRPL_NETWORK_ID);
  const xrplState = await rpcCall(xrplHttp, "server_state", {}, fetchImpl);
  const feature = await rpcCall(xrplHttp, "feature", {}, fetchImpl);
  const accounts = {};
  for (const id of anchors.WALLET_IDS) {
    if (id === "W7") continue;
    const info = await rpcCall(
      xrplHttp,
      "account_info",
      { account: anchors.WALLETS[id].address, ledger_index: "validated" },
      fetchImpl
    );
    const row = readAccount(info);
    if (row.address !== anchors.WALLETS[id].address) {
      throw Object.assign(new Error(`${id} account_info returned a different address`), { code: "RPC" });
    }
    accounts[id] = row;
  }
  const signerObjects = await accountObjects(
    xrplHttp,
    { account: anchors.WALLETS.W0.address, ledger_index: "validated", type: "signer_list", limit: 200 },
    fetchImpl
  );
  const offerObjects = await accountObjects(
    xrplHttp,
    { account: anchors.WALLETS.W2.address, ledger_index: "validated", type: "nft_offer", limit: 200 },
    fetchImpl
  );
  const amm = await rpcCall(
    xrplHttp,
    "amm_info",
    {
      asset: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address },
      asset2: { currency: "XRP" },
      ledger_index: "validated",
    },
    fetchImpl
  );
  const gateway = await rpcCall(
    xrplHttp,
    "gateway_balances",
    { account: anchors.WALLETS.W0.address, ledger_index: "validated" },
    fetchImpl
  );
  const xahauInfo = await rpcCall(xahauHttp, "server_info", {}, fetchImpl);
  anchors.assertNetworkId(xahauInfo.info && xahauInfo.info.network_id, anchors.XAHAU_NETWORK_ID);
  const xahauState = await rpcCall(xahauHttp, "server_state", {}, fetchImpl);
  const w7Info = await rpcCall(
    xahauHttp,
    "account_info",
    { account: anchors.WALLETS.W7.address, ledger_index: "validated" },
    fetchImpl
  );
  const w7 = readAccount(w7Info);
  if (w7.address !== anchors.WALLETS.W7.address) {
    throw Object.assign(new Error("W7 account_info returned a different address"), { code: "RPC" });
  }
  const hookObjects = await accountObjects(
    xahauHttp,
    { account: anchors.WALLETS.W7.address, ledger_index: "validated", type: "hook", limit: 200 },
    fetchImpl
  );
  const desk = await probeGet(anchors.DESK_URL, fetchImpl);
  const toml = await probeGet(anchors.TOML_URL, fetchImpl);
  return {
    xrplInfo,
    xrplState,
    feature,
    accounts,
    signerObjects,
    offerObjects,
    amm,
    gateway,
    xahauInfo,
    xahauState,
    w7,
    hookObjects,
    desk,
    toml,
    xrplEndpoints: hosts.endpointPair(xrplHttp),
  };
}

async function collect(opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const requested = resolveSnapshotHttp(opts.xrplHttp || anchors.XRPL_HTTP);
  try {
    return await collectAt(requested, opts, fetchImpl);
  } catch (error) {
    const next = hosts.fallbackUrl(requested);
    if (!next || !hosts.isTransportFailure(error)) throw error;
    return collectAt(next, opts, fetchImpl);
  }
}

function assemble(bundle, opts) {
  const root = opts.root || anchors.repoRoot();
  const board = anchors.loadActivated(root);
  const xrplLedger = readValidatedLedger(bundle.xrplState);
  const xahauLedger = readValidatedLedger(bundle.xahauState);
  const build = (info) => {
    const version = info && info.info && info.info.build_version;
    if (!version) throw Object.assign(new Error("server_info omitted build_version"), { code: "RPC" });
    return String(version);
  };
  const wallets = {};
  for (const id of anchors.WALLET_IDS) {
    const live = id === "W7" ? bundle.w7 : bundle.accounts[id];
    const network = id === "W7" ? xahauLedger : xrplLedger;
    const spend = anchors.spendableDrops(
      live.balance_drops,
      live.owner_count,
      network.reserve_base_drops,
      network.reserve_inc_drops
    );
    const spec = anchors.WALLETS[id];
    wallets[id] = {
      role: spec.role,
      network: spec.network,
      address: spec.address,
      balance_drops: live.balance_drops,
      spendable_drops: spend.spendable,
      owner_count: live.owner_count,
      sequence: live.sequence,
      regular_key: live.regular_key,
    };
  }
  const offers = readOffers(bundle.offerObjects.objects);
  const known = offers.find((row) => row.offerId === walkIn.KNOWN_OFFER_ID);
  const chosen = known || offers[0] || null;
  const walkStatus = offers.length ? "open" : "sold_out";
  const signer = readSignerList(bundle.signerObjects.objects);
  const w0 = bundle.accounts.W0;
  const matchesH1 =
    signer.quorum === board.quorum &&
    signersMatch(signer.entries, board.signers) &&
    w0.master_disabled === false;
  const regularRows = board.regular_keys.map((row) => {
    const live = wallets[row.id] ? wallets[row.id].regular_key : null;
    return {
      id: row.id,
      account: row.account,
      regular_key: live,
      expected: row.regular_key,
    };
  });
  const hook = readHook(bundle.hookObjects.objects);
  const amm = readAmm(bundle.amm);
  if (amm.account !== anchors.AMM) {
    throw Object.assign(new Error(`amm_info account ${amm.account} is not the Foundry pool`), { code: "RPC" });
  }
  const batch = readBatch(bundle.feature);
  const nav = anchors.sumDrops(["W0", "W1", "W2", "W3", "W4", "W5", "W6"].map((id) => wallets[id].spendable_drops));
  return {
    schema_version: anchors.SCHEMA_VERSION,
    kind: anchors.KIND,
    source: "director:snapshot",
    timezone: anchors.TIMEZONE,
    updated_at: anchors.formatChicago(opts.now || new Date()),
    last_session_id: null,
    networks: {
      xrpl_testnet: {
        label: "XRPL Testnet",
        network_id: anchors.XRPL_NETWORK_ID,
        http: bundle.xrplEndpoints ? bundle.xrplEndpoints.http : anchors.XRPL_HTTP,
        ws: bundle.xrplEndpoints ? bundle.xrplEndpoints.ws : anchors.XRPL_WS,
        explorer: "https://testnet.xrpl.org",
        validated_ledger_index: xrplLedger.validated_ledger_index,
        reserve_base_drops: xrplLedger.reserve_base_drops,
        reserve_inc_drops: xrplLedger.reserve_inc_drops,
        server_build: build(bundle.xrplInfo),
      },
      xahau_testnet: {
        label: "Xahau Testnet",
        network_id: anchors.XAHAU_NETWORK_ID,
        http: anchors.XAHAU_HTTP,
        ws: anchors.XAHAU_WS,
        explorer: "https://xahau-testnet.xrpl.org",
        validated_ledger_index: xahauLedger.validated_ledger_index,
        reserve_base_drops: xahauLedger.reserve_base_drops,
        reserve_inc_drops: xahauLedger.reserve_inc_drops,
        server_build: build(bundle.xahauInfo),
      },
    },
    wallets,
    machines: machineTable(walkStatus),
    watched: {
      walk_in_offer: {
        account: anchors.WALLETS.W2.address,
        status: walkStatus,
        offer_id: chosen ? chosen.offerId : null,
        nftoken_id: chosen ? chosen.nftokenId : null,
        amount_drops: chosen ? chosen.amount : null,
        offer_count: offers.length,
        pack_offer_id: walkIn.KNOWN_OFFER_ID,
        ledger_index: bundle.offerObjects.ledger_index,
      },
      amm,
      w0_signer_list: {
        account: anchors.WALLETS.W0.address,
        quorum: signer.quorum,
        signer_count: signer.entries.length,
        entries: signer.entries,
        matches_h1: matchesH1,
        master_disabled: w0.master_disabled,
        previous_txn_id: signer.previous_txn_id,
        ledger_index: bundle.signerObjects.ledger_index,
      },
      regular_keys: {
        matches_pack: regularRows.every(
          (row) => row.regular_key === row.expected && row.account === anchors.WALLETS[row.id].address
        ),
        rows: regularRows,
      },
      batch,
      aeth_outstanding: readOutstanding(bundle.gateway),
      testnet_nav_spendable_drops: nav,
      w7_hook: {
        account: anchors.WALLETS.W7.address,
        hook_hash: hook.hook_hash,
        hook_object_id: hook.hook_object_id,
        previous_txn_id: hook.previous_txn_id,
        pack_hook_hash: anchors.PACK_HOOK_HASH,
        matches_pack: hook.hook_hash === anchors.PACK_HOOK_HASH,
        ledger_index: bundle.hookObjects.ledger_index,
      },
    },
    probes: {
      desk: bundle.desk,
      toml: bundle.toml,
    },
    next_actions: anchors.DEFAULT_NEXT_ACTIONS.slice(),
    blockers: [],
  };
}

function readPrevious(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`existing director state is not JSON: ${error.message}`), { code: "SCHEMA" });
  }
  try {
    schema.validateState(parsed);
  } catch (error) {
    throw Object.assign(
      new Error(`existing director state failed validation; refusing to clobber: ${error.message}`),
      { code: "SCHEMA" }
    );
  }
  return parsed;
}

function writeState(file, state, root) {
  schema.validateState(state, { root });
  const text = `${JSON.stringify(state, null, 2)}\n`;
  schema.assertNoSecrets(JSON.parse(text));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw error;
  }
}

async function run(argv, deps = {}) {
  const args = parseArgs(argv || process.argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const statePath = args.state || path.join(args.root, anchors.STATE_REL);
  const previous = readPrevious(statePath);
  const env = deps && Object.prototype.hasOwnProperty.call(deps, "env") ? (deps.env || {}) : process.env;
  const xrplHttp = args.xrplHttpSet ? args.xrplHttp : hosts.resolveHttp(env);
  const bundle = await collect({
    xrplHttp,
    xahauHttp: args.xahauHttp,
    fetchImpl: deps.fetchImpl,
  });
  const fresh = assemble(bundle, { root: args.root, now: deps.now });
  const merged = schema.mergePreserved(previous, fresh);
  writeState(statePath, merged, args.root);
  if (!deps.silent) {
    console.log(
      `wrote ${statePath} xrpl_ledger=${merged.networks.xrpl_testnet.validated_ledger_index} xahau_ledger=${merged.networks.xahau_testnet.validated_ledger_index}`
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
  parseArgs,
  rpcCall,
  collect,
  assemble,
  readPrevious,
  writeState,
  run,
  readBatch,
  signersMatch,
};
