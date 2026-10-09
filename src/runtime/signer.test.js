"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const anchors = require("../director/anchors");
const hosts = require("../xrpl-hosts");
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

  it("heartbeat archive keeps frontier ids already in metrics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "signer-frontier-"));
    fs.mkdirSync(path.join(root, "lab"), { recursive: true });
    const oracleId = "7CD1AB908C3A8D2E3C426E0D3083F4DD9A8A3A753AA60EB73682AA11A06DFA4E";
    const mptId = "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED";
    const domainId = "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4";
    fs.writeFileSync(path.join(root, "lab", "metrics.json"), `${JSON.stringify({
      updated_at: "2026-09-29T09:34:05-05:00",
      x402_hits: 0,
      x402_outbound_hits: 1,
      grants_paid: 2,
      inbound_counterparties: 2,
      last_grant_hash: null,
      last_outbound_hash: null,
      last_heartbeat_hash: "D2E1DDC059FF4A6DE70EB4520D18C6A534E3825E98B1879A496476AF94AC85AD",
      last_heartbeat: {
        hash: "D2E1DDC059FF4A6DE70EB4520D18C6A534E3825E98B1879A496476AF94AC85AD",
        ledger_index: 21145575,
        ts: "2026-09-29T14:34:05.297Z",
      },
      oracle_id: oracleId,
      last_oracle: {
        hash: "B11B0B87A7C40AFA98540D2F40FF234384466729F90E259E60162714DC4DDE85",
        oracle_id: oracleId,
        ledger_index: 21129718,
        last_update_time: 1790639158,
        quote_xrp_per_aeth: "0.01022008",
        ts: "2026-09-28T23:45:58.839Z",
      },
      mpt_issuance_id: mptId,
      domain_id: domainId,
    }, null, 2)}\n`);
    const activated = anchors.loadActivated(ROOT);
    const regular = activated.regular_keys.find((row) => row.id === "W5");
    const out = await signer.evaluate({
      wallet: "W5",
      intent: "heartbeat",
      tx: payment(),
    }, ctx({
      root,
      dry: false,
      metrics: true,
      loadSeed() {
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
            ledger_index: 21152365,
            meta: { TransactionResult: "tesSUCCESS" },
          },
        };
      },
    }));
    assert.equal(out.body.hash, HASH);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "lab", "metrics.json"), "utf8"));
    assert.equal(saved.last_heartbeat.hash, HASH);
    assert.equal(saved.oracle_id, oracleId);
    assert.equal(saved.last_oracle.oracle_id, oracleId);
    assert.equal(saved.last_oracle.hash, "B11B0B87A7C40AFA98540D2F40FF234384466729F90E259E60162714DC4DDE85");
    assert.equal(saved.mpt_issuance_id, mptId);
    assert.equal(saved.domain_id, domainId);
  });
});

function rpcResult(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { result };
    },
  };
}

describe("signer RPC fallback", () => {
  it("proves network id 1 on the labs host when rippletest times out", async () => {
    const seen = [];
    const out = await signer.health({
      env: { FOUNDRY_AGENT_SIGN: "yes" },
      fetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).includes("rippletest.net")) throw new Error("fetch failed");
        return rpcResult({ status: "success", info: { network_id: 1 } });
      },
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.network_id, 1);
    assert.deepEqual(seen, [hosts.PRIMARY_HTTP, hosts.LABS_HTTP]);
  });

  it("uses XRPL_HTTP and XRPL_WS_URL when they name the labs host", async () => {
    const seen = [];
    const out = await signer.health({
      env: {
        FOUNDRY_AGENT_SIGN: "yes",
        XRPL_HTTP: hosts.LABS_HTTP,
        XRPL_WS_URL: hosts.LABS_WS,
      },
      fetchImpl: async (url) => {
        seen.push(String(url));
        return rpcResult({ status: "success", info: { network_id: 1 } });
      },
    });
    assert.equal(out.body.network_id, 1);
    assert.deepEqual(seen, [hosts.LABS_HTTP]);
  });

  it("refuses a mainnet override without calling it, and refuses a fallback that is not network id 1", async () => {
    let called = 0;
    await assert.rejects(
      () => signer.health({
        env: { XRPL_HTTP: "https://s1.ripple.com:51234" },
        fetchImpl: async () => {
          called += 1;
          return rpcResult({ status: "success", info: { network_id: 0 } });
        },
      }),
      (error) => error.code === "MAINNET"
    );
    await assert.rejects(
      () => signer.health({
        env: { XRPL_HTTP: "https://s2.ripple.com" },
        fetchImpl: async () => {
          called += 1;
          return rpcResult({});
        },
      }),
      (error) => error.code === "MAINNET"
    );
    await assert.rejects(
      () => signer.health({
        env: { XRPL_HTTP: "https://xrplcluster.com" },
        fetchImpl: async () => {
          called += 1;
          return rpcResult({});
        },
      }),
      (error) => error.code === "MAINNET"
    );
    await assert.rejects(
      () => signer.health({
        env: {},
        fetchImpl: async (url) => {
          called += 1;
          if (String(url).includes("rippletest.net")) throw new Error("fetch failed");
          return rpcResult({ status: "success", info: { network_id: 0 } });
        },
      }),
      (error) => error.code === "MAINNET"
    );
    assert.equal(called, 2);
  });

  it("does not sign through a fallback socket until it reports network id 1", async () => {
    const wallet = policy.agentWallet("W5");
    let signed = 0;
    await assert.rejects(
      () => signer.connectForSign(hosts.PRIMARY_WS, wallet, (url) => ({
        async connect() {
          if (String(url).includes("rippletest.net")) throw new Error("fetch failed");
        },
        async request() {
          return { result: { info: { network_id: 0 } } };
        },
        async disconnect() {},
        sign() {
          signed += 1;
        },
      })),
      (error) => error.code === "MAINNET"
    );
    assert.equal(signed, 0);

    const opened = await signer.connectForSign(hosts.PRIMARY_WS, wallet, (url) => ({
      async connect() {
        if (String(url).includes("rippletest.net")) throw new Error("timed out");
      },
      async request() {
        return { result: { info: { network_id: 1, validated_ledger: { reserve_base_xrp: "1", reserve_inc_xrp: "0.2" } } } };
      },
      async disconnect() {},
    }));
    assert.equal(opened.url, hosts.LABS_WS);
    assert.equal(opened.networkId, 1);
    await opened.client.disconnect();

    const xahauSeen = [];
    await assert.rejects(
      () => signer.connectForSign(anchors.XAHAU_WS, policy.agentWallet("W7"), (url) => {
        xahauSeen.push(url);
        return {
          async connect() {
            throw new Error("fetch failed");
          },
          async disconnect() {},
        };
      }),
      (error) => /fetch failed/.test(error.message)
    );
    assert.deepEqual(xahauSeen, [anchors.XAHAU_WS]);

    let loads = 0;
    await assert.rejects(
      () => signer.evaluate({
        wallet: "W5",
        tx: payment(),
      }, ctx({
        skipRpc: false,
        dry: false,
        networkId: null,
        account: null,
        fetchImpl: async (url) => {
          if (String(url).includes("rippletest.net")) throw new Error("fetch failed");
          return rpcResult({ status: "success", info: { network_id: 21337 } });
        },
        clientFactory() {
          throw new Error("socket opened before network id was refused");
        },
        loadSeed() {
          loads += 1;
          throw new Error("key loaded");
        },
      })),
      (error) => error.code === "MAINNET"
    );
    assert.equal(loads, 0);
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
