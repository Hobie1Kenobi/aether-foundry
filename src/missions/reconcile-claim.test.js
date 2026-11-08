"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("./config");
const { control, view, startMission, act } = require("./engine");
const { beginSubmit, notePresign, stampPrepared } = require("./submit");
const { reconcileClaim, OLD_CLAIM } = require("./reconcile-claim");
const { canonicalReconcileRpc, boundReconcileFetch, LABS, HONEYCLUSTER } = require("./reconcile-endpoint");
const hosts = require("../xrpl-hosts");
const { rangesCover, parseCompleteLedgers } = require("./absence-proof");

const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const AUDIT = "reconcile-audit-token-32chars-min";
const NOW = "2026-11-06T22:00:00.000Z";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-reconcile-"));
}

function response(result) {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

function labs(validated, hashFound, extra) {
  const options = extra || {};
  const funding = "11".repeat(32);
  const creation = options.creation == null ? 22121127 : options.creation;
  const complete = options.complete == null ? `32570-${validated}` : options.complete;
  let seenAccount = null;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const params = (body.params && body.params[0]) || {};
    if (params.account) seenAccount = params.account;
    if (body.method === "server_info") {
      return response({
        info: {
          network_id: 1,
          complete_ledgers: complete,
          validated_ledger: { seq: validated, hash: "aa".repeat(32) },
        },
      });
    }
    if (body.method === "account_info" && params.ledger_index === creation - 1) {
      if (options.priorExists) {
        return response({
          validated: true,
          ledger_index: creation - 1,
          account_data: { Account: seenAccount, Sequence: 1 },
        });
      }
      return response({ error: "actNotFound", validated: true, ledger_index: creation - 1 });
    }
    if (body.method === "account_info") {
      return response({
        validated: true,
        ledger_index: options.accountLedger == null ? validated : options.accountLedger,
        account_data: {
          Account: seenAccount,
          Sequence: options.sequence == null ? creation : options.sequence,
          PreviousTxnID: funding,
          PreviousTxnLgrSeq: creation,
        },
      });
    }
    if (body.method === "tx") {
      if (String(params.transaction || "").toUpperCase() === funding) {
        return response({
          validated: true,
          ledger_index: creation,
          hash: funding,
          meta: {
            TransactionResult: "tesSUCCESS",
            AffectedNodes: [{
              CreatedNode: {
                LedgerEntryType: "AccountRoot",
                NewFields: { Account: seenAccount, Sequence: creation },
              },
            }],
          },
        });
      }
      if (hashFound) {
        return response({ hash: "5E621D59EDBF276A0B31E83E78F114DFB678F4B2E48C51492DF0404EE29013F3", validated: true });
      }
      return response({ error: "txnNotFound" });
    }
    if (body.method === "account_tx") {
      const only = { validated: true, tx: { hash: funding, ledger_index: creation } };
      const transactions = options.extraTx
        ? [only, { validated: true, tx: { hash: "22".repeat(32), ledger_index: creation + 1 } }]
        : [only];
      return response({
        validated: true,
        ledger_index_min: params.ledger_index_min,
        ledger_index_max: params.ledger_index_max,
        marker: options.marker ? { resume: 1 } : undefined,
        transactions,
      });
    }
    if (body.method === "ledger") {
      return response({
        validated: true,
        ledger_index: params.ledger_index,
        ledger: { ledger_index: params.ledger_index, ledger_hash: "bb".repeat(32) },
      });
    }
    return new Response("{}", { status: 500 });
  };
}

function claim(ledger, address, withWindow, key) {
  const opened = startMission(ledger, {
    idempotency_key: key,
    now: NOW,
    observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
    payment_drops: "1753",
    network_fee_drops: "10",
    resource_url: "https://shop.test/new",
  }, { allowlist: { payees: [REVIEWED] } });
  const ready = act(ledger, { mission_id: opened.mission.id, now: NOW }, { wallet: { address } }).mission;
  if (withWindow) {
    stampPrepared(ledger, { mission_id: ready.id, now: NOW, sequence: 22121127, lastLedgerSequence: 22121554 });
  }
  beginSubmit(ledger, { mission_id: ready.id, now: NOW });
  notePresign(ledger, ready.id, "5E621D59EDBF276A0B31E83E78F114DFB678F4B2E48C51492DF0404EE29013F3", {
    tx: withWindow ? { Sequence: 22121127, LastLedgerSequence: 22121554, Account: address, Destination: REVIEWED, Amount: "1753", Fee: "10" } : undefined,
  });
  return ready.id;
}

