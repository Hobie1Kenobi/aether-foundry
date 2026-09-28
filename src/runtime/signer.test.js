"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const anchors = require("../director/anchors");
const policy = require("./policy");
const signer = require("./signer");

const ROOT = path.resolve(__dirname, "..", "..");
const TOKEN = "test-signer-token-ok";
const HASH = "A".repeat(64);

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function payment(overrides) {
  return Object.assign({
    TransactionType: "Payment",
    Account: anchors.WALLETS.W5.address,
    Destination: anchors.WALLETS.W3.address,
    Amount: "1",
  }, overrides || {});
}

function ctx(overrides) {
  let loads = 0;
  const base = {
    env: { FOUNDRY_AGENT_SIGN: "yes", FOUNDRY_SIGNER_TOKEN: TOKEN },
    dry: true,
    skipAuth: true,
    skipRpc: true,
    skipMotions: true,
    metrics: false,
    networkId: 1,
    account: signer.richAccount(),
    history: [],
    motions: [],
    state: { watched: { batch: { atomic_enabled: false }, walk_in_offer: { status: "sold_out", offer_count: 0 } } },
    now: new Date("2026-09-28T21:00:00.000Z"),
    loadSeed() {
      loads += 1;
      throw new Error("key loaded");
    },
    autofill: async (tx) => Object.assign({}, tx, { Fee: "12", Sequence: 1 }),
    root: fs.mkdtempSync(path.join(os.tmpdir(), "signer-")),
  };
  const merged = Object.assign(base, overrides || {});
  merged.loads = () => loads;
  return merged;
}

describe("agent allowlist", () => {
  it("is mode agent-sign and keeps the daemon actions", () => {
    const doc = policy.loadAllowlist();
    assert.equal(doc.mode, "agent-sign");
    assert.equal(doc.accounts.W0.sign, false);
    assert.equal(doc.accounts.W1.key_env, "W1_REGULAR_SEED");
    assert.equal(doc.accounts.W7.key_env, "W7_SEED");
    assert.equal(doc.accounts.W7.network, "xahau_testnet");
    assert.equal(doc.caps.per_tx_drops, "10000000");
    assert.equal(doc.caps.motion_drops, "50000000");
    assert.equal(doc.caps.keep_spendable_drops, "10000000");
    assert.equal(doc.caps.max_tx_per_hour, 30);
    assert.equal(doc.caps.max_tx_per_utc_day, 200);
    assert.equal(doc.special.walk_in_price_drops, "10000000");
    assert.equal(doc.tx_types.includes("AccountSet"), true);
    assert.equal(doc.tx_types_refused.includes("Batch"), true);
    assert.equal(doc.tx_types_refused.includes("SetRegularKey"), true);
    assert.equal(doc.actions.walk_in_remint.key_env, "W2_REGULAR_SEED");
    assert.equal(doc.actions.director_snapshot.signs, false);
    assert.deepEqual(doc.refused_network_ids, [0, 21337]);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts.signer, "node src/runtime/signer.js");
    assert.equal(pkg.scripts["signer:dry"], "node src/runtime/signer.js --self-test-dry");
    const workflows = ["director-clock.yml", "walk-in-remint-watch.yml"]
      .map((name) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8"))
      .join("\n");
    assert.equal(workflows.includes("npm run signer"), false);
    assert.equal(workflows.includes("FOUNDRY_AGENT_SIGN"), false);
    assert.equal(workflows.includes("src/runtime/signer.js"), false);
  });
});

