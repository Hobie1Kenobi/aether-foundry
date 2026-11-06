"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const anchors = require("../director/anchors");
const config = require("./config");
const { Worker } = require("node:worker_threads");
const { control, view, startMission, act } = require("./engine");
const { beginSubmit, notePresign } = require("./submit");
const { tick, run } = require("./worker");
const signer = require("./signer");
const { arm } = require("./arm");
const github = require("./github-publish");
const wallet = require("./wallet-tool");
const { pack } = require("../../machines/missions/release/pack");
const guard = require("./runtime-guard");

const FOREIGN = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const ISOLATED = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const HASH = "AB".repeat(32);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-runtime-"));
}

function layout() {
  const home = tmp();
  const ledger = path.join(home, "ledger");
  fs.mkdirSync(ledger);
  return { home, ledger, discovery: path.join(home, "discovery.json"), allowlist: path.join(home, "allowlist.json") };
}

function writeDiscovery(file, items, extra) {
  fs.writeFileSync(
    file,
    JSON.stringify(Object.assign({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      generated: false,
      items,
    }, extra || {}))
  );
}

function x402Item(id, acceptExtra, url) {
  const resource = url || "https://shop.test/ping";
  return {
    id,
    observed_at: NOW,
    resource: { url: resource, method: "GET" },
    x402: {
      x402Version: 2,
      resource,
      accepts: [Object.assign({
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        amount: "100000",
        payTo: FOREIGN,
        maxTimeoutSeconds: 300,
        fee_drops: "999999",
        extra: { invoiceId: "inv-1", sourceTag: 26100014, fee_drops: "999999" },
      }, acceptExtra || {})],
    },
  };
}

function sellerItem(id, serviceExtra, itemExtra) {
  return Object.assign({
    id,
    service: Object.assign({
      network: "xrpl:1",
      network_id: 1,
      asset: "XRP",
      seller: FOREIGN,
      price_drops: "100000",
    }, serviceExtra || {}),
  }, itemExtra || {});
}

function activate(ledger) {
  control(ledger, {
    action: "activate",
    confirm: config.ACTIVATE_PHRASE,
    token: TOKEN,
    now: NOW,
  }, { token: TOKEN });
}

function workerEnv(extra) {
  return Object.assign({
    FOUNDRY_MISSION_WORKER: "yes",
    MISSION_XRPL_ADDRESS: ISOLATED,
  }, extra || {});
}

function labsQuote(drops, at) {
  return { fee_drops: drops || "12", quoted_at: at || NOW, source: "https://testnet.xrpl-labs.com" };
}

describe("mission worker", () => {
  it("stays asleep and does not invent a seller", async () => {
    const files = layout();
    writeDiscovery(files.discovery, [sellerItem("asleep-item-1")]);
    const body = await tick(Object.assign({}, files, { env: {}, now: NOW }));
    assert.equal(body.asleep, true);
    assert.equal(body.reason, "asleep");
    assert.equal(body.submitted, false);
    assert.equal(fs.existsSync(path.join(files.ledger, "events.jsonl")), false);
  });

  it("does not read discovery until the class is activated", async () => {
    const files = layout();
    writeDiscovery(files.discovery, [x402Item("class-off-item")]);
    const waiting = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(waiting.class_enabled, false);
    assert.equal(waiting.reason, "class_off");
    assert.equal(fs.existsSync(path.join(files.ledger, "events.jsonl")), false);
    activate(files.ledger);
    fs.writeFileSync(files.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    const paid = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW, quoteFee: async () => labsQuote(), fetch: () => { throw new Error("fetch"); } }));
    assert.equal(paid.reason, "ready_for_signer");
    assert.equal(paid.complete, false);
    assert.equal(paid.submitted, false);
    assert.equal(paid.signed, false);
    const again = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(again.reason, "idle");
    assert.equal(view(files.ledger, NOW).days["2026-11-06"].reserved, "100012");
  });

  it("blocks a parent file that has no foreign seller and skips a missing amount", async () => {
    const files = layout();
    activate(files.ledger);
    writeDiscovery(files.discovery, [
      sellerItem("house-only-1", { seller: anchors.WALLETS.W0.address }),
      { id: "missing-pay-1", service: { network: "xrpl:1", network_id: 1, asset: "XRP", seller: FOREIGN } },
      sellerItem("novel-kind-1", {}, { kind: "bridge-return" }),
      sellerItem("untrusted-field-1", { bridge_gas_drops: "1" }),
    ]);
    const first = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(first.code, "no_foreign_seller");
    assert.equal(first.submitted, false);
    const second = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(second.reason, "missing_payment");
    const third = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(third.reason, "novel_kind");
    const fourth = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(fourth.reason, "untrusted_field");
    assert.equal(view(files.ledger, NOW).live_spend_drops, "0");
  });

  it("does not raw-submit a payTo that has no x402 resource", async () => {
    const files = layout();
    activate(files.ledger);
    fs.writeFileSync(files.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    writeDiscovery(files.discovery, [sellerItem("live-item-01")]);
    let calls = 0;
    const body = await tick(Object.assign({}, files, {
      env: workerEnv({ FOUNDRY_MISSION_EXECUTE: "yes", FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN }),
      now: NOW,
      quoteFee: async () => labsQuote(),
      fetch: async () => {
        calls += 1;
        throw new Error("raw submit");
      },
    }));
    assert.equal(body.code, "undeliverable");
    assert.equal(body.submitted, false);
    assert.equal(body.complete, false);
    assert.equal(calls, 0);
    assert.equal(view(files.ledger, NOW).live_spend_drops, "0");
  });

  it("refuses the old checkout and a house seed", async () => {
    await assert.rejects(
      () => tick({ home: "/workspace/aether-foundry", ledger: path.join(os.tmpdir(), "ledger"), env: {}, now: NOW }),
      (error) => error.code === "ISOLATED"
    );
    const files = layout();
    await assert.rejects(
      () => tick(Object.assign({}, files, { env: { W1_REGULAR_SEED: "present" }, now: NOW })),
      (error) => error.code === "HOUSE_SEED"
    );
  });

  it("runs a bounded number of ticks and clamps the interval", async () => {
    const files = layout();
    let slept = 0;
    const body = await run(Object.assign({}, files, {
      env: { FOUNDRY_MISSION_INTERVAL_MS: "1" },
      now: NOW,
      maxTicks: 2,
      listen: false,
      signals: false,
      sleep: async () => {
        slept += 1;
      },
    }));
    assert.equal(body.ticks, 2);
    assert.equal(body.interval_ms, guard.MIN_INTERVAL_MS);
    assert.equal(slept, 1);
    assert.equal(guard.clampInterval("999999999"), guard.MAX_INTERVAL_MS);
  });
});

