"use strict";

/**
 * Default-off supervisor. One decision each interval.
 * It does not start unless FOUNDRY_W1_DEX_SUPERVISOR=yes.
 * Tests call tick() and do not enter the interval.
 */

const { decide, readJournal, journalDegraded } = require("./director");

const MIN_INTERVAL_MS = 15000;
const DEFAULT_INTERVAL_MS = 60000;
const MAX_BACKOFF_MS = 300000;

function isConnectionFailure(error) {
  if (!error || error.code === "MAINNET" || error.code === "W0" || error.code === "MASTER_KEY" || error.code === "SECRET") return false;
  if (error.name === "NotConnectedError") return true;
  return /connect\(\) timed out|not connected|websocket is not open|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(String(error.message || ""));
}

function nextWait(current, interval, degraded) {
  const base = Math.max(MIN_INTERVAL_MS, Number(interval) || DEFAULT_INTERVAL_MS);
  if (!degraded) return base;
  const previous = Number(current) > 0 ? Number(current) : base;
  return Math.min(previous * 2, MAX_BACKOFF_MS);
}

function roleId(env) {
  const id = env && env.FOUNDRY_DEX_ROLE;
  if (id === "W3" || id === "W4") return id;
  return "W1";
}

function health(env, journal) {
  const source = env || {};
  const role = roleId(source);
  const rows = journal ? readJournal(journal) : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    role: role === "W1" ? "w1-dex-supervisor" : `${role.toLowerCase()}-dex-supervisor`,
    dex_role: role,
    dormant: source[role === "W1" ? "FOUNDRY_W1_DEX_SUPERVISOR" : `FOUNDRY_${role}_DEX_SUPERVISOR`] !== "yes",
    spend_enabled: source[role === "W1" ? "FOUNDRY_W1_DEX_LIVE" : `FOUNDRY_${role}_DEX_LIVE`] === "yes" && source.FOUNDRY_DEX_KILL !== "yes",
    last_decision: last ? last.decision : null,
    last_traded: last ? last.traded === true : false,
    learning: false,
    live_proof: false,
    decisions: rows.length,
  };
}

async function tick(env, input, clients) {
  try {
    return await decide(env, input, clients);
  } catch (error) {
    if (!isConnectionFailure(error)) throw error;
    return journalDegraded(input, error);
  }
}

function main(argv, deps) {
  const args = argv || [];
  const options = deps || {};
  const env = options.env || {};
  const role = roleId(env);
  if (args.includes("--help")) return Promise.resolve(0);
  const write = options.stdout || (() => {});
  const supervisorOn = role === "W1" ? env.FOUNDRY_W1_DEX_SUPERVISOR === "yes" : env[`FOUNDRY_${role}_DEX_SUPERVISOR`] === "yes";
  if (!supervisorOn) {
    write(`${JSON.stringify(health(env, options.journal))}\n`);
    return Promise.resolve(0);
  }
  const input = options.input || {
    journal: role === "W1" ? env.FOUNDRY_W1_DEX_JOURNAL : env[`FOUNDRY_${role}_DEX_JOURNAL`],
    ledger: env.FOUNDRY_MISSION_LEDGER,
  };
  if (!input.journal || !input.ledger) {
    write(`${JSON.stringify(Object.assign(health(env, input.journal), { error_code: "LEDGER" }))}\n`);
    return Promise.resolve(2);
  }
  const once = args.includes("--once") || options.once === true;
  const run = () => tick(env, input, options.clients);
  if (once) return run().then(() => 0);
  const interval = Math.max(MIN_INTERVAL_MS, Number(options.intervalMs || DEFAULT_INTERVAL_MS));
  return run().then((row) => new Promise((resolve, reject) => {
    let timer = null;
    let wait = nextWait(interval, interval, row && row.market === "degraded");
    const schedule = () => {
      timer = setTimeout(() => {
        run().then((next) => {
          wait = nextWait(wait, interval, next && next.market === "degraded");
          schedule();
        }).catch((error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
      }, wait);
    };
    schedule();
    if (options.stop) options.stop(() => {
      if (timer) clearTimeout(timer);
      resolve(0);
    });
  }));
}

if (require.main === module) {
  main(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code)).catch(() => process.exit(1));
}

module.exports = {
  health,
  tick,
  main,
  nextWait,
  isConnectionFailure,
  MIN_INTERVAL_MS,
  MAX_BACKOFF_MS,
};
