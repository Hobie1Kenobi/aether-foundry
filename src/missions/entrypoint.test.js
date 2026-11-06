"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");
const xrpl = require("xrpl");
const config = require("./config");
const { control, view, blockMission, startMission, signedClaimMayRelease } = require("./engine");
const { beginSubmit, notePresign, releaseUnsignedClaim, releasePrepared, releasePassedWindow } = require("./submit");
const { retryPreSignFee } = require("./retry-fee");
const deskFold = require("../../web/lib/mission-fold");

const FOREIGN = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const ROOT = path.resolve(__dirname, "..", "..");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-entry-"));
}

function activate(ledger, now) {
  control(ledger, {
    action: "activate",
    confirm: config.ACTIVATE_PHRASE,
    token: TOKEN,
    now,
  }, { token: TOKEN });
}

function item(id, resource, payTo, now, amount) {
  return {
    id,
    observed_at: now,
    resource: { url: resource, method: "GET" },
    x402: {
      x402Version: 2,
      resource,
      accepts: [{
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        amount: amount || "5000",
        payTo,
        maxTimeoutSeconds: 300,
        fee_drops: "999999",
      }],
    },
  };
}

function childEnv(extra) {
  return Object.assign({}, process.env, extra, { CI: "", GITHUB_ACTIONS: "" });
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("production worker entrypoint", () => {
  it("quotes XRPL Labs from the CLI without an injected fetch", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = new Date().toISOString();
    const resource = "https://shop.test/reviewed";
    activate(ledger, now);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: REVIEWED, resource }],
    }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [item("cand-reviewed-1", resource, REVIEWED, now)],
    }));
    const result = await runNode(["src/missions/worker.js", "--once"], childEnv({
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "",
      MISSION_XRPL_ADDRESS: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ",
    }));
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.notEqual(body.code, "FEE");
    assert.equal(body.reason, "ready_for_signer");
    assert.equal(body.submitted, false);
    assert.equal(body.complete, false);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.match(mission.budget.network_fee_drops, /^[1-9][0-9]*$/);
    assert.equal(mission.budget.payment_drops, "5000");
    assert.notEqual(mission.budget.network_fee_drops, "999999");
  });

  it("runs the worker and signer processes against a mock seller without opts.fetch", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = new Date().toISOString();
    const wallet = xrpl.Wallet.generate();
    let proofs = 0;
    const seller = http.createServer((req, res) => {
      const header = req.headers["payment-signature"];
      if (!header) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "5000", payTo: REVIEWED }],
        }));
        return;
      }
      proofs += 1;
      const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      if (payload.x402Version !== 2 || payload.accepted.payTo !== REVIEWED || payload.accepted.amount !== "5000") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "bad_proof" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ping" }));
    });
    await new Promise((resolve) => seller.listen(0, "127.0.0.1", resolve));
    const resource = `http://127.0.0.1:${seller.address().port}/ping`;
    activate(ledger, now);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: REVIEWED, resource }],
    }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [item("cand-deliver-01", resource, REVIEWED, now)],
    }));
    const signerEnv = {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18788",
      FOUNDRY_MISSION_EXECUTE: "yes",
      MISSION_XRPL_ADDRESS: wallet.address,
      MISSION_XRPL_SEED: wallet.seed,
    };
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: childEnv(signerEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18788/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    const result = await runNode(["src/missions/worker.js", "--once"], childEnv({
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18788",
      MISSION_XRPL_ADDRESS: wallet.address,
    }));
    signer.kill("SIGTERM");
    await new Promise((resolve) => seller.close(resolve));
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.code, "unsupported_delivery", JSON.stringify(body));
    assert.equal(body.complete, false);
    assert.equal(proofs, 0);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.equal(mission.presigned_hash, undefined);
    assert.equal(mission.signed, false);
    assert.equal(mission.hold, "released");
    assert.equal(mission.complete, false);
  });

  it("releases a claim when the signer process refuses under CI and does not submit", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = new Date().toISOString();
    const wallet = xrpl.Wallet.generate();
    let proofs = 0;
    const seller = http.createServer((req, res) => {
      if (req.headers["payment-signature"]) proofs += 1;
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "5000", payTo: REVIEWED }],
      }));
    });
    await new Promise((resolve) => seller.listen(0, "127.0.0.1", resolve));
    const resource = `http://127.0.0.1:${seller.address().port}/ping`;
    activate(ledger, now);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: REVIEWED, resource }],
    }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [item("cand-ci-refuse-1", resource, REVIEWED, now)],
    }));
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18789",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: wallet.address,
        MISSION_XRPL_SEED: wallet.seed,
        CI: "true",
        GITHUB_ACTIONS: "true",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18789/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    const result = await runNode(["src/missions/worker.js", "--once"], Object.assign({}, process.env, {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18789",
      MISSION_XRPL_ADDRESS: wallet.address,
      CI: "true",
      GITHUB_ACTIONS: "true",
    }));
    signer.kill("SIGTERM");
    await new Promise((resolve) => seller.close(resolve));
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.complete, false, JSON.stringify(body));
    assert.equal(body.submitted, false);
    assert.equal(body.code, "unsupported_delivery");
    assert.equal(proofs, 0);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.equal(mission.status, "blocked");
    assert.equal(mission.hold, "released");
    assert.equal(mission.presigned_hash, undefined);
    assert.equal(mission.signed, false);
    assert.equal(view(ledger, now).live_spend_drops, "0");
    const desk = deskFold.fold(deskFold.readEvents(ledger), now);
    assert.equal(desk.live_spend_drops, "0");
    assert.equal(desk.uncertain_drops, "0");
  });

  it("signs the fresh open_ledger_fee inside the reserved ceiling", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const fees = ["10", "12"];
    let feeCalls = 0;
    fs.writeFileSync(path.join(home, "preload.js"), `
      const original = globalThis.fetch;
      const fees = ${JSON.stringify(fees)};
      let feeCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://testnet.xrpl-labs.com") {
          const body = JSON.parse(init.body);
          if (body.method === "server_info") {
            return new Response(JSON.stringify({ result: { info: { build_version: "3.4.1", network_id: 1, load_factor: 1 } } }), { status: 200 });
          }
          const open = fees[Math.min(feeCalls, fees.length - 1)];
          feeCalls += 1;
          return new Response(JSON.stringify({ result: { drops: { base_fee: "10", median_fee: "5000", minimum_fee: "10", open_ledger_fee: open }, levels: { reference_level: "256", open_ledger_level: "256" }, ledger_current_index: 22118406 } }), { status: 200 });
        }
        return original(url, init);
      };
    `);
    const now = new Date().toISOString();
    const wallet = xrpl.Wallet.generate();
    let proofs = 0;
    const seller = http.createServer((req, res) => {
      const header = req.headers["payment-signature"];
      if (!header) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "1737", payTo: REVIEWED }],
        }));
        return;
      }
      proofs += 1;
      const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      if (payload.accepted.amount !== "1737") {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ping" }));
    });
    await new Promise((resolve) => seller.listen(0, "127.0.0.1", resolve));
    const resource = `http://127.0.0.1:${seller.address().port}/ping`;
    activate(ledger, now);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: REVIEWED, resource }],
    }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [item("cand-fee-headroom", resource, REVIEWED, now, "1737")],
    }));
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: childEnv({
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18790",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: wallet.address,
        MISSION_XRPL_SEED: wallet.seed,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18790/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    const result = await runNode(["src/missions/worker.js", "--once"], childEnv({
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18790",
      MISSION_XRPL_ADDRESS: wallet.address,
      NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
    }));
    signer.kill("SIGTERM");
    await new Promise((resolve) => seller.close(resolve));
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.code, "unsupported_delivery", JSON.stringify(body));
    assert.equal(body.complete, false);
    assert.equal(proofs, 0);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.equal(mission.budget.payment_drops, "1737");
    assert.equal(mission.budget.network_fee_drops, "12");
    assert.equal(mission.presigned_hash, undefined);
    assert.equal(mission.complete, false);
    const events = deskFold.readEvents(ledger);
    const reserved = events.find((event) => event.type === "budget.reserved" && event.mission_id === mission.id);
    const narrowed = events.find((event) => event.type === "budget.fee_narrowed" && event.mission_id === mission.id);
    assert.equal(reserved.budget_drops, "2747");
    assert.equal(narrowed.drops, "998");
    assert.equal(narrowed.from, "1010");
    assert.equal(narrowed.to, "12");
    const desk = deskFold.fold(events, now);
    assert.equal(desk.live_spend_drops, "0");
    assert.equal(desk.accounted_spent_drops, "0");
  });

  it("releases the hold when the fresh open_ledger_fee exceeds the ceiling", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "preload.js"), `
      const original = globalThis.fetch;
      let feeCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://testnet.xrpl-labs.com") {
          const body = JSON.parse(init.body);
          if (body.method === "server_info") {
            return new Response(JSON.stringify({ result: { info: { network_id: 1, load_factor: 1 } } }), { status: 200 });
          }
          feeCalls += 1;
          const open = feeCalls === 1 ? "10" : "5000";
          return new Response(JSON.stringify({ result: { drops: { base_fee: "10", median_fee: "5000", minimum_fee: "10", open_ledger_fee: open }, ledger_current_index: 22118406 } }), { status: 200 });
        }
        return original(url, init);
      };
    `);
    const now = new Date().toISOString();
    const resource = "https://shop.test/reviewed";
    activate(ledger, now);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: REVIEWED, resource }],
    }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [item("cand-fee-ceiling", resource, REVIEWED, now, "1737")],
    }));
    const result = await runNode(["src/missions/worker.js", "--once"], childEnv({
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "yes",
      MISSION_XRPL_ADDRESS: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ",
      NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
    }));
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.code, "FEE_CAP", JSON.stringify(body));
    assert.equal(body.complete, false);
    assert.equal(body.submitted, false);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.equal(mission.hold, "released");
    assert.equal(mission.presigned_hash, undefined);
    assert.equal(mission.signed, false);
    assert.equal(view(ledger, now).live_spend_drops, "0");
    const reserved = deskFold.readEvents(ledger).find((event) => event.type === "budget.reserved");
    assert.equal(reserved.budget_drops, "2747");
    assert.equal(reserved.components.network_fee_drops, "1010");
  });

  it("keeps the presigned hold when the seller body is not a usable 200 and does not submit", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const proofFile = path.join(home, "proofs.txt");
    fs.writeFileSync(proofFile, "");
    fs.writeFileSync(path.join(home, "preload.js"), `
      const fs = require("fs");
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        if (target === "https://testnet.xrpl-labs.com") {
          const body = JSON.parse(init.body);
          if (body.method === "server_info") {
            return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: 22118869 } } } }), { status: 200 });
          }
          if (body.method === "account_info") {
            return new Response(JSON.stringify({ result: { account_data: { Sequence: 22117391 } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ result: { drops: { base_fee: "10", median_fee: "5000", minimum_fee: "10", open_ledger_fee: "10" }, ledger_current_index: 22118869 } }), { status: 200 });
        }
        if (target.startsWith("https://api.stablecoingateways.com/v1/sanctions/address")) {
          const header = init && init.headers && (init.headers["PAYMENT-SIGNATURE"] || init.headers["payment-signature"]);
          if (!header) {
            return new Response(JSON.stringify({
              x402Version: 2,
              accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "1737", payTo: ${JSON.stringify(REVIEWED)}, maxTimeoutSeconds: 300, extra: { invoiceId: "inv-1", sourceTag: 26100014 } }],
            }), { status: 402, headers: { "content-type": "application/json" } });
          }
          fs.appendFileSync(process.env.PROOF_FILE, "1\\n");
          return new Response(JSON.stringify({ error: "unrecognized" }), { status: 402, headers: { "content-type": "application/json" } });
        }
        return original(url, init);
      };
    `);
    const now = new Date().toISOString();
    const wallet = xrpl.Wallet.generate();
    const resource = "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
    activate(ledger, now);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({
      payees: [{ address: REVIEWED, resource }],
    }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [item("cand-deliver-fail", resource, REVIEWED, now, "1737")],
    }));
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: childEnv({
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18791",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: wallet.address,
        MISSION_XRPL_SEED: wallet.seed,
        PROOF_FILE: proofFile,
        NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18791/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    const result = await runNode(["src/missions/worker.js", "--once"], childEnv({
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18791",
      MISSION_XRPL_ADDRESS: wallet.address,
      PROOF_FILE: proofFile,
      NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
    }));
    signer.kill("SIGTERM");
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.code, "delivery_failed", JSON.stringify(body));
    assert.equal(body.http_status, 402);
    assert.equal(body.submitted, false);
    assert.equal(body.complete, false);
    assert.equal(fs.readFileSync(proofFile, "utf8").trim().split("\n").filter(Boolean).length, 1);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.equal(mission.status, "uncertain");
    assert.equal(mission.hold, "uncertain");
    assert.equal(mission.retry_blocked, true);
    assert.equal(mission.signed, true);
    assert.equal(mission.presigned, true);
    assert.equal(mission.submitted, false);
    assert.equal(mission.sequence, 22117391);
    assert.equal(mission.last_ledger_sequence, 22118889);
    const stored = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(stored.includes("tx_blob"), false);
    assert.equal(stored.includes("TxnSignature"), false);
    assert.match(mission.presigned_hash, /^[0-9A-F]{64}$/);
    assert.equal(mission.delivery_http_status, 402);
    assert.throws(
      () => retryPreSignFee(ledger, {
        token: TOKEN,
        confirm: config.FEE_RETRY_PHRASE,
        idempotency_key: "cand-deliver-fail",
        now,
      }, { token: TOKEN }),
      (error) => error.code === "NO_RETRY",
    );
  });
});

