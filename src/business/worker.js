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

function observed(error) {
  if (!error || error.code !== "OBSERVE") return null;
  return {
    decision: "observe",
    code: "OBSERVE",
    activated: true,
    signed: false,
    submitted: false,
    written: false,
    live: false,
    live_proof: false,
    execution_ready: false,
    preexisting_locked_drops: error.preexisting_locked_drops || "0",
    offer_count: error.offer_count || 0,
    cap_blocked: error.cap_blocked === true,
  };
}

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
    const action = body.action || (body.taker_pays == null && body.taker_gets == null ? "hold" : "place");
    if (action === "hold") {
      return {
        decision: "hold",
        activated: true,
        enabled: true,
        dormant: false,
        signed: false,
        submitted: false,
        written: false,
        live: false,
        live_proof: false,
        execution_ready: false,
      };
    }
    if (!body.ledger) throw Object.assign(new Error("mission ledger is missing"), { code: "LEDGER" });
    const live = await connectLive(source, body.deps);
    try {
      if (action === "place") {
        const book = await engine.inspectBook(live.clients.ledger);
        if (book.count > 0) {
          return {
            decision: "observe",
            code: "OBSERVE",
            activated: true,
            signed: false,
            submitted: false,
            written: false,
            live: false,
            live_proof: false,
            execution_ready: false,
            preexisting_locked_drops: book.locked.toString(),
            offer_count: book.count,
            cap_blocked: book.locked > 5000000n,
          };
        }
      }
      await live.openKey();
      const run = action === "cancel"
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
    } catch (error) {
      const quiet = observed(error);
      if (quiet) return quiet;
      throw error;
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
  })).catch((error) => {
    const quiet = observed(error);
    if (quiet) return quiet;
    throw error;
  });
}

module.exports = { tick };
