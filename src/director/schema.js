"use strict";

/**
 * Director state schema. Refuses seeds and mainnet hosts.
 * Snapshot may refresh ledger fields. It must not clobber the continuation card.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("./anchors");
const hosts = require("../xrpl-hosts");
const walkIn = require("../walk-in-public");

const PRESERVED = ["next_actions", "blockers", "last_session_id"];
const STATUSES = new Set(["trialled", "open", "sold_out", "spec-only", "live"]);
const SOURCES = new Set(["director:snapshot", "fixture"]);

function fail(message) {
  return Object.assign(new Error(message), { code: "SCHEMA" });
}

function assertNoSecrets(value, at) {
  const where = at || "$";
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${where}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (anchors.SECRET_KEY_RE.test(key)) {
        throw fail(`refusing secret field ${where}.${key}`);
      }
      assertNoSecrets(child, `${where}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (anchors.FAMILY_SEED_RE.test(value) || anchors.EMBEDDED_SEED_RE.test(value)) {
      throw fail(`refusing seed-shaped value at ${where}`);
    }
  }
}

function assertDocumentUrl(raw, at) {
  if (typeof raw !== "string" || !/^(https?|wss?):\/\//i.test(raw)) return;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail(`refusing unparseable url at ${at}`);
  }
  const host = url.hostname.toLowerCase();
  if (anchors.isMainnetHost(host)) {
    throw fail(`refusing mainnet host ${host} at ${at}`);
  }
  const allowed = [
    "s.altnet.rippletest.net",
    "testnet.xrpl.org",
    "xahau-test.net",
    "xahau-testnet.xrpl.org",
    "aether-foundry-desk.vercel.app",
    "raw.githubusercontent.com",
    "github.com",
  ];
  const rippletest = host === "rippletest.net" || host.endsWith(".rippletest.net");
  const labsExact = host === hosts.LABS_HOST;
  const named = allowed.some((item) => host === item || host.endsWith(`.${item}`));
  if (!rippletest && !labsExact && !named) {
    throw fail(`refusing host ${host} at ${at}`);
  }
}

function walkUrls(value, at) {
  const where = at || "$";
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkUrls(item, `${where}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if ((key === "network_id" || key === "networkId") && child !== anchors.XRPL_NETWORK_ID && child !== anchors.XAHAU_NETWORK_ID) {
        throw fail(`refusing network id ${child} at ${where}.${key}`);
      }
      walkUrls(child, `${where}.${key}`);
    }
    return;
  }
  if (typeof value === "string") assertDocumentUrl(value, where);
}

function isDrops(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isDecimal(value) {
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value);
}

function isHash(value) {
  return typeof value === "string" && anchors.HASH_RE.test(value);
}

function assertProbe(probe, label) {
  if (!probe || typeof probe !== "object") throw fail(`${label} probe missing`);
  assertDocumentUrl(probe.url, label);
  const status = probe.http_status;
  const hasStatus = Number.isInteger(status) && status >= 100 && status <= 599;
  const hasError = typeof probe.error === "string" && probe.error.length > 0;
  if (!hasStatus && !hasError) throw fail(`${label} probe has no status`);
  if (probe.error != null && probe.error !== null && typeof probe.error !== "string") {
    throw fail(`${label} probe error must be a string or null`);
  }
}

function machineStatusAllowed(slug, status) {
  if (slug === "walk-in-window") return status === "open" || status === "sold_out";
  const row = anchors.MACHINES.find((item) => item.slug === slug);
  return Boolean(row) && status === row.status;
}

function assertMachines(machines, root) {
  if (!machines || typeof machines !== "object" || Array.isArray(machines)) {
    throw fail("machines must be a slug table");
  }
  const slugs = Object.keys(machines);
  const expected = anchors.MACHINES.map((row) => row.slug);
  if (slugs.join("|") !== expected.join("|")) {
    throw fail("machines table does not match the pack catalog");
  }
  for (const row of anchors.MACHINES) {
    const got = machines[row.slug];
    if (!got || typeof got !== "object") throw fail(`machines.${row.slug} missing`);
    if (!STATUSES.has(got.status) || !machineStatusAllowed(row.slug, got.status)) {
      throw fail(`machines.${row.slug} status ${got.status} is not allowed`);
    }
    if (got.results !== row.results) throw fail(`machines.${row.slug} results path drifted`);
    if (row.last_result_hash == null) {
      if (got.last_result_hash !== null) throw fail(`machines.${row.slug} must not invent a trial hash`);
    } else if (got.last_result_hash !== row.last_result_hash) {
      throw fail(`machines.${row.slug} last_result_hash is not the pack pointer`);
    }
    if (row.note && got.note !== row.note) throw fail(`machines.${row.slug} note drifted`);
    if (!row.note && got.note != null) throw fail(`machines.${row.slug} note is unexpected`);
    if (root) {
      const file = path.join(root, got.results);
      if (!fs.existsSync(file)) throw fail(`missing ${got.results}`);
      if (got.last_result_hash) {
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes(got.last_result_hash)) {
          throw fail(`${got.results} does not contain the pack hash`);
        }
      }
    }
  }
}

function assertWallet(id, row, network) {
  const spec = anchors.WALLETS[id];
  if (!row || typeof row !== "object") throw fail(`wallets.${id} missing`);
  if (row.role !== spec.role) throw fail(`wallets.${id} role drifted`);
  if (row.network !== spec.network) throw fail(`wallets.${id} network drifted`);
  if (row.address !== spec.address) throw fail(`wallets.${id} address drifted`);
  if (!anchors.ADDRESS_RE.test(row.address)) throw fail(`wallets.${id} address is not classic`);
  if (!isDrops(row.balance_drops) || !isDrops(row.spendable_drops)) {
    throw fail(`wallets.${id} drops must be digit strings`);
  }
  if (!Number.isInteger(row.owner_count) || row.owner_count < 0) throw fail(`wallets.${id} owner_count`);
  if (!Number.isInteger(row.sequence) || row.sequence < 1) throw fail(`wallets.${id} sequence`);
  if (!(row.regular_key == null || anchors.ADDRESS_RE.test(row.regular_key))) {
    throw fail(`wallets.${id} regular_key`);
  }
  const math = anchors.spendableDrops(
    row.balance_drops,
    row.owner_count,
    network.reserve_base_drops,
    network.reserve_inc_drops
  );
  if (row.spendable_drops !== math.spendable) {
    throw fail(`wallets.${id} spendable_drops does not match reserve math`);
  }
}

function approvedXrplEndpoints(http, ws) {
  if (http === anchors.XRPL_HTTP && ws === anchors.XRPL_WS) return true;
  return http === hosts.LABS_HTTP && ws === hosts.LABS_WS;
}

function assertNetwork(net, id, http, ws) {
  if (!net || typeof net !== "object") throw fail(`${id} network missing`);
  if (net.network_id !== id) throw fail(`${id} network_id`);
  const pairOk = id === anchors.XRPL_NETWORK_ID
    ? approvedXrplEndpoints(net.http, net.ws)
    : net.http === http && net.ws === ws;
  if (!pairOk) throw fail(`${id} endpoint drifted`);
  if (!Number.isInteger(net.validated_ledger_index) || net.validated_ledger_index < 1) {
    throw fail(`${id} validated_ledger_index`);
  }
  if (!isDrops(net.reserve_base_drops) || !isDrops(net.reserve_inc_drops)) {
    throw fail(`${id} reserves`);
  }
  if (typeof net.server_build !== "string" || !net.server_build) throw fail(`${id} server_build`);
  if (typeof net.label !== "string" || !net.label) throw fail(`${id} label`);
  if (typeof net.explorer !== "string") throw fail(`${id} explorer`);
}

function validateState(state, opts = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw fail("state must be an object");
  assertNoSecrets(state);
  walkUrls(state);
  if (state.schema_version !== anchors.SCHEMA_VERSION) throw fail("schema_version");
  if (state.kind !== anchors.KIND) throw fail("kind");
  if (!SOURCES.has(state.source)) throw fail("source");
  if (state.timezone !== anchors.TIMEZONE) throw fail("timezone");
  if (typeof state.updated_at !== "string" || Number.isNaN(Date.parse(state.updated_at))) {
    throw fail("updated_at");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(state.updated_at)) {
    throw fail("updated_at must be ISO-8601 with a numeric offset");
  }
  if (!(state.last_session_id == null || (typeof state.last_session_id === "string" && state.last_session_id))) {
    throw fail("last_session_id");
  }
  if (!Array.isArray(state.next_actions) || state.next_actions.length !== 3) {
    throw fail("next_actions must be length 3");
  }
  if (state.next_actions.some((item) => typeof item !== "string" || !item.trim())) {
    throw fail("next_actions entries must be non-empty strings");
  }
  if (!Array.isArray(state.blockers) || state.blockers.some((item) => typeof item !== "string" || !item.trim())) {
    throw fail("blockers");
  }

  const xrpl = state.networks && state.networks.xrpl_testnet;
  const xahau = state.networks && state.networks.xahau_testnet;
  assertNetwork(xrpl, anchors.XRPL_NETWORK_ID, anchors.XRPL_HTTP, anchors.XRPL_WS);
  assertNetwork(xahau, anchors.XAHAU_NETWORK_ID, anchors.XAHAU_HTTP, anchors.XAHAU_WS);
  if (xrpl.label !== "XRPL Testnet" || xahau.label !== "Xahau Testnet") throw fail("network label");

  if (!state.wallets || Object.keys(state.wallets).join("|") !== anchors.WALLET_IDS.join("|")) {
    throw fail("wallets must be W0–W7");
  }
  for (const id of anchors.WALLET_IDS) {
    const network = anchors.WALLETS[id].network === "xahau_testnet" ? xahau : xrpl;
    assertWallet(id, state.wallets[id], network);
  }
  assertMachines(state.machines, opts.root || null);

  const watched = state.watched;
  if (!watched || typeof watched !== "object") throw fail("watched");
  const offer = watched.walk_in_offer;
  if (!offer || (offer.status !== "open" && offer.status !== "sold_out")) throw fail("walk_in_offer.status");
  if (offer.account !== anchors.WALLETS.W2.address) throw fail("walk_in_offer.account");
  if (offer.pack_offer_id !== walkIn.KNOWN_OFFER_ID) throw fail("walk_in_offer.pack_offer_id");
  if (!Number.isInteger(offer.ledger_index) || offer.ledger_index < 1) throw fail("walk_in_offer.ledger_index");
  if (!Number.isInteger(offer.offer_count) || offer.offer_count < 0) throw fail("walk_in_offer.offer_count");
  if (offer.status === "open") {
    if (!isHash(offer.offer_id) || !isHash(offer.nftoken_id)) throw fail("open walk-in offer needs ids");
    if (offer.offer_count < 1) throw fail("open walk-in offer_count");
    if (!(offer.amount_drops == null || isDrops(offer.amount_drops))) throw fail("walk-in amount");
  } else {
    if (offer.offer_id !== null || offer.nftoken_id !== null || offer.amount_drops !== null) {
      throw fail("sold_out walk-in must not invent ids");
    }
    if (offer.offer_count !== 0) throw fail("sold_out offer_count");
  }

  const amm = watched.amm;
  if (!amm || amm.account !== anchors.AMM) throw fail("amm.account");
  if (!isDecimal(amm.amount_aeth) || !isDrops(amm.amount_xrp_drops)) throw fail("amm amounts");
  if (typeof amm.lp_token_currency !== "string" || !/^[0-9A-F]{40}$/.test(amm.lp_token_currency)) {
    throw fail("amm lp token");
  }
  if (!Number.isInteger(amm.trading_fee) || amm.trading_fee < 0) throw fail("amm trading_fee");
  if (!Number.isInteger(amm.ledger_index) || amm.ledger_index < 1) throw fail("amm ledger");

  const signers = watched.w0_signer_list;
  if (!signers || signers.account !== anchors.WALLETS.W0.address) throw fail("w0_signer_list");
  if (!Number.isInteger(signers.quorum) || signers.quorum < 1) throw fail("signer quorum");
  if (!Array.isArray(signers.entries) || signers.entries.length !== signers.signer_count) {
    throw fail("signer entries");
  }
  for (const entry of signers.entries) {
    if (!anchors.ADDRESS_RE.test(entry.account) || !Number.isInteger(entry.weight) || entry.weight < 1) {
      throw fail("signer entry");
    }
  }
  if (typeof signers.matches_h1 !== "boolean") throw fail("matches_h1");
  if (typeof signers.master_disabled !== "boolean") throw fail("master_disabled");
  if (!(signers.previous_txn_id == null || isHash(signers.previous_txn_id))) throw fail("signer previous_txn_id");
  if (!Number.isInteger(signers.ledger_index)) throw fail("signer ledger");

  const regulars = watched.regular_keys;
  if (!regulars || typeof regulars.matches_pack !== "boolean" || !Array.isArray(regulars.rows)) {
    throw fail("regular_keys");
  }

  const batch = watched.batch;
  if (!batch || typeof batch.atomic_enabled !== "boolean") throw fail("batch.atomic_enabled");
  if (typeof batch.ticket_batch_enabled !== "boolean") throw fail("batch.ticket_batch_enabled");
  if (!Array.isArray(batch.amendments) || batch.amendments.length < 2) throw fail("batch.amendments");
  const names = new Set(batch.amendments.map((row) => row && row.name));
  if (!names.has("BatchV1_1") || !names.has("fixBatchV1_2")) throw fail("batch amendments omitted");
  for (const row of batch.amendments) {
    if (!row || typeof row.name !== "string" || !isHash(row.hash)) throw fail("batch amendment row");
    if (typeof row.enabled !== "boolean" || typeof row.supported !== "boolean") throw fail("batch flags");
  }
  if (batch.atomic_enabled !== batch.amendments.some((row) => /^Batch/i.test(row.name) && row.enabled && !/^TicketBatch$/i.test(row.name))) {
    throw fail("atomic_enabled does not match amendments");
  }

  if (!isDecimal(watched.aeth_outstanding)) throw fail("aeth_outstanding");
  if (!isDrops(watched.testnet_nav_spendable_drops)) throw fail("testnet_nav_spendable_drops");
  const nav = anchors.sumDrops(anchors.WALLET_IDS.filter((id) => id !== "W7").map((id) => state.wallets[id].spendable_drops));
  if (watched.testnet_nav_spendable_drops !== nav) throw fail("testnet NAV does not match W0–W6");

  const hook = watched.w7_hook;
  if (!hook || hook.account !== anchors.WALLETS.W7.address) throw fail("w7_hook");
  if (!isHash(hook.hook_hash) || !isHash(hook.hook_object_id)) throw fail("w7_hook ids");
  if (!(hook.previous_txn_id == null || isHash(hook.previous_txn_id))) throw fail("w7_hook previous_txn_id");
  if (hook.pack_hook_hash !== anchors.PACK_HOOK_HASH) throw fail("w7_hook pack pointer");
  if (typeof hook.matches_pack !== "boolean") throw fail("w7_hook.matches_pack");
  if (hook.matches_pack !== (hook.hook_hash === anchors.PACK_HOOK_HASH)) {
    throw fail("w7_hook.matches_pack disagrees with the hash");
  }
  if (!Number.isInteger(hook.ledger_index)) throw fail("w7_hook ledger");

  if (!state.probes) throw fail("probes");
  assertProbe(state.probes.desk, "desk");
  assertProbe(state.probes.toml, "toml");
  if (state.probes.desk.url !== anchors.DESK_URL) throw fail("desk url");
  if (state.probes.toml.url !== anchors.TOML_URL) throw fail("toml url");
  return state;
}

function mergePreserved(previous, fresh) {
  const next = structuredClone(fresh);
  if (!previous) return next;
  validateState(previous);
  next.next_actions = previous.next_actions.slice();
  next.blockers = previous.blockers.slice();
  next.last_session_id = previous.last_session_id;
  return next;
}

function fixtureState() {
  const root = anchors.repoRoot();
  const board = anchors.loadActivated(root);
  const walk = require("../walk-in-public");
  const base = "1000000";
  const inc = "200000";
  const rows = {
    W0: ["90000000", 2, 12],
    W1: ["80000000", 7, 20],
    W2: ["70000000", 2, 30],
    W3: ["60000000", 0, 40],
    W4: ["50000000", 1, 50],
    W5: ["40000000", 1, 60],
    W6: ["30000000", 0, 70],
    W7: ["1000000000", 1, 8],
  };
  const wallets = {};
  for (const id of anchors.WALLET_IDS) {
    const [balance, owner, sequence] = rows[id];
    const spend = anchors.spendableDrops(balance, owner, base, inc);
    const spec = anchors.WALLETS[id];
    const regular = board.regular_keys.find((row) => row.id === id);
    wallets[id] = {
      role: spec.role,
      network: spec.network,
      address: spec.address,
      balance_drops: balance,
      spendable_drops: spend.spendable,
      owner_count: owner,
      sequence,
      regular_key: regular ? regular.regular_key : null,
    };
  }
  const machines = {};
  for (const row of anchors.MACHINES) {
    const entry = {
      status: row.status,
      results: row.results,
      last_result_hash: row.last_result_hash,
    };
    if (row.note) entry.note = row.note;
    machines[row.slug] = entry;
  }
  const nav = anchors.sumDrops(["W0", "W1", "W2", "W3", "W4", "W5", "W6"].map((id) => wallets[id].spendable_drops));
  return {
    schema_version: anchors.SCHEMA_VERSION,
    kind: anchors.KIND,
    source: "fixture",
    timezone: anchors.TIMEZONE,
    updated_at: "2026-09-27T16:40:00-05:00",
    last_session_id: null,
    networks: {
      xrpl_testnet: {
        label: "XRPL Testnet",
        network_id: anchors.XRPL_NETWORK_ID,
        http: anchors.XRPL_HTTP,
        ws: anchors.XRPL_WS,
        explorer: "https://testnet.xrpl.org",
        validated_ledger_index: 21101245,
        reserve_base_drops: base,
        reserve_inc_drops: inc,
        server_build: "3.4.1",
      },
      xahau_testnet: {
        label: "Xahau Testnet",
        network_id: anchors.XAHAU_NETWORK_ID,
        http: anchors.XAHAU_HTTP,
        ws: anchors.XAHAU_WS,
        explorer: "https://xahau-testnet.xrpl.org",
        validated_ledger_index: 12693992,
        reserve_base_drops: base,
        reserve_inc_drops: inc,
        server_build: "2026.6.21-release+3350",
      },
    },
    wallets,
    machines,
    watched: {
      walk_in_offer: {
        account: anchors.WALLETS.W2.address,
        status: "open",
        offer_id: walk.KNOWN_OFFER_ID,
        nftoken_id: walk.KNOWN_NFTOKEN_ID,
        amount_drops: walk.AMOUNT_DROPS,
        offer_count: 1,
        pack_offer_id: walk.KNOWN_OFFER_ID,
        ledger_index: 21101245,
      },
      amm: {
        account: anchors.AMM,
        amount_aeth: "4923.542951524584",
        amount_xrp_drops: "50783389",
        lp_token_currency: "0330E60FAE706EAD2C7D511D790B07A6F3B89931",
        trading_fee: 500,
        ledger_index: 21101245,
      },
      w0_signer_list: {
        account: anchors.WALLETS.W0.address,
        quorum: board.quorum,
        signer_count: board.signers.length,
        entries: board.signers.map((row) => ({ account: row.address, weight: row.weight })),
        matches_h1: true,
        master_disabled: false,
        previous_txn_id: "EDD27C458D314602E6059D8351D2DDA322A5E4BD1FD55602B3D2E667EA970299",
        ledger_index: 21101245,
      },
      regular_keys: {
        matches_pack: true,
        rows: board.regular_keys.map((row) => ({
          id: row.id,
          account: row.account,
          regular_key: row.regular_key,
          expected: row.regular_key,
        })),
      },
      batch: {
        atomic_enabled: false,
        ticket_batch_enabled: true,
        amendments: [
          {
            name: "BatchV1_1",
            hash: "9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377",
            enabled: false,
            supported: true,
          },
          {
            name: "TicketBatch",
            hash: "955DF3FA5891195A9DAEFA1DDC6BB244B545DDE1BAA84CBB25D5F12A8DA68A0C",
            enabled: true,
            supported: true,
          },
          {
            name: "fixBatchV1_2",
            hash: "14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944",
            enabled: false,
            supported: true,
          },
        ],
      },
      aeth_outstanding: "10100",
      testnet_nav_spendable_drops: nav,
      w7_hook: {
        account: anchors.WALLETS.W7.address,
        hook_hash: anchors.PACK_HOOK_HASH,
        hook_object_id: "C3ABA1460EF3339BFBC4CE25E963ABCF016DD16F71153263FB7989105666B629",
        previous_txn_id: "7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447",
        pack_hook_hash: anchors.PACK_HOOK_HASH,
        matches_pack: true,
        ledger_index: 12693992,
      },
    },
    probes: {
      desk: { url: anchors.DESK_URL, http_status: 200, error: null },
      toml: { url: anchors.TOML_URL, http_status: 200, error: null },
    },
    next_actions: anchors.DEFAULT_NEXT_ACTIONS.slice(),
    blockers: [],
  };
}

module.exports = {
  PRESERVED,
  assertNoSecrets,
  validateState,
  mergePreserved,
  fixtureState,
};