describe("resource allowlist and fee retry", () => {
  it("rejects the reviewed seller at a different resource and keeps the old fee block", () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = new Date().toISOString();
    const resource = "https://shop.test/reviewed";
    activate(ledger, now);
    const denied = startMission(ledger, {
      idempotency_key: "scope-check-1",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "5000",
      network_fee_drops: "10",
      resource_url: "https://shop.test/other",
    }, { allowlist: { payees: [{ address: REVIEWED, resource }] } });
    assert.equal(denied.mission.code, "payee_not_allowlisted");
    const blocked = blockMission(ledger, {
      idempotency_key: "cand-17-51ec932c8e",
      now,
      code: "FEE",
      rationale: "The XRPL Labs network fee could not be used. A merchant fee was not invented.",
    });
    fs.writeFileSync(path.join(ledger, "worker-state.json"), JSON.stringify({
      schema: "aether.missions.worker-state",
      consumed: { "cand-17-51ec932c8e": { at: now, reason: "FEE" } },
      ticks: 1,
    }));
    const audit = retryPreSignFee(ledger, {
      token: TOKEN,
      confirm: config.FEE_RETRY_PHRASE,
      idempotency_key: "cand-17-51ec932c8e",
      now,
    }, { token: TOKEN });
    assert.deepEqual(audit.retried, ["cand-17-51ec932c8e"]);
    assert.equal(audit.submitted, false);
    assert.equal(view(ledger, now).missions[blocked.mission.id].code, "FEE");
    const consumed = JSON.parse(fs.readFileSync(path.join(ledger, "worker-state.json"), "utf8")).consumed;
    assert.equal(consumed["cand-17-51ec932c8e"], undefined);
    const successor = startMission(ledger, {
      idempotency_key: "cand-17-51ec932c8e",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "5000",
      network_fee_drops: "10",
      resource_url: resource,
    }, { allowlist: { payees: [{ address: REVIEWED, resource }] } });
    assert.equal(successor.replay, false);
    assert.equal(successor.mission.retry_of, "cand-17-51ec932c8e");
    assert.notEqual(successor.mission.id, blocked.mission.id);
    assert.equal(view(ledger, now).missions[blocked.mission.id].status, "blocked");
    const other = blockMission(ledger, {
      idempotency_key: "cand-01-feeblock",
      now,
      code: "FEE",
      rationale: "The XRPL Labs network fee could not be used. A merchant fee was not invented.",
    });
    fs.writeFileSync(path.join(ledger, "worker-state.json"), JSON.stringify({
      schema: "aether.missions.worker-state",
      consumed: {
        "cand-01-feeblock": { at: now, reason: "FEE" },
        "cand-02-feeblock": { at: now, reason: "FEE" },
      },
      ticks: 2,
    }));
    blockMission(ledger, {
      idempotency_key: "cand-02-feeblock",
      now,
      code: "FEE",
      rationale: "The XRPL Labs network fee could not be used. A merchant fee was not invented.",
    });
    assert.throws(
      () => retryPreSignFee(ledger, { token: TOKEN, confirm: config.FEE_RETRY_PHRASE, now }, { token: TOKEN }),
      (error) => error.code === "IDEMPOTENCY",
    );
    const named = retryPreSignFee(ledger, {
      token: TOKEN,
      confirm: config.FEE_RETRY_PHRASE,
      idempotency_key: "cand-01-feeblock",
      now,
    }, { token: TOKEN });
    assert.deepEqual(named.retried, ["cand-01-feeblock"]);
    const left = JSON.parse(fs.readFileSync(path.join(ledger, "worker-state.json"), "utf8")).consumed;
    assert.equal(left["cand-01-feeblock"], undefined);
    assert.ok(left["cand-02-feeblock"]);
    assert.equal(view(ledger, now).missions[other.mission.id].code, "FEE");
    const replay = startMission(ledger, {
      idempotency_key: "cand-17-51ec932c8e",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "5000",
      network_fee_drops: "10",
      resource_url: resource,
    }, { allowlist: { payees: [{ address: REVIEWED, resource }] } });
    assert.equal(replay.replay, true);
    const capped = releasePrepared(ledger, {
      mission_id: successor.mission.id,
      now,
      code: "FEE_CAP",
      rationale: "A fresh XRPL Labs fee is above the reserved network fee. Nothing was signed.",
    });
    assert.equal(capped.mission.code, "FEE_CAP");
    assert.equal(capped.mission.presigned_hash, undefined);
    retryPreSignFee(ledger, {
      token: TOKEN,
      confirm: config.FEE_RETRY_PHRASE,
      idempotency_key: "cand-17-51ec932c8e",
      now,
    }, { token: TOKEN });
    const second = startMission(ledger, {
      idempotency_key: "cand-17-51ec932c8e",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1737",
      network_fee_drops: "12",
      resource_url: resource,
    }, { allowlist: { payees: [{ address: REVIEWED, resource }] } });
    assert.equal(second.replay, false);
    assert.equal(second.mission.idempotency_key, "cand-17-51ec932c8e-fee-retry-2");
    assert.equal(second.mission.retry_of, "cand-17-51ec932c8e");
    assert.equal(view(ledger, now).missions[successor.mission.id].status, "blocked");
  });

  it("refuses to release a claim after a presign hash exists", () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T18:00:00.000Z";
    activate(ledger, now);
    const started = startMission(ledger, {
      idempotency_key: "presign-hold-1",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "5000",
      network_fee_drops: "10",
      resource_url: "https://shop.test/reviewed",
    }, { allowlist: { payees: [REVIEWED] } });
    const { act } = require("./engine");
    const ready = act(ledger, { mission_id: started.mission.id, now }, {
      wallet: { address: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ" },
    }).mission;
    beginSubmit(ledger, { mission_id: ready.id, now });
    notePresign(ledger, ready.id, "AB".repeat(32));
    assert.throws(
      () => releaseUnsignedClaim(ledger, { mission_id: ready.id, now, code: "CI" }),
      (error) => error.code === "NO_RETRY",
    );
    assert.equal(view(ledger, now).missions[ready.id].hold, "uncertain");
    assert.equal(view(ledger, now).missions[ready.id].retry_blocked, true);
  });

  it("does not open a successor from a blanket grant or after an empty successor", () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T18:00:00.000Z";
    activate(ledger, now);
    blockMission(ledger, {
      idempotency_key: "cand-10-empty01",
      now,
      code: "FEE",
      rationale: "The XRPL Labs network fee could not be used. A merchant fee was not invented.",
    });
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "control.retry_fee",
      at: now,
      idempotency_key: "cand-10-empty01",
      live: false,
      signed: false,
      submitted: false,
    })}\n`);
    const ignored = startMission(ledger, {
      idempotency_key: "cand-10-empty01",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [] },
    });
    assert.equal(ignored.replay, true);
    assert.equal(ignored.mission.code, "FEE");
    retryPreSignFee(ledger, {
      token: TOKEN,
      confirm: config.FEE_RETRY_PHRASE,
      idempotency_key: "cand-10-empty01",
      now,
    }, { token: TOKEN });
    const empty = startMission(ledger, {
      idempotency_key: "cand-10-empty01",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [] },
    });
    assert.equal(empty.mission.retry_of, "cand-10-empty01");
    assert.equal(empty.mission.idempotency_key, "cand-10-empty01-fee-retry-1");
    assert.equal(empty.mission.code, "no_foreign_seller");
    assert.throws(
      () => retryPreSignFee(ledger, {
        token: TOKEN,
        confirm: config.FEE_RETRY_PHRASE,
        idempotency_key: "cand-10-empty01",
        now,
      }, { token: TOKEN }),
      (error) => error.code === "NO_RETRY",
    );
  });

  it("keeps a presigned claim after the wall-clock expiry", () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T19:12:16.314Z";
    activate(ledger, now);
    const started = startMission(ledger, {
      idempotency_key: "presign-expiry-1",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1737",
      network_fee_drops: "10",
      resource_url: "https://shop.test/reviewed",
    }, { allowlist: { payees: [REVIEWED] } });
    const { act } = require("./engine");
    const ready = act(ledger, { mission_id: started.mission.id, now }, {
      wallet: { address: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ" },
    }).mission;
    beginSubmit(ledger, { mission_id: ready.id, now });
    notePresign(ledger, ready.id, "AB".repeat(32));
    const later = "2026-11-06T19:42:16.315Z";
    startMission(ledger, {
      idempotency_key: "other-window-1",
      now: later,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "10",
      network_fee_drops: "10",
      resource_url: "https://shop.test/reviewed",
    }, { allowlist: { payees: [REVIEWED] } });
    const held = view(ledger, later).missions[ready.id];
    assert.equal(held.hold, "uncertain");
    assert.equal(held.presigned_hash, "AB".repeat(32));
    assert.equal(held.retry_blocked, true);
    assert.equal(signedClaimMayRelease({ lastLedgerSequence: null, validatedLedgerIndex: 99999999, hashFound: false }), false);
    assert.equal(signedClaimMayRelease({ lastLedgerSequence: 100, validatedLedgerIndex: 100, hashFound: false }), false);
    assert.equal(signedClaimMayRelease({ lastLedgerSequence: 100, validatedLedgerIndex: 101, hashFound: true }), false);
    assert.equal(signedClaimMayRelease({ lastLedgerSequence: 100, validatedLedgerIndex: 101, hashFound: false }), true);
    const kept = releasePassedWindow(ledger, {
      mission_id: ready.id,
      now: later,
      validatedLedger: 99999999,
      hashFound: false,
    });
    assert.equal(kept.released, false);
    assert.equal(kept.reason, "no_last_ledger_sequence");
    assert.equal(view(ledger, later).missions[ready.id].hold, "uncertain");
    assert.equal(view(ledger, later).missions[ready.id].complete, false);
  });
});

describe("generated wallet sequence encoding", () => {
  it("does not encode an omitted Sequence as zero", () => {
    const wallet = xrpl.Wallet.generate();
    const base = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: REVIEWED,
      Amount: "1737",
      Fee: "10",
      NetworkID: 1,
    };
    const omitted = wallet.sign(base);
    const zero = wallet.sign(Object.assign({}, base, { Sequence: 0 }));
    const decoded = xrpl.decode(omitted.tx_blob);
    assert.equal(Object.prototype.hasOwnProperty.call(decoded, "Sequence"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(decoded, "LastLedgerSequence"), false);
    assert.notEqual(omitted.tx_blob, zero.tx_blob);
    assert.equal(xrpl.decode(zero.tx_blob).Sequence, 0);
    assert.equal(omitted.tx_blob.includes(wallet.seed), false);
  });
});

describe("real signer sequence and last ledger bounds", () => {
  it("rejects a missing or unbounded window and leaves an old claim open", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T19:12:16.314Z";
    activate(ledger, now);
    const wallet = xrpl.Wallet.generate();
    const old = startMission(ledger, {
      idempotency_key: "old-claim-open1",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1737",
      network_fee_drops: "10",
      resource_url: "https://shop.test/reviewed",
    }, { allowlist: { payees: [REVIEWED] } });
    const { act } = require("./engine");
    const oldReady = act(ledger, { mission_id: old.mission.id, now }, { wallet: { address: wallet.address } }).mission;
    beginSubmit(ledger, { mission_id: oldReady.id, now });
    notePresign(ledger, oldReady.id, "CD".repeat(32));
    const fresh = startMission(ledger, {
      idempotency_key: "future-sign-01",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1737",
      network_fee_drops: "10",
      resource_url: "https://shop.test/reviewed",
    }, { allowlist: { payees: [REVIEWED] } });
    const freshReady = act(ledger, { mission_id: fresh.mission.id, now }, { wallet: { address: wallet.address } }).mission;
    beginSubmit(ledger, { mission_id: freshReady.id, now });
    fs.writeFileSync(path.join(home, "preload.js"), `
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "server_info") {
          return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: 22118869 } } } }), { status: 200 });
        }
        if (body.method === "account_info") {
          return new Response(JSON.stringify({ result: { account_data: { Sequence: 22117391 } } }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: { error: "txnNotFound" } }), { status: 200 });
      };
    `);
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: childEnv({
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18792",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: wallet.address,
        MISSION_XRPL_SEED: wallet.seed,
        NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18792/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    async function post(tx) {
      const res = await fetch("http://127.0.0.1:18792/sign", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          intent: "mission_spend",
          execute: true,
          presign: true,
          dry_run: false,
          mission_id: freshReady.id,
          tx,
        }),
      });
      return { status: res.status, body: await res.json() };
    }
    const payment = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: REVIEWED,
      Amount: "1737",
      Fee: "10",
      NetworkID: 1,
    };
    const missing = await post(payment);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "TX");
    const zero = await post(Object.assign({}, payment, { Sequence: 0, LastLedgerSequence: 22118889 }));
    assert.equal(zero.status, 400);
    const far = await post(Object.assign({}, payment, { Sequence: 22117391, LastLedgerSequence: 22118869 + 1000 }));
    assert.equal(far.status, 400);
    assert.equal(far.body.code, "LEDGER");
    const badFee = await post(Object.assign({}, payment, { Sequence: 22117391, LastLedgerSequence: 22118889, Fee: "10.5" }));
    assert.equal(badFee.status, 400);
    const ok = await post(Object.assign({}, payment, { Sequence: 22117391, LastLedgerSequence: 22118889 }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.hash, /^[0-9A-F]{64}$/);
    signer.kill("SIGTERM");
    const prior = view(ledger, now).missions[oldReady.id];
    assert.equal(prior.hold, "uncertain");
    assert.equal(prior.presigned_hash, "CD".repeat(32));
    assert.equal(prior.last_ledger_sequence, undefined);
    assert.equal(prior.complete, false);
    const saved = view(ledger, now).missions[freshReady.id];
    assert.equal(saved.presigned, true);
    assert.equal(saved.signed, true);
    assert.equal(saved.submitted, false);
    assert.equal(saved.sequence, 22117391);
    assert.equal(saved.last_ledger_sequence, 22118889);
    assert.equal(saved.complete, false);
    const text = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(text.includes("tx_blob"), false);
    assert.equal(text.includes(ok.body.tx_blob), false);
  });
});
