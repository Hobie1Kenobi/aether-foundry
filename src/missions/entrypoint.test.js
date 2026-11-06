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
const { control, view, blockMission, startMission } = require("./engine");
const { retryPreSignFee } = require("./retry-fee");

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

function item(id, resource, payTo, now) {
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
        amount: "5000",
        payTo,
        maxTimeoutSeconds: 300,
        fee_drops: "999999",
      }],
    },
  };
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: Object.assign({}, process.env, env),
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
    const result = await runNode(["src/missions/worker.js", "--once"], {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "",
      MISSION_XRPL_ADDRESS: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ",
    });
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
      const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      assert.equal(payload.x402Version, 2);
      assert.equal(payload.accepted.payTo, REVIEWED);
      assert.equal(payload.accepted.amount, "5000");
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
      env: Object.assign({}, process.env, signerEnv),
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
    const result = await runNode(["src/missions/worker.js", "--once"], {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_WORKER: "yes",
      FOUNDRY_MISSION_EXECUTE: "yes",
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18788",
      MISSION_XRPL_ADDRESS: wallet.address,
    });
    signer.kill("SIGTERM");
    await new Promise((resolve) => seller.close(resolve));
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.complete, true);
    assert.equal(body.code, null);
    const mission = view(ledger, now).missions[body.mission_id];
    assert.equal(mission.artifact.seller, REVIEWED);
    assert.equal(mission.budget.payment_drops, "5000");
    assert.notEqual(mission.budget.network_fee_drops, "999999");
    assert.equal(mission.resource_url, resource);
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
  });
});
