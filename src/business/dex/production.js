"use strict";

/**
 * Opt-in production wiring. It does not open a socket, read a key, or submit
 * by itself. A test supplies the transport and the signer functions.
 */

const { coded } = require("../../missions/ledger");
const { LABS } = require("../../missions/reconcile-endpoint");
const bounds = require("./bounds");

function bindProduction(options) {
  const source = options || {};
  if (source.seed || source.secret || source.privateKey || source.wallet) {
    throw coded("production wiring refuses key material", "SECRET");
  }
  if (source.socket || source.ws || source.url) throw coded("production wiring refuses a live socket", "LIVE");
  if (source.account != null && source.account !== bounds.ACCOUNT) throw coded("production signer is not the W1 role account", "WALLET");
  if (source.endpoint !== LABS) throw coded("production endpoint is not the sanctioned XRPL Labs HTTPS ledger", "HOST");
  if (typeof source.transport !== "function" || typeof source.sign !== "function" || typeof source.submit !== "function") {
    throw coded("production transport is not configured", "NO_CLIENT");
  }
  return {
    mode: "injected",
    sign: source.sign,
    submit: source.submit,
    ledger: {
      request: (body) => source.transport(LABS, body),
    },
  };
}

module.exports = { bindProduction };