describe("dedicated mission signer", () => {
  it("reports mission readiness separately and does not sign on a dry call", async () => {
    const env = { FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN, MISSION_XRPL_ADDRESS: ISOLATED };
    const server = signer.startServer({ env, port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    assert.equal(port === 8787 || port === 8792 || port === 8793, false);
    const body = signer.health(env, port);
    assert.equal(body.signing_disabled, true);
    assert.equal(body.mission_spend, false);
    assert.equal(body.mission_signer_armed, false);
    assert.equal(body.ordinary_signing, false);
    let submits = 0;
    const dry = await signer.evaluate({
      intent: "mission_spend",
      dry_run: true,
      tx: {
        TransactionType: "Payment",
        Account: ISOLATED,
        Destination: FOREIGN,
        Amount: "10",
        Fee: "12",
        NetworkID: 1,
      },
    }, Object.assign({ FOUNDRY_MISSION_EXECUTE: "yes", MISSION_XRPL_SEED: "test-seed-value" }, env), {
      submit: () => {
        submits += 1;
      },
    });
    assert.equal(dry.submitted, false);
    assert.equal(dry.key_loaded, false);
    assert.equal(submits, 0);
    server.close();
  });

  it("refuses house seeds, the ordinary ports, gateway payments, and a secrets file", async () => {
    await assert.rejects(
      () => signer.evaluate({ intent: "mission_spend", tx: {} }, { W0_SEED: "no" }),
      (error) => error.code === "HOUSE_SEED"
    );
    assert.throws(() => guard.assertFreePort(8787, 8788), (error) => error.code === "BIND");
    assert.throws(() => guard.assertLoopback("0.0.0.0"), (error) => error.code === "BIND");
    const tx = {
      TransactionType: "Payment",
      Account: ISOLATED,
      Destination: FOREIGN,
      Amount: "10",
      Fee: "12",
      NetworkID: 1,
    };
    const env = { MISSION_XRPL_ADDRESS: ISOLATED, FOUNDRY_MISSION_EXECUTE: "yes", MISSION_XRPL_SEED: "test-seed-value" };
    await assert.rejects(
      () => signer.evaluate({ intent: "mission_spend", execute: true, tx: Object.assign({}, tx, { Destination: "rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2" }) }, env, { submit: () => ({}) }),
      (error) => error.code === "BRIDGE"
    );
    await assert.rejects(
      () => signer.evaluate({ intent: "mission_spend", execute: true, tx }, env, { io: { readFileSync: () => "" }, openWallet: () => ({ classicAddress: ISOLATED }), submit: () => ({}) }),
      (error) => error.code === "SEED"
    );
  });
});

describe("github contents publish", () => {
  it("uploads only the sanitized snapshot and skips an unchanged copy", async () => {
    const files = layout();
    activate(files.ledger);
    const token = "github-token-value";
    const calls = [];
    let stored = null;
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: (init && init.method) || "GET" });
      assert.equal(String(url).includes(token), false);
      assert.equal(String(url).includes("director-state"), false);
      if (!init || init.method !== "PUT") {
        if (!stored) return { ok: false, status: 404, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ sha: "abc", path: github.ALLOWED_PATH, content: Buffer.from(stored).toString("base64"), encoding: "base64" }),
        };
      }
      assert.equal(url, `https://api.github.com/repos/${github.ALLOWED_REPO}/contents/${github.ALLOWED_PATH}`);
      const body = JSON.parse(init.body);
      stored = Buffer.from(body.content, "base64").toString("utf8");
      assert.equal(stored.includes("sEd"), false);
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      return { ok: true, status: 201, json: async () => ({}) };
    };
    const first = await github.uploadSnapshot(files.ledger, {
      env: { FOUNDRY_MISSION_GITHUB_TOKEN: token },
      now: NOW,
      fetch: fetchImpl,
    });
    assert.equal(first.uploaded, true);
    assert.equal(first.path, "lab/missions/public-status.json");
    const second = await github.uploadSnapshot(files.ledger, {
      env: { FOUNDRY_MISSION_GITHUB_TOKEN: token },
      now: NOW,
      fetch: fetchImpl,
    });
    assert.equal(second.uploaded, false);
    assert.equal(second.reason, "throttled");
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.throws(() => github.contentsUrl("other/repo", "main"), (error) => error.code === "PUBLISH");
  });
});

