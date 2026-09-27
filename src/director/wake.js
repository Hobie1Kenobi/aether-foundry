#!/usr/bin/env node
"use strict";

/**
 * Director wake. Load lab/director-state.json and print a continuation card.
 * --check exits 0 when quiet and 2 when a routine should alert.
 * Does not sign and does not refresh RPC; run director:snapshot first.
 *
 *   npm run director:wake
 *   npm run director:wake -- --check --quiet --routine morning-health
 */

const fs = require("fs");
const path = require("path");
const anchors = require("./anchors");
const schema = require("./schema");

const ROUTINES = ["morning-health", "weekly-nav", "batch-probe", "walk-in-remint"];

const ROUTINE_READS = {
  "morning-health": [
    "updated_at",
    "probes.desk.http_status",
    "probes.toml.http_status",
    "wallets.W0.spendable_drops",
    "wallets.W0.address",
    "watched.w0_signer_list.quorum",
    "watched.w0_signer_list.matches_h1",
    "watched.w0_signer_list.master_disabled",
    "watched.regular_keys.matches_pack",
    "networks.xrpl_testnet.validated_ledger_index",
  ],
  "weekly-nav": [
    "updated_at",
    "wallets.W0.spendable_drops",
    "wallets.W1.spendable_drops",
    "wallets.W2.spendable_drops",
    "wallets.W3.spendable_drops",
    "wallets.W4.spendable_drops",
    "wallets.W5.spendable_drops",
    "wallets.W6.spendable_drops",
    "watched.testnet_nav_spendable_drops",
    "watched.aeth_outstanding",
    "watched.amm.account",
    "watched.amm.amount_aeth",
    "watched.amm.amount_xrp_drops",
    "networks.xrpl_testnet.validated_ledger_index",
  ],
  "batch-probe": [
    "updated_at",
    "watched.batch.atomic_enabled",
    "watched.batch.amendments",
    "networks.xrpl_testnet.http",
  ],
  "walk-in-remint": [
    "updated_at",
    "watched.walk_in_offer.status",
    "watched.walk_in_offer.offer_id",
    "watched.walk_in_offer.nftoken_id",
    "watched.walk_in_offer.amount_drops",
    "wallets.W2.address",
  ],
};

const HELP = `Usage: node src/director/wake.js [--root DIR] [--state FILE] [--check] [--quiet] [--json] [--routine NAME] [--max-age-hours N]

Routines: ${ROUTINES.join(", ")}
Exit 0 green, exit 2 alert when --check is set, exit 1 when the state file is missing or invalid.
Without --routine, --check unions every routine plus W7 hook drift.`;

function parseArgs(argv) {
  const out = {
    root: anchors.repoRoot(),
    state: null,
    check: false,
    quiet: false,
    json: false,
    routine: null,
    maxAgeHours: anchors.MAX_AGE_HOURS,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--check") out.check = true;
    else if (arg === "--quiet" || arg === "-q") out.quiet = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--root" || arg === "--state" || arg === "--routine" || arg === "--max-age-hours") {
      const value = args[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === "--root") out.root = path.resolve(value);
      else if (arg === "--state") out.state = path.resolve(value);
      else if (arg === "--routine") out.routine = value;
      else out.maxAgeHours = value;
    } else {
      throw new Error(`unknown arg ${arg}`);
    }
  }
  if (out.routine && !ROUTINES.includes(out.routine)) {
    throw new Error(`unknown routine ${out.routine}`);
  }
  const age = Number(out.maxAgeHours);
  if (!Number.isFinite(age) || age <= 0) throw new Error("--max-age-hours must be a positive number");
  out.maxAgeHours = age;
  return out;
}

function loadState(file) {
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error(`director state missing: ${file}. Run npm run director:snapshot`), {
      code: "SCHEMA",
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`director state is not JSON: ${error.message}`), { code: "SCHEMA" });
  }
  return schema.validateState(parsed);
}

function alert(code, message) {
  return { code, message };
}

function freshness(state, now, maxAgeHours) {
  const alerts = [];
  const stamp = Date.parse(state.updated_at);
  const ageMs = now.getTime() - stamp;
  const maxMs = maxAgeHours * 60 * 60 * 1000;
  if (ageMs < -15 * 60 * 1000) {
    alerts.push(alert("future", "updated_at is in the future"));
  } else if (ageMs > maxMs) {
    const hours = Math.floor(ageMs / 3600000);
    alerts.push(alert("stale", `director state is ${hours}h old; run npm run director:snapshot`));
  }
  return alerts;
}

