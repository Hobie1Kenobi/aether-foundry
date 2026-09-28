#!/usr/bin/env node
"use strict";

/**
 * Scheduled Director clock. Names the wake routine and the snapshot commit.
 * Does not sign, does not load a seed, and does not import xrpl.
 *
 *   node src/director/clock.js --print-routines
 *   node src/director/clock.js --assert-workflow
 *   node src/director/clock.js --commit-message
 *   node src/director/clock.js --merge-exit 0 2
 *   node src/director/clock.js --require-wake-code 2
 */

const fs = require("fs");
const path = require("path");
const anchors = require("./anchors");

const WORKFLOW_REL = path.join(".github", "workflows", "director-clock.yml");

const SCHEDULES = [
  { cron: "30 * * * *", name: "freshness", routine: null },
  { cron: "56 13 * * 1-5", name: "morning-health", routine: "morning-health" },
  { cron: "56 17 * * 1,3,5", name: "batch-probe", routine: "batch-probe" },
  { cron: "56 13 * * 1", name: "weekly-nav", routine: "weekly-nav" },
];

const DISPATCH_NAMES = SCHEDULES.map((row) => row.name);
const MONDAY_MORNING = new Set(["56 13 * * 1-5", "56 13 * * 1"]);

const HELP = `Usage: node src/director/clock.js [--print-routines] [--assert-workflow] [--commit-message] [--merge-exit A B] [--require-wake-code N]

Names a read-only wake routine from the GitHub schedule. freshness omits --routine.
Does not sign, remint, or read a seed.`;

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function fieldMatches(field, value) {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((item) => Number(item));
      if (Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end) return true;
    } else if (Number(part) === value) {
      return true;
    }
  }
  return false;
}

function cronMatches(cron, date) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  const minuteOk = fieldMatches(minute, date.getUTCMinutes());
  const hourOk = fieldMatches(hour, date.getUTCHours());
  const monthOk = fieldMatches(month, date.getUTCMonth() + 1);
  const domOk = fieldMatches(dom, date.getUTCDate());
  const dowOk = fieldMatches(dow, date.getUTCDay());
  const dayOk = dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
  return minuteOk && hourOk && monthOk && dayOk;
}

function byName(name) {
  const row = SCHEDULES.find((item) => item.name === name);
  if (!row) throw coded(`unknown routine ${name}`, "ROUTINE");
  return row;
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
}

function expandSchedule(cron, now) {
  const primary = SCHEDULES.find((row) => row.cron === cron);
  if (!primary) throw coded(`unknown schedule ${cron}`, "ROUTINE");
  const rows = [primary];
  if (MONDAY_MORNING.has(cron) && (cron === "56 13 * * 1" || now.getUTCDay() === 1)) {
    for (const row of SCHEDULES) {
      if (MONDAY_MORNING.has(row.cron)) rows.push(row);
    }
  }
  return dedupe(rows);
}

function routinesFromClock(now) {
  return SCHEDULES.filter((row) => cronMatches(row.cron, now));
}

function resolveRoutines(opts) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const eventName = opts.eventName || "";
  const routineInput = opts.routineInput || "";
  const schedule = opts.schedule || "";
  if (eventName === "workflow_dispatch" || (routineInput && !schedule)) {
    return [byName(routineInput || "freshness")];
  }
  if (schedule) return expandSchedule(schedule, now);
  const matched = routinesFromClock(now);
  if (matched.length === 0) throw coded("no director routine matches this minute", "ROUTINE");
  return matched;
}

function wakeArgv(row) {
  const args = ["--check", "--quiet"];
  if (row.routine) args.push("--routine", row.routine);
  return args;
}

function mergeExit(current, next) {
  const left = Number(current);
  const right = Number(next);
  if (!Number.isInteger(left) || !Number.isInteger(right)) {
    throw coded("wake exit must be an integer", "ROUTINE");
  }
  if (left === 1 || right === 1) return 1;
  if (left === 2 || right === 2) return 2;
  if (right !== 0 || left !== 0) return 1;
  return 0;
}

function requireWakeCode(code) {
  if (typeof code !== "string" && typeof code !== "number") {
    throw coded("wake exit missing", "ROUTINE");
  }
  if (typeof code === "string" && !/^-?[0-9]+$/.test(code.trim())) {
    throw coded("wake exit missing", "ROUTINE");
  }
  const value = Number(code);
  if (!Number.isInteger(value)) throw coded("wake exit missing", "ROUTINE");
  if (value === 0) return 0;
  if (value === 2) {
    throw coded("wake alert (exit 2); refusing to sign or remint", "ALERT");
  }
  throw coded(`wake fatal (exit ${value})`, "ROUTINE");
}

function commitMessage(state) {
  const ledger = state && state.networks && state.networks.xrpl_testnet
    ? state.networks.xrpl_testnet.validated_ledger_index
    : undefined;
  if (!Number.isInteger(ledger) || ledger < 1) {
    throw coded("refusing snapshot commit without validated_ledger_index", "RPC");
  }
  return `chore(director): snapshot ${ledger}`;
}

function assertActionsEnv(env) {
  const hits = Object.keys(env || {}).filter((key) => {
    return /SEED/i.test(key) || /PRIVATE_KEY/i.test(key) || key === "AETHER_SECRETS";
  });
  if (hits.length) throw coded(`refusing seed env in Actions: ${hits.join(", ")}`, "SEED");
  if (env && (env.FOUNDRY_DAEMON_LIVE === "yes" || env.FOUNDRY_DAEMON_LIVE === "1")) {
    throw coded("refusing FOUNDRY_DAEMON_LIVE on the director clock", "CI");
  }
  if (env && (env.FOUNDRY_AGENT_SIGN === "yes" || env.FOUNDRY_AGENT_SIGN === "1")) {
    throw coded("refusing FOUNDRY_AGENT_SIGN on the director clock", "CI");
  }
}

