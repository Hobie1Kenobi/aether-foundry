"use strict";

/**
 * Production entry for the W1 offer role.
 * It stays inactive unless the environment matches the hard-coded role
 * bounds. Even then it refuses a live socket. Tests pass injected clients.
 * This module does not read a seed and does not start the mission runtime.
 */

const { propose } = require("./schedule");
const { verifiedEnv } = require("./dex/bounds");
const { bindProduction } = require("./dex/production");
const { connectLive } = require("./dex/live");
const engine = require("./dex/engine");

async function tick(env, input, clients) {
  const source = env || {};
  const config = verifiedEnv(source);
  const body = input || {};
  if (!config) {
    return {
      activated: false,
      enabled: false,
      signed: false,
      submitted: false,
      written: false,
      live: false,
      execution_ready: false,
      plan: propose(body),
    };
  }
  if (source.FOUNDRY_DEX_KILL === "yes" || body.killed === true) {
    return { activated: true, signed: false, submitted: false, written: false, live: false, code: "killed" };
  }
  if (source.FOUNDRY_W1_DEX_LIVE === "yes") {
    if (!body.ledger) throw Object.assign(new Error("mission ledger is missing"), { code: "LEDGER" });
    const live = await connectLive(source, body.deps);
    try {
      const run = body.action === "cancel"
        ? engine.cancel(body.ledger, body, live.clients)
        : body.action === "reconcile"
          ? engine.reconcile(body.ledger, body, live.clients)
          : body.action === "consume"
            ? engine.consume(body.ledger, body, live.clients)
            : engine.place(body.ledger, body, live.clients);
      const result = await run;
      return Object.assign({ activated: true, enabled: true, dormant: false, written: result.created === true, live_proof: false }, result, {
        live: false,
        execution_ready: false,
      });
    } finally {
      await live.close();
    }
  }
  let runtime = clients;
  if (source.FOUNDRY_DEX_PRODUCTION === "opt-in") {
    try {
      runtime = bindProduction(clients);
    } catch (error) {
      return Promise.reject(error);
    }
  } else if (!clients || clients.mode !== "injected") {
    return { activated: true, signed: false, submitted: false, written: false, live: false, code: "NO_CLIENT" };
  }
  if (!body.ledger) {
    const error = new Error("mission ledger is missing");
    error.code = "LEDGER";
    throw error;
  }
  const run = body.action === "cancel"
    ? engine.cancel(body.ledger, body, runtime)
    : body.action === "reconcile"
      ? engine.reconcile(body.ledger, body, runtime)
      : body.action === "consume"
        ? engine.consume(body.ledger, body, runtime)
        : engine.place(body.ledger, body, runtime);
  return Promise.resolve(run).then((result) => Object.assign({ activated: true, enabled: true, written: result.created === true }, result, {
    live: false,
    execution_ready: false,
  }));
}

module.exports = { tick };
