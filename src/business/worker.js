"use strict";

/**
 * Production entry for the W1 offer role.
 * It stays inactive unless the environment matches the hard-coded role
 * bounds. Even then it refuses a live socket. Tests pass injected clients.
 * This module does not read a seed and does not start the mission runtime.
 */

const { propose } = require("./schedule");
const { verifiedEnv } = require("./dex/bounds");
const engine = require("./dex/engine");

function tick(env, input, clients) {
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
  if (!clients || clients.mode !== "injected") {
    return { activated: true, signed: false, submitted: false, written: false, live: false, code: "NO_CLIENT" };
  }
  if (!body.ledger) {
    const error = new Error("mission ledger is missing");
    error.code = "LEDGER";
    throw error;
  }
  const run = body.action === "cancel"
    ? engine.cancel(body.ledger, body, clients)
    : body.action === "reconcile"
      ? engine.reconcile(body.ledger, body, clients)
      : engine.place(body.ledger, body, clients);
  return Promise.resolve(run).then((result) => Object.assign({ activated: true, enabled: true, written: result.created === true }, result, {
    live: false,
    execution_ready: false,
  }));
}

module.exports = { tick };
