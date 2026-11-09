"use strict";

/**
 * Default-off supervisor. One decision each interval.
 * It does not start unless FOUNDRY_W1_DEX_SUPERVISOR=yes.
 * Tests call tick() and do not enter the interval.
 */

const { decide, readJournal } = require("./director");

const MIN_INTERVAL_MS = 15000;
const DEFAULT_INTERVAL_MS = 60000;

function health(env, journal) {
  const source = env || {};
  const rows = journal ? readJournal(journal) : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    role: "w1-dex-supervisor",
    dormant: source.FOUNDRY_W1_DEX_SUPERVISOR !== "yes",
    spend_enabled: source.FOUNDRY_W1_DEX_LIVE === "yes" && source.FOUNDRY_DEX_KILL !== "yes",
    last_decision: last ? last.decision : null,
    last_traded: last ? last.traded === true : false,
    learning: false,
    live_proof: false,
    decisions: rows.length,
  };
}

async function tick(env, input, clients) {
  return decide(env, input, clients);
}

function main(argv, deps) {
  const args = argv || [];
  const options = deps || {};
  const env = options.env || {};
  if (args.includes("--help")) return Promise.resolve(0);
  const write = options.stdout || (() => {});
  if (env.FOUNDRY_W1_DEX_SUPERVISOR !== "yes") {
    write(`${JSON.stringify(health(env, options.journal))}\n`);
    return Promise.resolve(0);
  }
  const input = options.input || {
    journal: env.FOUNDRY_W1_DEX_JOURNAL,
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
  return run().then(() => new Promise((resolve, reject) => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      run().then(() => {
        running = false;
      }).catch((error) => {
        clearInterval(timer);
        reject(error);
      });
    }, interval);
    if (options.stop) options.stop(() => {
      clearInterval(timer);
      resolve(0);
    });
  }));
}

if (require.main === module) {
  main(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code));
}

module.exports = {
  health,
  tick,
  main,
  MIN_INTERVAL_MS,
};