function morningAlerts(state) {
  const alerts = [];
  const desk = state.probes.desk;
  const toml = state.probes.toml;
  if (desk.http_status !== 200) alerts.push(alert("desk", `desk HTTP ${desk.http_status == null ? desk.error : desk.http_status}`));
  if (toml.http_status !== 200) alerts.push(alert("toml", `toml HTTP ${toml.http_status == null ? toml.error : toml.http_status}`));
  const spend = BigInt(state.wallets.W0.spendable_drops);
  if (spend < anchors.STRANDED_SPENDABLE_DROPS) {
    alerts.push(alert("treasury", `W0 spendable ${state.wallets.W0.spendable_drops} drops is under 1 XRP`));
  }
  const signers = state.watched.w0_signer_list;
  if (!signers.matches_h1 || signers.master_disabled) {
    alerts.push(alert("signer_list", `W0 SignerList quorum ${signers.quorum} matches_h1=${signers.matches_h1} master_disabled=${signers.master_disabled}`));
  }
  if (!state.watched.regular_keys.matches_pack) {
    alerts.push(alert("regular_keys", "W1–W6 RegularKey does not match the governance pack"));
  }
  return alerts;
}

function navAlerts(state) {
  const alerts = [];
  for (const id of ["W0", "W1", "W2", "W3", "W4", "W5", "W6"]) {
    if (!/^[0-9]+$/.test(state.wallets[id].spendable_drops)) {
      alerts.push(alert("nav", `${id} spendable_drops missing`));
    }
  }
  if (!state.watched.amm.account || !state.watched.aeth_outstanding) {
    alerts.push(alert("nav", "AMM or AETH outstanding missing"));
  }
  return alerts;
}

function batchAlerts(state) {
  const batch = state.watched.batch;
  if (!batch || !Array.isArray(batch.amendments) || batch.amendments.length === 0) {
    return [alert("batch_unknown", "watched.batch amendments missing")];
  }
  const names = new Set(batch.amendments.map((row) => row.name));
  if (!names.has("BatchV1_1") || !names.has("fixBatchV1_2")) {
    return [alert("batch_unknown", "BatchV1 amendments missing from the snapshot")];
  }
  if (batch.atomic_enabled !== false) {
    return [alert("batch_enabled", "atomic Batch is enabled; stop and do not submit until the founder chooses a heartbeat")];
  }
  return [];
}

function walkInAlerts(state) {
  const offer = state.watched.walk_in_offer;
  if (!offer || offer.status === "sold_out") {
    return [alert("walk_in_sold_out", "Walk-In sell offer is gone; remint only on the Foundry box")];
  }
  if (offer.status !== "open" || !offer.offer_id) {
    return [alert("walk_in_unknown", "Walk-In offer status is not open")];
  }
  return [];
}

function hookAlerts(state) {
  if (!state.watched.w7_hook || state.watched.w7_hook.matches_pack !== true) {
    return [alert("hook", "W7 HookHash does not match the Xahau pack pointer")];
  }
  return [];
}

function evaluate(state, opts = {}) {
  const now = opts.now || new Date();
  const maxAgeHours = opts.maxAgeHours == null ? anchors.MAX_AGE_HOURS : opts.maxAgeHours;
  const routine = opts.routine || null;
  const fresh = freshness(state, now, maxAgeHours);
  let specific = [];
  if (!routine || routine === "morning-health") specific = specific.concat(morningAlerts(state));
  if (!routine || routine === "weekly-nav") specific = specific.concat(navAlerts(state));
  if (!routine || routine === "batch-probe") specific = specific.concat(batchAlerts(state));
  if (!routine || routine === "walk-in-remint") specific = specific.concat(walkInAlerts(state));
  if (!routine) specific = specific.concat(hookAlerts(state));
  const alerts = fresh.concat(specific);
  return {
    ok: alerts.length === 0,
    alerts,
    routine: routine || "director",
  };
}

function shortHash(hash) {
  if (!hash) return "(no trial hash)";
  return `${hash.slice(0, 8)}…`;
}

function continuationCard(state, check) {
  const xrpl = state.networks.xrpl_testnet;
  const xahau = state.networks.xahau_testnet;
  const offer = state.watched.walk_in_offer;
  const amm = state.watched.amm;
  const signers = state.watched.w0_signer_list;
  return {
    title: "CONTINUATION CARD",
    updated_at: state.updated_at,
    timezone: state.timezone,
    last_session_id: state.last_session_id,
    source: state.source,
    networks: {
      xrpl_testnet: {
        label: xrpl.label,
        network_id: xrpl.network_id,
        http: xrpl.http,
        validated_ledger_index: xrpl.validated_ledger_index,
      },
      xahau_testnet: {
        label: xahau.label,
        network_id: xahau.network_id,
        http: xahau.http,
        validated_ledger_index: xahau.validated_ledger_index,
      },
    },
    addresses: anchors.WALLET_IDS.map((id) => ({
      id,
      role: state.wallets[id].role,
      network: state.wallets[id].network,
      address: state.wallets[id].address,
      spendable_drops: state.wallets[id].spendable_drops,
    })),
    open: {
      walk_in_offer: {
        status: offer.status,
        offer_id: offer.offer_id,
        nftoken_id: offer.nftoken_id,
        amount_drops: offer.amount_drops,
      },
      amm: {
        account: amm.account,
        amount_aeth: amm.amount_aeth,
        amount_xrp_drops: amm.amount_xrp_drops,
      },
      w0_signer_list: {
        quorum: signers.quorum,
        signer_count: signers.signer_count,
        matches_h1: signers.matches_h1,
        master_disabled: signers.master_disabled,
      },
      w7_hook: {
        hook_hash: state.watched.w7_hook.hook_hash,
        matches_pack: state.watched.w7_hook.matches_pack,
      },
      batch: {
        atomic_enabled: state.watched.batch.atomic_enabled,
      },
    },
    machines: Object.fromEntries(
      Object.entries(state.machines).map(([slug, row]) => [slug, { status: row.status, last_result_hash: row.last_result_hash }])
    ),
    next_actions: state.next_actions.slice(),
    blockers: state.blockers.slice(),
    check,
  };
}