describe("signer refusals", () => {
  it("refuses CI and a missing agent-sign gate", async () => {
    await assert.rejects(
      () => signer.evaluate({ wallet: "W5", tx: payment() }, ctx({ env: { CI: "true", FOUNDRY_AGENT_SIGN: "yes" } })),
      (error) => error.code === "CI"
    );
    await assert.rejects(
      () => signer.evaluate({ wallet: "W5", tx: payment() }, ctx({ env: { GITHUB_ACTIONS: "true", FOUNDRY_AGENT_SIGN: "yes" } })),
      (error) => error.code === "CI"
    );
    await assert.rejects(
      () => signer.evaluate({ wallet: "W5", tx: payment() }, ctx({ env: { CI: "1", FOUNDRY_AGENT_SIGN: "yes" } })),
      (error) => error.code === "CI"
    );
    await assert.rejects(
      () => signer.evaluate({ wallet: "W5", tx: payment() }, ctx({ env: { FOUNDRY_AGENT_SIGN: "no" } })),
      (error) => error.code === "AGENT_SIGN"
    );
  });

  it("refuses mainnet network ids and hosts", () => {
    const fields = {
      env: { FOUNDRY_AGENT_SIGN: "yes" },
      wallet: "W5",
      tx: payment(),
      account: signer.richAccount(),
      history: [],
      motions: [],
      state: { watched: { batch: { atomic_enabled: false } } },
    };
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, fields, { networkId: 0 })), "MAINNET");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, fields, { networkId: 21337 })), "MAINNET");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, fields, {
      networkId: 1,
      url: "https://s1.ripple.com",
    })), "MAINNET");
    throwsCode(() => policy.assertAgentRequest(Object.assign({}, fields, {
      wallet: "W7",
      tx: Object.assign(payment(), { Account: anchors.WALLETS.W7.address }),
      networkId: 21337,
      url: "https://xahau.network",
    })), "MAINNET");
    throwsCode(() => signer.assertBind("0.0.0.0"), "BIND");
    assert.equal(signer.assertBind("localhost"), "127.0.0.1");
  });

  it("refuses W0, Batch, and the epoch scar without loading a key", async () => {
    const base = ctx();
    await assert.rejects(
      () => signer.evaluate({ wallet: "W0", tx: payment({ Account: anchors.WALLETS.W0.address }) }, base),
      (error) => error.code === "W0"
    );
    await assert.rejects(
      () => signer.evaluate({
        wallet: "W5",
        tx: { TransactionType: "Batch", Account: anchors.WALLETS.W5.address },
      }, base),
      (error) => error.code === "BATCH"
    );
    await assert.rejects(
      () => signer.evaluate({
        wallet: "W4",
        tx: {
          TransactionType: "EscrowFinish",
          Account: anchors.WALLETS.W4.address,
          Owner: policy.EPOCH_SCAR.owner,
          OfferSequence: policy.EPOCH_SCAR.offerSequence,
        },
      }, ctx()),
      (error) => error.code === "EPOCH_SCAR"
    );
    await assert.rejects(
      () => signer.evaluate({
        wallet: "W4",
        tx: {
          TransactionType: "EscrowCancel",
          Account: anchors.WALLETS.W4.address,
          Owner: policy.EPOCH_SCAR.owner,
          OfferSequence: String(policy.EPOCH_SCAR.offerSequence),
        },
      }, ctx()),
      (error) => error.code === "EPOCH_SCAR"
    );
    await assert.rejects(
      () => signer.evaluate({
        wallet: "W5",
        tx: { TransactionType: "AccountSet", Account: anchors.WALLETS.W5.address, SetFlag: 4 },
      }, ctx()),
      (error) => error.code === "MASTER"
    );
    assert.equal(base.loads(), 0);
  });

  it("refuses a bad bearer and never echoes the token", async () => {
    const base = ctx({ skipAuth: false, authorization: "Bearer nope-not-the-token" });
    await assert.rejects(
      () => signer.evaluate({ wallet: "W5", tx: payment() }, base),
      (error) => error.code === "TOKEN" && !String(error.message).includes(TOKEN)
    );
    await assert.rejects(
      () => signer.evaluate({ wallet: "W5", tx: payment() }, ctx({ skipAuth: false, authorization: "" })),
      (error) => error.code === "TOKEN"
    );
    assert.equal(base.loads(), 0);
    const ok = await signer.evaluate(
      { wallet: "W5", tx: payment() },
      ctx({ skipAuth: false, authorization: `Bearer ${TOKEN}`, dry: true })
    );
    assert.equal(ok.body.key_loaded, false);
    assert.equal(JSON.stringify(ok.body).includes(TOKEN), false);
  });

  it("dry-run autofills and does not load a key", async () => {
    const base = ctx();
    const out = await signer.evaluate({ wallet: "W5", tx: payment(), dry_run: true }, base);
    assert.equal(out.body.dry_run, true);
    assert.equal(out.body.key_loaded, false);
    assert.equal(out.body.signed, false);
    assert.equal(out.body.submitted, false);
    assert.equal(out.body.tx.Fee, "12");
    assert.equal(out.body.tx.Amount, "1");
    assert.equal(base.loads(), 0);
    const self = await signer.selfTestDry();
    assert.equal(self.key_loaded, false);
    assert.equal(self.signed, false);
    assert.equal(JSON.stringify(self).includes("sEd"), false);
  });
});

