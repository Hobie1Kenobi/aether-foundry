"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const anchors = require("../director/anchors");
const config = require("./config");
const { Worker } = require("node:worker_threads");
const { control, view, startMission, act } = require("./engine");
const { beginSubmit } = require("./submit");
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

function sellerItem(id, serviceExtra, itemExtra) {
  return Object.assign({
    id,
    service: Object.assign({
      network: "xrpl:1",
      network_id: 1,
      asset: "XRP",
      seller: FOREIGN,
      price_drops: "100000",
      fee_drops: "12",
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
    writeDiscovery(files.discovery, [sellerItem("class-off-item")]);
    const waiting = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW }));
    assert.equal(waiting.class_enabled, false);
    assert.equal(waiting.reason, "class_off");
    assert.equal(fs.existsSync(path.join(files.ledger, "events.jsonl")), false);
    activate(files.ledger);
    fs.writeFileSync(files.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    const paid = await tick(Object.assign({}, files, { env: workerEnv(), now: NOW, fetch: () => { throw new Error("fetch"); } }));
    assert.equal(paid.reason, "complete");
    assert.equal(paid.complete, true);
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
      { id: "missing-pay-1", service: { network: "xrpl:1", network_id: 1, asset: "XRP", seller: FOREIGN, fee_drops: "12" } },
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

  it("submits only through the dedicated signer when execute is already on", async () => {
    const files = layout();
    activate(files.ledger);
    fs.writeFileSync(files.allowlist, JSON.stringify({ payees: [FOREIGN] }));
    writeDiscovery(files.discovery, [sellerItem("live-item-01")]);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      assert.equal(url, "http://127.0.0.1:8788/sign");
      const incoming = JSON.parse(init.body);
      const result = await signer.evaluate(incoming, {
        FOUNDRY_MISSION_EXECUTE: "yes",
        FOUNDRY_MISSION_LEDGER: files.ledger,
        MISSION_XRPL_ADDRESS: ISOLATED,
        MISSION_XRPL_SEED: "test-seed-value",
      }, {
        openWallet: () => ({ classicAddress: ISOLATED, sign: () => ({ tx_blob: "00" }) }),
        submit: () => ({ hash: HASH, engine_result: "tesSUCCESS", network_id: 1 }),
      });
      return { ok: true, json: async () => result };
    };
    const body = await tick(Object.assign({}, files, {
      env: workerEnv({ FOUNDRY_MISSION_EXECUTE: "yes", FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN }),
      now: NOW,
      fetch: fetchImpl,
    }));
    assert.equal(body.submitted, true);
    assert.equal(body.complete, true);
    assert.equal(calls.length, 1);
    assert.equal(view(files.ledger, NOW).live_spend_drops, "100012");
    await tick(Object.assign({}, files, { env: workerEnv({ FOUNDRY_MISSION_EXECUTE: "yes" }), now: NOW, fetch: fetchImpl }));
    assert.equal(calls.length, 1);
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
    assert.equal(second.reason, "unchanged");
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
    const tx = mission.unsigned_tx;
    let submits = 0;
    const env = {
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_LEDGER: files.ledger,
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      MISSION_XRPL_ADDRESS: ISOLATED,
      MISSION_XRPL_SEED: "test-seed-value",
    };
    const deps = {
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

describe("release pack", () => {
  it("packs runtime files and leaves out git, env, lab data, and seeds", () => {
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
    const manifest = JSON.parse(fs.readFileSync(path.join(result.stage, "manifest.json"), "utf8"));
    assert.equal(manifest.base, "1116ce48a3128aa4ccfb8429c06841bf5cb844aa");
    const worker = manifest.files.find((row) => row.path === "src/missions/worker.js");
    assert.equal(worker.sha256, require("crypto").createHash("sha256").update(fs.readFileSync(path.join(result.stage, "src/missions/worker.js"))).digest("hex"));
    const installed = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
      cwd: result.stage,
      encoding: "utf8",
    });
    assert.equal(installed.status, 0, installed.stderr);
    const loaded = spawnSync(process.execPath, ["-e", "require('./src/missions/worker'); require('./src/missions/signer'); require('./src/missions/github-publish');"], {
      cwd: result.stage,
      encoding: "utf8",
    });
    assert.equal(loaded.status, 0, loaded.stderr);
  });
});
