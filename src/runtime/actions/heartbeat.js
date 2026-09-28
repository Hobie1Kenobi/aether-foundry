"use strict";

/**
 * W5 heartbeat. Default 1 drop to W3. Memo purpose=aether-heartbeat.
 * At most 4 per 24h and at least 6 hours apart. Dry-run does not read W5_REGULAR_SEED.
 */

const path = require("path");
const anchors = require("../../director/anchors");
const grants = require("../../grants/policy");
const policy = require("../policy");

function historyFile(root) {
  return path.join(root, "lab", "ledger-log.jsonl");
}

function buildUnsigned(opts) {
  const checked = policy.assertHeartbeat(opts);
  const ledger = opts && opts.ledgerIndex;
  const memos = [
    grants.memo("purpose", "aether-heartbeat"),
    grants.memo("experiment", "foundry-runtime"),
  ];
  if (Number.isInteger(ledger) && ledger > 0) memos.push(grants.memo("ledger", String(ledger)));
  return {
    TransactionType: "Payment",
    Account: anchors.WALLETS.W5.address,
    Destination: checked.destination,
    Amount: checked.drops,
    SourceTag: policy.HEARTBEAT_SOURCE_TAG,
    Memos: memos,
  };
}

function plan(opts) {
  const options = opts || {};
  const now = options.now || new Date();
  try {
    if (!options.state || policy.isStale(options.state, now)) {
      throw policy.coded("refusing to sign on stale director state", "STALE");
    }
    if (options.live) {
      policy.assertLiveGate(options.env);
      policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: anchors.XRPL_HTTP });
    }
    const history = options.history || policy.readJsonl(historyFile(options.root), options.io);
    const ledger = options.state.networks && options.state.networks.xrpl_testnet
      ? options.state.networks.xrpl_testnet.validated_ledger_index
      : null;
    const tx = buildUnsigned({
      drops: options.drops == null ? policy.HEARTBEAT_DEFAULT_DROPS : options.drops,
      destination: options.destination || anchors.WALLETS.W3.address,
      history,
      now,
      ledgerIndex: ledger,
    });
    policy.assertSigningTx(tx, options.state);
    return policy.decision("heartbeat", {
      allow: true,
      code: "DUE",
      message: `unsigned heartbeat ${tx.Amount} drops to ${tx.Destination}`,
      tx,
    });
  } catch (error) {
    return policy.fromError("heartbeat", error);
  }
}

async function execute(opts) {
  const options = opts || {};
  policy.assertLiveGate(options.env);
  const draft = plan(options);
  if (!draft.allow || !draft.tx) throw policy.coded(draft.message || "heartbeat refused", draft.code || "REFUSED");
  const regular = policy.regularKey(options.state, "W5");
  const submitted = await options.submit(draft.tx, "W5_REGULAR_SEED", regular);
  if (!submitted || submitted.result !== "tesSUCCESS") {
    throw policy.coded("heartbeat did not succeed", "SUBMIT");
  }
  if (options.archive) {
    options.archive({
      ts: new Date().toISOString(),
      action: "heartbeat",
      event: "heartbeat",
      network: "XRPL Testnet",
      network_id: 1,
      account: anchors.WALLETS.W5.address,
      destination: draft.tx.Destination,
      amount_drops: draft.tx.Amount,
      hash: submitted.hash,
      result: "tesSUCCESS",
      ledger_index: submitted.ledger_index == null ? null : submitted.ledger_index,
      purpose: "aether-heartbeat",
      experiment: "foundry-runtime",
    });
  }
  return {
    hash: submitted.hash,
    result: "tesSUCCESS",
    ledger_index: submitted.ledger_index == null ? null : submitted.ledger_index,
  };
}

module.exports = { buildUnsigned, plan, execute };