describe("isolated wallet tool", () => {
  it("writes an account only when asked and does not print the seed from the module entry", async () => {
    const root = tmp();
    await assert.rejects(
      () => wallet.createIsolated({ env: {}, out: path.join(root, "account.json"), testRoot: root, generate: () => ({}) }),
      (error) => error.code === "WALLET"
    );
    const created = await wallet.createIsolated({
      env: { FOUNDRY_MISSION_WALLET_TOOL: "yes" },
      out: path.join(root, "account.json"),
      testRoot: root,
      generate: async () => ({ classicAddress: ISOLATED, seed: "test-seed-value-not-printed" }),
    });
    assert.equal(created.address, ISOLATED);
    assert.equal(created.funded, false);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "account.json"), "utf8"));
    assert.equal(stored.address, ISOLATED);
    assert.equal((fs.statSync(path.join(root, "account.json")).mode & 0o777), 0o600);
    await assert.rejects(
      () => wallet.createIsolated({
        env: { FOUNDRY_MISSION_WALLET_TOOL: "yes" },
        out: "/workspace/aether-foundry/account.json",
        generate: () => ({ classicAddress: ISOLATED, seed: "x" }),
      }),
      (error) => error.code === "ISOLATED" || error.code === "WALLET"
    );
    const src = fs.readFileSync(path.join(__dirname, "wallet-tool.js"), "utf8");
    assert.match(src, /Wallet\.generate/);
    assert.match(src, /fundWallet/);
    assert.match(src, /wss:\/\/testnet\.xrpl-labs\.com/);
    assert.match(src, /faucet\.altnet\.rippletest\.net/);
    assert.doesNotMatch(src, /sEd[1-9A-HJ-NP-Za-km-z]{15,}/);
    const proved = await wallet.proveFaucet({
      networkID: 1,
      request: async () => ({ result: { info: { network_id: 1 } } }),
    });
    assert.equal(proved.websocket, wallet.LABS_WS);
    assert.equal(proved.faucetHost, "faucet.altnet.rippletest.net");
    assert.equal(proved.network_id, 1);
    await assert.rejects(
      () => wallet.proveFaucet({ networkID: 0, request: async () => ({ result: { info: { network_id: 0 } } }) }),
      (error) => error.code === "MAINNET"
    );
  });
});