describe("new claim reconciliation", () => {
  it("reports the window and does not release or retry without the audit phrase", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const address = xrpl.Wallet.generate().address;
    const id = claim(ledger, address, true, "window-claim-1763");
    const open = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121554, false) });
    assert.equal(open.release_allowed, false);
    assert.equal(open.released, false);
    assert.equal(open.reason, "window_open");
    const ready = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, false) });
    assert.equal(ready.release_allowed, true);
    assert.equal(ready.released, false);
    assert.equal(ready.retried, false);
    assert.equal(ready.creation_ledger, 22121127);
    assert.equal(ready.history_covers, true);
    assert.equal(view(ledger, NOW).missions[id].hold, "uncertain");
    assert.equal(view(ledger, NOW).missions[id].earliest_ledger, undefined);
    const present = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, true) });
    assert.equal(present.release_allowed, false);
    assert.equal(present.reason, "hash_present");
    const pruned = await reconcileClaim(ledger, id, {
      now: NOW,
      fetch: labs(22171073, false, { complete: "22169505-22171073" }),
    });
    assert.equal(pruned.release_allowed, false);
    assert.equal(pruned.released, false);
    assert.equal(pruned.reason, "history_incomplete");
    assert.equal(view(ledger, NOW).missions[id].hold, "uncertain");
    const recreated = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, false, { extraTx: true }) });
    assert.equal(recreated.release_allowed, false);
    assert.equal(recreated.reason, "account_recreated");
  });

  it("audits a passed window for the new claim and refuses the old claim and an override", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const address = xrpl.Wallet.generate().address;
    const id = claim(ledger, address, true, "new-claim-1763");
    const old = claim(ledger, xrpl.Wallet.generate().address, false, "old-style-nolls");
    await assert.rejects(
      () => reconcileClaim(ledger, id, { now: NOW, override: true, fetch: labs(22121555, false) }),
      (error) => error.code === "NO_RETRY"
    );
    const denied = await reconcileClaim(ledger, OLD_CLAIM, {
      now: NOW,
      audit: true,
      env: {
        FOUNDRY_MISSION_RECONCILE_PHRASE: "AUDIT-RELEASE-PASSED-WINDOW",
        FOUNDRY_MISSION_RECONCILE_TOKEN: AUDIT,
        FOUNDRY_MISSION_RECONCILE_MISSION: OLD_CLAIM,
      },
      fetch: labs(99999999, false),
    });
    assert.equal(denied.reason, "old_claim");
    assert.equal(denied.released, false);
    const bare = await reconcileClaim(ledger, old, { now: NOW, audit: true, fetch: labs(99999999, false), env: {
      FOUNDRY_MISSION_RECONCILE_PHRASE: "AUDIT-RELEASE-PASSED-WINDOW",
      FOUNDRY_MISSION_RECONCILE_TOKEN: AUDIT,
      FOUNDRY_MISSION_RECONCILE_MISSION: old,
    } });
    assert.equal(bare.release_allowed, false);
    assert.equal(bare.reason, "no_last_ledger_sequence");
    const released = await reconcileClaim(ledger, id, {
      now: NOW,
      audit: true,
      fetch: labs(22121555, false),
      env: {
        FOUNDRY_MISSION_RECONCILE_PHRASE: "AUDIT-RELEASE-PASSED-WINDOW",
        FOUNDRY_MISSION_RECONCILE_TOKEN: AUDIT,
        FOUNDRY_MISSION_RECONCILE_MISSION: id,
      },
    });
    assert.equal(released.released, true);
    assert.equal(released.retried, false);
    const state = view(ledger, NOW);
    assert.equal(state.missions[id].code, "LEDGER_EXPIRED");
    assert.equal(state.missions[id].complete, false);
    assert.equal(state.missions[id].earliest_ledger, undefined);
    assert.equal(state.missions[old].hold, "uncertain");
    assert.equal(state.missions[old].last_ledger_sequence, undefined);
    const text = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(text.includes("fee-retry"), false);
  });

  it("rejects a gap, a prior account, and a moved sequence without writing a lower bound", async () => {
    const ranges = parseCompleteLedgers("32570-22171093");
    assert.equal(rangesCover(ranges, 22121127, 22123277), true);
    assert.equal(rangesCover(parseCompleteLedgers("22169505-22171073"), 22121127, 22123277), false);
    assert.equal(rangesCover(parseCompleteLedgers("32570-22121126,22121128-22123277"), 22121127, 22123277), false);
    assert.equal(parseCompleteLedgers("empty"), null);
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const address = xrpl.Wallet.generate().address;
    const id = claim(ledger, address, true, "edge-claim-1763");
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    const prior = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, false, { priorExists: true }) });
    assert.equal(prior.release_allowed, false);
    assert.equal(prior.reason, "account_recreated");
    const moved = await reconcileClaim(ledger, id, { now: NOW, fetch: labs(22121555, false, { sequence: 22121128 }) });
    assert.equal(moved.release_allowed, false);
    assert.equal(moved.reason, "sequence_moved");
    const after = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(after, before);
    assert.equal(view(ledger, NOW).missions[id].hold, "uncertain");
    assert.equal(view(ledger, NOW).missions[id].earliest_ledger, undefined);
  });
});