function renderText(card) {
  const lines = [
    "CONTINUATION CARD",
    `updated_at: ${card.updated_at} (${card.timezone})`,
    `last_session_id: ${card.last_session_id == null ? "(unset)" : card.last_session_id}`,
    `source: ${card.source}`,
    "",
    `${card.networks.xrpl_testnet.label}  network_id ${card.networks.xrpl_testnet.network_id}  ledger ${card.networks.xrpl_testnet.validated_ledger_index}`,
    `  ${card.networks.xrpl_testnet.http}`,
    `${card.networks.xahau_testnet.label}  network_id ${card.networks.xahau_testnet.network_id}  ledger ${card.networks.xahau_testnet.validated_ledger_index}`,
    `  ${card.networks.xahau_testnet.http}`,
    "",
    "Wallets",
  ];
  for (const row of card.addresses) {
    const unit = row.network === "xahau_testnet" ? "XAH" : "XRP";
    lines.push(`  ${row.id} ${row.role} ${row.address}  spendable ${anchors.dropsToDisplay(row.spendable_drops)} ${unit}`);
  }
  const offer = card.open.walk_in_offer;
  const price = offer.amount_drops ? `${anchors.dropsToDisplay(offer.amount_drops)} XRP` : "(no amount)";
  lines.push(
    "",
    "Open / watched",
    `  walk-in ${offer.status} ${offer.offer_id || "(none)"} ${price}`,
    `  AMM ${card.open.amm.account}  ${card.open.amm.amount_aeth} AETH / ${anchors.dropsToDisplay(card.open.amm.amount_xrp_drops)} XRP`,
    `  W0 SignerList quorum ${card.open.w0_signer_list.quorum} matches_h1=${card.open.w0_signer_list.matches_h1}`,
    `  W7 hook ${shortHash(card.open.w7_hook.hook_hash)} matches_pack=${card.open.w7_hook.matches_pack}`,
    `  Batch atomic_enabled=${card.open.batch.atomic_enabled}`,
    "",
    "Machines"
  );
  for (const [slug, row] of Object.entries(card.machines)) {
    lines.push(`  ${slug}  ${row.status}  ${shortHash(row.last_result_hash)}`);
  }
  lines.push("", "Next three actions");
  card.next_actions.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
  lines.push("", "Blockers");
  if (card.blockers.length === 0) lines.push("  (none)");
  else card.blockers.forEach((item) => lines.push(`  - ${item}`));
  lines.push("", card.check.ok ? "Check: green" : `Check: alert (${card.check.alerts.map((item) => item.code).join(", ")})`);
  return lines.join("\n");
}

function run(argv, deps = {}) {
  const args = parseArgs(argv || process.argv);
  if (args.help) {
    if (!deps.silent) console.log(HELP);
    return { code: 0, text: HELP, card: null };
  }
  const file = args.state || path.join(args.root, anchors.STATE_REL);
  const state = loadState(file);
  const check = evaluate(state, {
    now: deps.now || new Date(),
    maxAgeHours: args.maxAgeHours,
    routine: args.routine,
  });
  const card = continuationCard(state, check);
  card.state_file = file;
  const text = renderText(card);
  const code = args.check && !check.ok ? 2 : 0;
  if (!deps.silent) {
    if (args.quiet && args.check) {
      if (!check.ok) {
        for (const item of check.alerts) console.error(`${item.code}: ${item.message}`);
      }
    } else if (args.json) {
      console.log(JSON.stringify(card, null, 2));
    } else {
      console.log(text);
      console.log("--- JSON ---");
      console.log(JSON.stringify(card, null, 2));
    }
  }
  return { code, text, card };
}

if (require.main === module) {
  try {
    const result = run(process.argv);
    process.exit(result.code);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  HELP,
  ROUTINES,
  ROUTINE_READS,
  parseArgs,
  loadState,
  evaluate,
  continuationCard,
  renderText,
  run,
};