describe("submit claims", () => {
  function readyMission(files) {
    activate(files.ledger);
    const started = startMission(files.ledger, {
      idempotency_key: "claim-race-1",
      now: NOW,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: FOREIGN }] },
      payment_drops: "100000",
      network_fee_drops: "12",
    }, { allowlist: { payees: [FOREIGN] } });
    return act(files.ledger, { mission_id: started.mission.id, now: NOW }, { wallet: { address: ISOLATED } }).mission;
  }

  it("lets one process claim a submit and keeps a restart uncertain", async () => {
    const files = layout();
    const mission = readyMission(files);
    const counter = path.join(files.home, "claims.txt");
    fs.writeFileSync(counter, "");
    const submitPath = require.resolve("./submit");
    const results = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
      const worker = new Worker(
        `
          const fs = require("fs");
          const { beginSubmit } = require(${JSON.stringify(submitPath)});
          const { parentPort, workerData } = require("node:worker_threads");
          try {
            const result = beginSubmit(workerData.dir, { mission_id: workerData.id, now: workerData.now });
            if (result.proceed) fs.appendFileSync(workerData.counter, "1\\n");
            parentPort.postMessage({ proceed: result.proceed === true, code: null });
          } catch (error) {
            parentPort.postMessage({ proceed: false, code: error.code || "ERROR" });
          }
        `,
        { eval: true, workerData: { dir: files.ledger, id: mission.id, now: NOW, counter } }
      );
      worker.on("message", resolve);
      worker.on("error", reject);
    })));
    assert.equal(results.filter((row) => row.proceed).length, 1);
    assert.equal(results.filter((row) => row.code === "NO_RETRY").length, 1);
    assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
    assert.throws(
      () => beginSubmit(files.ledger, { mission_id: mission.id, now: NOW }),
      (error) => error.code === "NO_RETRY"
    );
    const status = view(files.ledger, NOW);
    assert.equal(status.days["2026-11-06"].uncertain, "100012");
    assert.equal(status.days["2026-11-06"].reserved, "0");
    assert.equal(status.live_spend_drops, "100012");
  });

  it("refuses a loopback signer that has a token but no matching claim", async () => {
    const files = layout();
    const mission = readyMission(files);
    beginSubmit(files.ledger, { mission_id: mission.id, now: NOW });
    const tx = Object.assign({}, mission.unsigned_tx, { Sequence: 22117391, LastLedgerSequence: 22118889 });
    let submits = 0;
    const env = {
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_LEDGER: files.ledger,
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      MISSION_XRPL_ADDRESS: ISOLATED,
      MISSION_XRPL_SEED: "test-seed-value",
    };
    const deps = {
      validatedAccount: { validated: 22118869, sequence: 22117391 },
      openWallet: () => ({ classicAddress: ISOLATED, sign: () => ({ tx_blob: "00" }) }),
      submit: () => {
        submits += 1;
        return { hash: HASH, engine_result: "tesSUCCESS", network_id: 1 };
      },
    };
    await assert.rejects(
      () => signer.evaluate({
        intent: "mission_spend",
        execute: true,
        mission_id: mission.id,
        tx: Object.assign({}, tx, { Amount: "1" }),
      }, env, deps),
      (error) => error.code === "CLAIM"
    );
    assert.equal(submits, 0);
    const signed = await signer.evaluate({
      intent: "mission_spend",
      execute: true,
      mission_id: mission.id,
      tx,
    }, env, deps);
    assert.equal(signed.submitted, true);
    assert.equal(submits, 1);
    await assert.rejects(
      () => signer.evaluate({ intent: "mission_spend", execute: true, mission_id: mission.id, tx }, env, deps),
      (error) => error.code === "NO_RETRY"
    );
    assert.equal(submits, 1);
    const server = signer.startServer({
      env: {
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: ISOLATED,
        MISSION_XRPL_SEED: "test-seed-value",
      },
      port: 0,
    });
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ intent: "mission_spend", execute: true, tx }),
    });
    const denied = await response.json();
    assert.equal(denied.code, "CLAIM");
    server.close();
  });
});

describe("authenticated arming", () => {
  it("arms from a 0600 account file without raising caps or returning the seed", () => {
    const files = layout();
    const account = path.join(files.home, "account.json");
    fs.writeFileSync(account, `${JSON.stringify({ address: ISOLATED, seed: "test-seed-value-not-printed" })}\n`, { mode: 0o600 });
    fs.chmodSync(account, 0o600);
    const result = arm({
      env: { FOUNDRY_MISSION_HOME: files.home, FOUNDRY_MISSION_LEDGER: files.ledger, FOUNDRY_MISSION_TOKEN: TOKEN },
      token: TOKEN,
      confirm: "ACTIVATE-XRPL1-MISSION-SPEND",
      now: NOW,
    });
    assert.equal(result.mission_signer_armed, true);
    assert.equal(result.signing_disabled, false);
    assert.equal(result.per_mission_drops, "1000000");
    assert.equal(JSON.stringify(result).includes("test-seed"), false);
    assert.equal((fs.statSync(path.join(files.home, "arm.json")).mode & 0o777), 0o600);
    assert.throws(
      () => arm({
        env: { FOUNDRY_MISSION_HOME: files.home, FOUNDRY_MISSION_LEDGER: files.ledger, FOUNDRY_MISSION_TOKEN: TOKEN },
        token: TOKEN,
        confirm: "ACTIVATE-XRPL1-MISSION-SPEND",
        per_mission_drops: "2000000",
        now: NOW,
      }),
      (error) => error.code === "CAP"
    );
    const ready = require("./runner").ready({
      FOUNDRY_MISSION_HOME: files.home,
      FOUNDRY_MISSION_LEDGER: files.ledger,
    }, files.ledger);
    assert.equal(ready.mission_signer_armed, true);
    assert.equal(ready.signing_disabled, false);
    assert.equal(ready.mission_spend_enabled, true);
  });
});