describe("reconcile archival endpoint", () => {
  function watch(inner) {
    const urls = [];
    const wrapped = async (url, init) => {
      urls.push(String(url));
      return inner(url, init);
    };
    wrapped.urls = urls;
    return wrapped;
  }

  it("keeps Labs by default and accepts only the documented Honeycluster testnet pair", () => {
    assert.equal(canonicalReconcileRpc(undefined), LABS);
    assert.equal(canonicalReconcileRpc("  https://testnet.honeycluster.io/  "), HONEYCLUSTER);
    assert.equal(canonicalReconcileRpc("wss://testnet.honeycluster.io/"), HONEYCLUSTER);
    for (const raw of [
      "https://honeycluster.io/",
      "wss://honeycluster.io/",
      "https://devnet.honeycluster.io/",
      "http://testnet.honeycluster.io/",
      "https://user:pass@testnet.honeycluster.io/",
      "https://testnet.honeycluster.io/extra",
      "https://evil.example/",
      "wss://s1.ripple.com/",
    ]) {
      assert.throws(() => canonicalReconcileRpc(raw), (error) => error.code === "HOST");
    }
    assert.equal(hosts.isApprovedXrplTestnetHost("testnet.honeycluster.io"), false);
    const signer = fs.readFileSync(path.join(__dirname, "signer.js"), "utf8");
    const worker = fs.readFileSync(path.join(__dirname, "worker.js"), "utf8");
    assert.equal(signer.includes("honeycluster"), false);
    assert.equal(worker.includes("FOUNDRY_MISSION_RECONCILE_RPC"), false);
  });

  it("reports through the selected archive and still refuses pruned history, mainnet, and a claim with no window", async () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const address = xrpl.Wallet.generate().address;
    const id = claim(ledger, address, true, "archive-claim-1763");
    const old = claim(ledger, xrpl.Wallet.generate().address, false, "archive-nolls-01");
    let calls = 0;
    const untouched = async () => {
      calls += 1;
      throw new Error("rpc");
    };
    const noWindow = await reconcileClaim(ledger, old, {
      now: NOW,
      env: { FOUNDRY_MISSION_RECONCILE_RPC: "https://testnet.honeycluster.io" },
      fetch: untouched,
    });
    assert.equal(noWindow.reason, "no_last_ledger_sequence");
    assert.equal(noWindow.released, false);
    assert.equal(calls, 0);
    await assert.rejects(
      () => reconcileClaim(ledger, id, {
        now: NOW,
        env: { FOUNDRY_MISSION_RECONCILE_RPC: "https://honeycluster.io/" },
        fetch: untouched,
      }),
      (error) => error.code === "HOST"
    );
    assert.equal(calls, 0);
    assert.equal(view(ledger, NOW).missions[id].hold, "uncertain");
    const seen = watch(labs(22171073, false, { complete: "22169505-22171073" }));
    const pruned = await reconcileClaim(ledger, id, {
      now: NOW,
      env: { FOUNDRY_MISSION_RECONCILE_RPC: "wss://testnet.honeycluster.io/" },
      fetch: seen,
    });
    assert.equal(pruned.release_allowed, false);
    assert.equal(pruned.released, false);
    assert.equal(pruned.reason, "history_incomplete");
    assert.equal(pruned.rpc_endpoint, HONEYCLUSTER);
    assert.equal(seen.urls.every((url) => url === HONEYCLUSTER), true);
    assert.equal(view(ledger, NOW).missions[id].hold, "uncertain");
    await assert.rejects(
      () => reconcileClaim(ledger, id, {
        now: NOW,
        env: { FOUNDRY_MISSION_RECONCILE_RPC: HONEYCLUSTER },
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.method === "server_info") {
            return new Response(JSON.stringify({ result: { info: { network_id: 0, complete_ledgers: "32570-9", validated_ledger: { seq: 9 } } } }), { status: 200 });
          }
          return new Response("{}", { status: 500 });
        },
      }),
      (error) => error.code === "MAINNET"
    );
    const covered = watch(labs(22121555, false));
    const ready = await reconcileClaim(ledger, id, {
      now: NOW,
      env: { FOUNDRY_MISSION_RECONCILE_RPC: "https://testnet.honeycluster.io/" },
      fetch: covered,
    });
    assert.equal(ready.release_allowed, true);
    assert.equal(ready.released, false);
    assert.equal(ready.rpc_endpoint, HONEYCLUSTER);
    assert.equal(covered.urls[0], HONEYCLUSTER);
    const def = watch(labs(22121555, false));
    const labsReport = await reconcileClaim(ledger, id, { now: NOW, fetch: def });
    assert.equal(labsReport.rpc_endpoint, LABS);
    assert.equal(def.urls[0], LABS);
    const budget = boundReconcileFetch(async () => new Response("{}", { status: 200 }));
    await assert.rejects(
      () => budget(HONEYCLUSTER, { method: "POST", body: JSON.stringify({ method: "submit" }) }),
      (error) => error.code === "HOST"
    );
  });
});