describe("signer archive", () => {
  it("archives tesSUCCESS without the token or a key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "signer-arch-"));
    fs.mkdirSync(path.join(root, "lab"));
    const activated = anchors.loadActivated(ROOT);
    const regular = activated.regular_keys.find((row) => row.id === "W5");
    let loads = 0;
    const out = await signer.evaluate({
      wallet: "W5",
      intent: "heartbeat",
      tx: payment(),
    }, ctx({
      root,
      dry: false,
      loadSeed() {
        loads += 1;
        return "present-not-a-family-seed";
      },
      openWallet() {
        return {
          classicAddress: regular.regular_key,
          sign() {
            return { tx_blob: "BLOB" };
          },
        };
      },
      submit() {
        return {
          result: {
            hash: HASH,
            ledger_index: 21102567,
            meta: { TransactionResult: "tesSUCCESS" },
          },
        };
      },
    }));
    assert.equal(loads, 1);
    assert.equal(out.body.hash, HASH);
    assert.equal(out.body.ledger_index, 21102567);
    assert.equal(out.body.result, "tesSUCCESS");
    assert.equal(JSON.stringify(out.body).includes(TOKEN), false);
    assert.equal(JSON.stringify(out.body).includes("present-not-a-family-seed"), false);
    const line = fs.readFileSync(path.join(root, "lab", "ledger-log.jsonl"), "utf8");
    assert.match(line, new RegExp(HASH));
    assert.match(line, /agent-signer/);
    assert.match(line, /"action":"heartbeat"/);
    assert.equal(line.includes(TOKEN), false);
    assert.equal(line.includes("present-not-a-family-seed"), false);
  });
});

describe("signer process", () => {
  it("exits CI before listen and the dry script does not print a key", () => {
    const live = spawnSync(process.execPath, ["src/runtime/signer.js"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        CI: "true",
        FOUNDRY_AGENT_SIGN: "yes",
        FOUNDRY_SIGNER_TOKEN: TOKEN,
      },
      encoding: "utf8",
    });
    assert.equal(live.status, 1);
    assert.match(live.stderr, /CI/);
    assert.equal(live.stderr.includes(TOKEN), false);
    const sentinel = "dry-run-key-sentinel";
    const dry = spawnSync(process.execPath, ["src/runtime/signer.js", "--self-test-dry"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        CI: "true",
        GITHUB_ACTIONS: "true",
        FOUNDRY_AGENT_SIGN: "yes",
        FOUNDRY_SIGNER_TOKEN: TOKEN,
        W5_REGULAR_SEED: sentinel,
      },
      encoding: "utf8",
    });
    assert.equal(dry.status, 0);
    const body = JSON.parse(dry.stdout);
    assert.equal(body.key_loaded, false);
    assert.equal(body.signed, false);
    const combined = `${dry.stdout}\n${dry.stderr}`;
    assert.equal(combined.includes(sentinel), false);
    assert.equal(combined.includes(TOKEN), false);
  });
});