describe("x402 qualification and network fee", () => {
  it("uses an xrpl:1 payTo amount and a Labs fee, not a merchant fee", async () => {
    const files = layout();
    activate(files.ledger);
    fs.writeFileSync(files.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    writeDiscovery(files.discovery, [x402Item("x402-accept-1", { amount: "5000" })]);
    const calls = [];
    const body = await tick(Object.assign({}, files, {
      env: workerEnv(),
      now: NOW,
      quoteFee: async () => {
        calls.push("quote");
        return labsQuote("10");
      },
    }));
    assert.equal(body.reason, "ready_for_signer");
    assert.equal(body.complete, false);
    assert.equal(body.submitted, false);
    assert.equal(calls.length, 1);
    assert.equal(view(files.ledger, NOW).days["2026-11-06"].reserved, "5010");
    const mission = view(files.ledger, NOW).missions[body.mission_id];
    assert.equal(mission.complete === true, false);
    assert.equal(mission.budget.network_fee_drops, "10");
    assert.equal(mission.budget.payment_drops, "5000");
  });

  it("records an unsupported protocol instead of an empty discovery", async () => {
    const files = layout();
    activate(files.ledger);
    writeDiscovery(files.discovery, [{
      id: "stripe-item-1",
      protocol: "stripe",
    }, {
      id: "evm-accept-01",
      x402: { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:1", asset: "USDC", amount: "1", payTo: "0xabc" }] },
    }]);
    const first = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(first.reason, "unsupported_protocol");
    assert.equal(first.code, "unsupported_protocol");
    const second = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(second.reason, "unsupported_protocol");
    const feed = require("./engine").publicFeed(files.ledger, NOW);
    assert.equal(feed.missions.length, 2);
    assert.equal(feed.missions.every((mission) => mission.code === "unsupported_protocol"), true);
    assert.equal(feed.live_spend_drops, "0");
  });

  it("rejects a fee above the local bound and a stale requote before sign", async () => {
    const files = layout();
    activate(files.ledger);
    fs.writeFileSync(files.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    writeDiscovery(files.discovery, [x402Item("fee-bound-01")]);
    const over = await tick(Object.assign({}, files, {
      env: workerEnv(),
      now: NOW,
      quoteFee: async () => labsQuote("10001"),
    }));
    assert.equal(over.code, "FEE_CAP");
    assert.equal(view(files.ledger, NOW).days["2026-11-06"], undefined);
    const again = layout();
    activate(again.ledger);
    fs.writeFileSync(again.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    writeDiscovery(again.discovery, [x402Item("fee-stale-01")]);
    let n = 0;
    let fetches = 0;
    const stale = await tick(Object.assign({}, again, {
      env: workerEnv({ FOUNDRY_MISSION_EXECUTE: "yes" }),
      now: NOW,
      quoteFee: async () => {
        n += 1;
        return n === 1 ? labsQuote("12") : labsQuote("12", "2026-11-06T17:00:00.000Z");
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("should not submit");
      },
    }));
    assert.equal(stale.code, "FEE_STALE");
    assert.equal(fetches, 0);
    assert.equal(view(again.ledger, NOW).days["2026-11-06"].reserved, "0");
  });

  it("reads the open ledger fee only from XRPL Labs network id 1", async () => {
    const quoted = await require("./network-fee").quoteNetworkFee({
      now: NOW,
      fetch: async (url, init) => {
        assert.equal(url, "https://testnet.xrpl-labs.com");
        assert.equal(init.headers["user-agent"], "aether-foundry-missions");
        const body = JSON.parse(init.body);
        if (body.method === "server_info") return { ok: true, json: async () => ({ result: { info: { network_id: 1 } } }) };
        return { ok: true, json: async () => ({ result: { drops: { open_ledger_fee: "10", base_fee: "10" }, ledger_current_index: 4 } }) };
      },
    });
    assert.equal(quoted.fee_drops, "10");
    await assert.rejects(
      () => require("./network-fee").quoteNetworkFee({
        now: NOW,
        fetch: async () => ({ ok: true, json: async () => ({ result: { info: { network_id: 2 } } }) }),
      }),
      (error) => error.code === "MAINNET"
    );
    await assert.rejects(
      () => require("./network-fee").quoteNetworkFee({
        now: NOW,
        fetch: async () => ({ ok: true, json: async () => ({ result: { info: {} } }) }),
      }),
      (error) => error.code === "MAINNET"
    );
    assert.throws(
      () => require("./network-fee").assertFresh(labsQuote("10", "2026-11-06T17:00:00.000Z"), NOW),
      (error) => error.code === "FEE_STALE"
    );
    const labsFee = {
      result: {
        drops: { base_fee: "10", median_fee: "5000", minimum_fee: "10", open_ledger_fee: "10" },
        ledger_current_index: 22117859,
      },
    };
    assert.equal(require("./network-fee").feeDrops(labsFee), "10");
    const fromLabs = await require("./network-fee").quoteNetworkFee({
      now: NOW,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (init.headers["user-agent"] !== "aether-foundry-missions") return { ok: false, status: 403, json: async () => ({}) };
        if (body.method === "server_info") {
          return { ok: true, json: async () => ({ result: { info: { build_version: "3.4.1", network_id: 1, load_factor: 1 } } }) };
        }
        return { ok: true, json: async () => labsFee };
      },
    });
    assert.equal(fromLabs.fee_drops, "10");
    assert.equal(require("./network-fee").reserveCeiling("10"), "1010");
    assert.equal(require("./network-fee").reserveCeiling("9500"), "10000");
    await assert.rejects(
      () => require("./network-fee").quoteNetworkFee({
        now: NOW,
        fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
      }),
      (error) => error.code === "FEE"
    );
  });

  it("delivers an x402 proof before any ledger submit and does not widen payTo", async () => {
    const files = layout();
    activate(files.ledger);
    const allowPath = files.allowlist;
    fs.writeFileSync(allowPath, JSON.stringify({ payees: [FOREIGN] }));
    const outside = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    const supported = "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
    writeDiscovery(files.discovery, [
      x402Item("deliver-item-1", {}, supported),
      x402Item("outside-scope1", { payTo: outside, amount: "1000" }, supported),
    ]);
    let phase = "challenge";
    let submits = 0;
    const proofHashes = [];
    const resourceFetch = async (url, init) => {
      assert.equal(url, "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96");
      const header = init && init.headers && (init.headers["PAYMENT-SIGNATURE"] || init.headers["payment-signature"]);
      if (!header) {
        return { status: 402, json: async () => x402Item("deliver-item-1").x402 };
      }
      const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      proofHashes.push(payload);
      assert.equal(payload.x402Version, 2);
      assert.equal(payload.accepted.payTo, FOREIGN);
      assert.equal(payload.accepted.amount, "100000");
      assert.equal(payload.accepted.fee_drops, undefined);
      if (phase === "challenge") {
        phase = "needs-ledger";
        return { status: 402, text: async () => JSON.stringify({ code: "payment_not_on_ledger" }), headers: { get() { return ""; } } };
      }
      return {
        status: 200,
        text: async () => JSON.stringify({
          data: {
            listed: false,
            query: { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" },
          },
        }),
        headers: { get() { return ""; } },
      };
    };
    const body = await tick(Object.assign({}, files, {
      env: workerEnv({ FOUNDRY_MISSION_EXECUTE: "yes", FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN }),
      now: NOW,
      quoteFee: async () => labsQuote("12"),
      preparedAccount: { validated: 22118869, sequence: 22117391 },
      resourceFetch,
      presign: async (mission) => {
        notePresign(files.ledger, mission.id, HASH, { tx: mission.unsigned_tx });
        return { tx_blob: "BLOB", hash: HASH };
      },
      fetch: async (_url, init) => {
        submits += 1;
        const incoming = JSON.parse(init.body);
        const result = await signer.evaluate(incoming, {
          FOUNDRY_MISSION_EXECUTE: "yes",
          FOUNDRY_MISSION_LEDGER: files.ledger,
          MISSION_XRPL_ADDRESS: ISOLATED,
          MISSION_XRPL_SEED: "test-seed-value",
        }, {
          validatedAccount: { validated: 22118869, sequence: 22117391 },
          openWallet: () => ({ classicAddress: ISOLATED, sign: () => ({ tx_blob: "BLOB", hash: HASH }) }),
          submit: () => ({ hash: HASH, engine_result: "tesSUCCESS", network_id: 1 }),
        });
        return { ok: true, json: async () => result };
      },
    }));
    assert.equal(submits, 1);
    assert.equal(proofHashes.length >= 1, true);
    assert.equal(body.complete, true);
    assert.equal(body.submitted, true);
    assert.equal(view(files.ledger, NOW).live_spend_drops, "100012");
    const mission = view(files.ledger, NOW).missions[body.mission_id];
    assert.equal(mission.artifact.seller, FOREIGN);
    assert.equal(mission.budget.network_fee_drops, "12");
    const denied = await tick(Object.assign({}, files, {
      env: workerEnv({ FOUNDRY_MISSION_EXECUTE: "yes" }),
      now: NOW,
      quoteFee: async () => labsQuote("12"),
    }));
    assert.equal(denied.code, "payee_not_allowlisted");
    assert.equal(JSON.parse(fs.readFileSync(allowPath, "utf8")).payees.includes(outside), false);
  });
});

describe("dedicated port release", () => {
  it("does not kill a listener that is not the recorded pid", async () => {
    const net = require("net");
    const { releaseOwn } = require("./port-wait");
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await assert.rejects(
      () => releaseOwn({ pid: 999999, port, allowPort: true, signal: false, waitMs: 200, stepMs: 20 }),
      (error) => error.code === "PORT_BUSY"
    );
    assert.equal(server.listening, true);
    await new Promise((resolve) => server.close(resolve));
  });
});

describe("release pack", () => {
  it("packs runtime files and leaves out git, env, lab data, and seeds", async () => {
    const out = tmp();
    const result = pack({ outDir: out });
    const listed = spawnSync("tar", ["-tf", result.tarPath], { encoding: "utf8" });
    assert.equal(listed.status, 0);
    const names = listed.stdout.split("\n").filter(Boolean);
    for (const name of names) {
      assert.equal(name.includes(".git"), false, name);
      assert.equal(name.includes(".env"), false, name);
      assert.equal(name.startsWith("lab/"), false, name);
      assert.equal(name.includes("node_modules"), false, name);
      assert.equal(/seed/i.test(name), false, name);
      assert.equal(name.includes("events.jsonl"), false, name);
      assert.equal(name.includes("director-state"), false, name);
    }
    assert.equal(names.some((name) => name.endsWith("package-lock.json")), true);
    assert.equal(names.some((name) => name.endsWith("src/missions/worker.js")), true);
    assert.equal(names.some((name) => name.endsWith("machines/missions/ensure-up.snippet.sh")), true);
    assert.equal(names.some((name) => name.endsWith("src/missions/port-wait.js")), true);
    assert.equal(names.some((name) => name.endsWith("src/missions/retry-fee.js")), true);
    const snippet = fs.readFileSync(path.join(result.stage, "machines/missions/ensure-up.snippet.sh"), "utf8");
    assert.equal(snippet.includes("REPLACE_WITH_RELEASE_SHA"), false);
    assert.equal(snippet.includes(result.gitSha), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.stage, "manifest.json"), "utf8"));
    assert.equal(manifest.base, "1116ce48a3128aa4ccfb8429c06841bf5cb844aa");
    const worker = manifest.files.find((row) => row.path === "src/missions/worker.js");
    assert.equal(worker.sha256, require("crypto").createHash("sha256").update(fs.readFileSync(path.join(result.stage, "src/missions/worker.js"))).digest("hex"));
    const sums = fs.readFileSync(path.join(result.stage, "SHA256SUMS"), "utf8");
    assert.equal(sums.includes("src/missions/execute-once.js"), true);
    assert.equal(sums.includes("src/missions/publish-health.js"), true);
    assert.equal(sums.includes("src/missions/new-account.js"), true);
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "mission-unpack-"));
    const extracted = spawnSync("tar", ["-xf", result.tarPath, "-C", clean], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    for (const rel of ["src/missions/execute-once.js", "src/missions/publish-health.js", "bin/execute", "bin/publish"]) {
      assert.equal(fs.existsSync(path.join(clean, rel)), true, rel);
    }
    const installed = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
      cwd: clean,
      encoding: "utf8",
    });
    assert.equal(installed.status, 0, installed.stderr);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mission-bin-home-"));
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    function runBin(name, env) {
      return spawnSync(path.join(clean, "bin", name), {
        cwd: clean,
        encoding: "utf8",
        env,
      });
    }
    const bare = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
    };
    const publishMiss = runBin("publish", bare);
    assert.equal(publishMiss.status, 1);
    assert.equal(publishMiss.stderr.trim(), "AUTH");
    assert.equal(publishMiss.stderr.includes("MODULE_NOT_FOUND"), false);
    assert.equal(publishMiss.stdout.includes("MODULE_NOT_FOUND"), false);
    const executeMiss = runBin("execute", bare);
    assert.equal(executeMiss.status, 1);
    assert.equal(executeMiss.stderr.trim(), "AUTH");
    assert.equal(executeMiss.stderr.includes("MODULE_NOT_FOUND"), false);
    const generated = spawnSync(process.execPath, ["-e", "const xrpl=require('xrpl'); const old=xrpl.Wallet.generate(); const next=xrpl.Wallet.generate(); process.stdout.write(JSON.stringify({old:old.address,next:next.address,seed:next.seed}));"], {
      cwd: clean,
      encoding: "utf8",
    });
    assert.equal(generated.status, 0);
    const wallets = JSON.parse(generated.stdout);
    const redact = (text) => String(text || "").split(wallets.seed).join("[redacted]");
    const idFile = path.join(home, "prior-id");
    const setup = spawnSync(process.execPath, ["-e", `
      const fs = require("fs");
      const { control, startMission, act } = require("./src/missions/engine");
      const { beginSubmit, notePresign } = require("./src/missions/submit");
      const config = require("./src/missions/config");
      const ledger = process.argv[1];
      const oldAddress = process.argv[2];
      const now = "2026-11-06T21:40:00.000Z";
      control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: "mission-internal-16", now }, { token: "mission-internal-16" });
      const opened = startMission(ledger, {
        idempotency_key: "old-hold-1747",
        now,
        observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs" }] },
        payment_drops: "1737",
        network_fee_drops: "10",
        resource_url: "https://shop.test/old",
      }, { allowlist: { payees: ["rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs"] } });
      const ready = act(ledger, { mission_id: opened.mission.id, now }, { wallet: { address: oldAddress } }).mission;
      beginSubmit(ledger, { mission_id: ready.id, now });
      notePresign(ledger, ready.id, "${"AB".repeat(32)}");
      fs.writeFileSync(process.argv[3], ready.id);
    `, ledger, wallets.old, idFile], { cwd: clean, encoding: "utf8" });
    assert.equal(setup.status, 0, redact(setup.stderr));
    const prior = fs.readFileSync(idFile, "utf8");
    const accountRun = runBin("account", Object.assign({}, bare, {
      FOUNDRY_MISSION_ACCOUNT_TOKEN: "account-decision-token-32chars-min",
      FOUNDRY_MISSION_ACCOUNT_PHRASE: "USE-NEW-ISOLATED-ACCOUNT",
      FOUNDRY_MISSION_PRIOR_CLAIM: prior,
    }));
    assert.equal(accountRun.status, 0, redact(`${accountRun.stderr}\n${accountRun.stdout}`));
    const sanctions = "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
    const invoice = "packedfresh100aabbcc01";
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs", resource: sanctions }],
    }));
    fs.writeFileSync(path.join(home, "challenge.json"), JSON.stringify({
      retrieved_at: new Date().toISOString(),
      http_status: 402,
      paid: false,
      proof_sent: false,
      resource_url_requested: sanctions,
      resource_url_in_body: sanctions,
      resource_url_exact_match: true,
      x402Version: 2,
      reviewed_row: {
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        amount: "100",
        payTo: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs",
        maxTimeoutSeconds: 600,
        extra: { sourceTag: 26100014, invoiceId: invoice },
      },
    }));
    const preload = path.join(home, "preload.js");
    fs.writeFileSync(preload, `
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        const body = init && init.body ? JSON.parse(init.body) : {};
        if (target === "https://testnet.xrpl-labs.com") {
          if (body.method === "server_info") {
            return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: 22118869 } } } }), { status: 200 });
          }
          if (body.method === "account_info") {
            return new Response(JSON.stringify({ result: { validated: true, account_data: { Sequence: 22117391 } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ result: { drops: { open_ledger_fee: "10", base_fee: "10", median_fee: "5000" }, ledger_current_index: 22118869 } }), { status: 200 });
        }
        if (target.startsWith("https://api.stablecoingateways.com/v1/sanctions/address")) {
          const header = init && init.headers && (init.headers["PAYMENT-SIGNATURE"] || init.headers["payment-signature"]);
          if (!header) {
            return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "100", payTo: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs", maxTimeoutSeconds: 600, extra: { invoiceId: ${JSON.stringify(invoice)}, sourceTag: 26100014 } }] }), { status: 402 });
          }
          return new Response(JSON.stringify({ data: { listed: false, query: { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" } } }), { status: 200 });
        }
        if (target.startsWith("http://127.0.0.1:") || target.startsWith("http://localhost:")) return original(url, init);
        return new Response("{}", { status: 500 });
      };
    `);
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: clean,
      env: Object.assign({}, bare, {
        CI: "",
        GITHUB_ACTIONS: "",
        FOUNDRY_MISSION_SIGNER_TOKEN: "mission-internal-16",
        FOUNDRY_MISSION_SIGNER_PORT: "18796",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: wallets.next,
        MISSION_XRPL_SEED: wallets.seed,
        NODE_OPTIONS: `--require ${preload}`,
      }),
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
        const wait = () => {
          fetch("http://127.0.0.1:18796/health").then((res) => res.json()).then(() => {
            clearTimeout(timer);
            resolve();
          }).catch(() => setTimeout(wait, 50));
        };
        wait();
      });
      const bought = runBin("execute", Object.assign({}, bare, {
        CI: "",
        GITHUB_ACTIONS: "",
        FOUNDRY_MISSION_EXECUTE_TOKEN: "execute-one-shot-token-32chars-min",
        FOUNDRY_MISSION_EXECUTE_PHRASE: "EXECUTE-ONE-FRESH-PURCHASE",
        FOUNDRY_MISSION_CHALLENGE_FILE: path.join(home, "challenge.json"),
        FOUNDRY_MISSION_SIGNER_TOKEN: "mission-internal-16",
        FOUNDRY_MISSION_SIGNER_PORT: "18796",
        MISSION_XRPL_ADDRESS: wallets.next,
        NODE_OPTIONS: `--require ${preload}`,
      }));
      assert.equal(bought.status, 0, redact(`${bought.stderr}\n${bought.stdout}`));
      assert.equal(bought.stderr.includes("MODULE_NOT_FOUND"), false);
      assert.equal(bought.stdout.includes(wallets.seed), false);
      const body = JSON.parse(bought.stdout);
      assert.equal(body.complete, true);
      assert.equal(body.prior_claim_id, prior);
      const state = view(ledger, "2026-11-06T21:40:00.000Z");
      assert.equal(state.missions[prior].hold, "uncertain");
      assert.equal(state.missions[prior].budget.budget_drops, "1747");
      const published = runBin("publish", Object.assign({}, bare, {
        FOUNDRY_MISSION_PUBLISH_TOKEN: "publish-health-token-32chars-minimum",
        FOUNDRY_MISSION_PUBLISH_PHRASE: "PUBLISH-HEALTH-SNAPSHOT",
      }));
      assert.equal(published.status, 0, redact(`${published.stderr}\n${published.stdout}`));
      assert.equal(published.stderr.includes("MODULE_NOT_FOUND"), false);
      const health = JSON.parse(published.stdout);
      assert.equal(health.execute, false);
      assert.equal(health.worker_asleep, true);
      assert.equal(health.uploaded, false);
      assert.equal(health.reason, "no_ingest_secret");
      const snap = JSON.parse(fs.readFileSync(path.join(ledger, "public-status.json"), "utf8"));
      assert.equal(snap.worker_asleep, true);
      assert.equal(snap.execute, false);
      assert.equal(snap.uncertain_drops, "1747");
    } finally {
      signer.kill("SIGTERM");
    }
  });
});