function assertWorkflow(text) {
  const banned = [
    [/runtime:live/, "runtime:live"],
    [/runtime:watch/, "runtime:watch"],
    [/npm run signer/, "signer"],
    [/src\/runtime\/signer\.js/, "signer"],
    [/FOUNDRY_AGENT_SIGN/, "FOUNDRY_AGENT_SIGN"],
    [/FOUNDRY_SIGNER_TOKEN/, "FOUNDRY_SIGNER_TOKEN"],
    [/remint:walk-in/, "remint:walk-in"],
    [new RegExp("Wal" + "let"), "signer"],
    [new RegExp("from" + "Seed"), "signer-import"],
    [/FOUNDRY_DAEMON_LIVE/, "FOUNDRY_DAEMON_LIVE"],
    [/_SEED/, "*_SEED"],
    [/AETHER_SECRETS/, "AETHER_SECRETS"],
    [/secrets\./, "secrets"],
    [/ripple\.com/, "ripple.com"],
    [/xrplcluster\.com/, "xrplcluster.com"],
    [/xrpl\.ws/, "xrpl.ws"],
    [/xrpl\.link/, "xrpl.link"],
    [/xahau\.network/, "xahau.network"],
  ];
  for (const [pattern, label] of banned) {
    if (pattern.test(text)) throw coded(`director clock workflow refused ${label}`, "SEED");
  }
  for (const row of SCHEDULES) {
    if (!text.includes(row.cron)) throw coded(`director clock workflow missing ${row.cron}`, "ROUTINE");
  }
  const required = [
    "workflow_dispatch",
    "contents: write",
    "npm ci",
    "npm test",
    "director:snapshot",
    "director:wake",
    "--check",
    "--quiet",
    "github-actions[bot]",
    "41898282+github-actions[bot]@users.noreply.github.com",
    "--commit-message",
    "--require-wake-code",
  ];
  for (const token of required) {
    if (!text.includes(token)) throw coded(`director clock workflow missing ${token}`, "ROUTINE");
  }
}

function readCommitMessage(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return commitMessage(parsed);
}

function parseArgs(argv) {
  const out = {
    help: false,
    printRoutines: false,
    assertWorkflow: false,
    commitMessage: false,
    mergeExit: null,
    requireWakeCode: null,
    state: null,
    root: anchors.repoRoot(),
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--print-routines") out.printRoutines = true;
    else if (arg === "--assert-workflow") out.assertWorkflow = true;
    else if (arg === "--commit-message") out.commitMessage = true;
    else if (arg === "--merge-exit") {
      const left = args[i + 1];
      const right = args[i + 2];
      if (left == null || right == null) throw coded("--merge-exit requires two codes", "ROUTINE");
      i += 2;
      out.mergeExit = [left, right];
    } else if (arg === "--require-wake-code") {
      const value = args[i + 1];
      if (value == null) throw coded("--require-wake-code requires a value", "ROUTINE");
      i += 1;
      out.requireWakeCode = value;
    } else if (arg === "--state" || arg === "--root") {
      const value = args[i + 1];
      if (!value) throw coded(`${arg} requires a value`, "ROUTINE");
      i += 1;
      if (arg === "--state") out.state = path.resolve(value);
      else out.root = path.resolve(value);
    } else {
      throw coded(`unknown arg ${arg}`, "ROUTINE");
    }
  }
  return out;
}

function eventFromEnv(env) {
  return {
    eventName: env.DIRECTOR_EVENT_NAME || "",
    schedule: env.DIRECTOR_EVENT_SCHEDULE || "",
    routineInput: env.DIRECTOR_ROUTINE || "",
    now: env.DIRECTOR_NOW ? new Date(env.DIRECTOR_NOW) : new Date(),
  };
}

function run(argv, env) {
  const source = env || process.env;
  const args = parseArgs(argv || process.argv);
  if (args.help) return { code: 0, text: HELP };
  if (args.assertWorkflow) {
    if (source.GITHUB_ACTIONS === "true") assertActionsEnv(source);
    const file = path.join(args.root, WORKFLOW_REL);
    assertWorkflow(fs.readFileSync(file, "utf8"));
    return { code: 0, text: "director clock workflow is read-only" };
  }
  if (args.commitMessage) {
    const file = args.state || path.join(args.root, anchors.STATE_REL);
    const text = readCommitMessage(file);
    return { code: 0, text };
  }
  if (args.mergeExit) {
    const merged = mergeExit(args.mergeExit[0], args.mergeExit[1]);
    return { code: 0, text: String(merged) };
  }
  if (args.requireWakeCode != null) {
    requireWakeCode(args.requireWakeCode);
    return { code: 0, text: "wake quiet" };
  }
  if (args.printRoutines) {
    const rows = resolveRoutines(eventFromEnv(source));
    return { code: 0, text: rows.map((row) => row.name).join("\n") };
  }
  throw coded("director clock needs a command", "ROUTINE");
}

if (require.main === module) {
  try {
    const result = run(process.argv, process.env);
    if (result.text) console.log(result.text);
    process.exit(result.code);
  } catch (error) {
    console.error(error.message || String(error));
    const code = error && error.code === "ALERT" ? 2 : 1;
    process.exit(code);
  }
}

module.exports = {
  HELP,
  SCHEDULES,
  DISPATCH_NAMES,
  WORKFLOW_REL,
  cronMatches,
  resolveRoutines,
  wakeArgv,
  mergeExit,
  requireWakeCode,
  commitMessage,
  assertActionsEnv,
  assertWorkflow,
  run,
};
