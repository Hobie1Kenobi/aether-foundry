"use strict";

/**
 * The executable entrypoints, with the ledger socket replaced by a loopback
 * stand-in. This is not a Testnet submission.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("../missions/config");
const { control, view } = require("../missions/engine");
const { writePrivateAccount, writeHandover } = require("./account-file");
const { startSeller } = require("./controlled-seller");
const { PHRASE, PERMANENT_HOLD } = require("./controlled-purchase");

const ROOT = path.resolve(__dirname, "..", "..");
const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const DIAG_TOKEN = "diagnostic-token-32-characters-min";

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: Object.assign({}, process.env, env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

describe("diagnostic command entrypoints", () => {
  it("rejects the worker port, checks a private account file, and previews without an attempt", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-"));
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const mission = {
      id: "msn5b5c3223e5e88526",
      status: "uncertain",
      hold: "unsubmitted",
      budget: { budget_drops: "1747", payment_drops: "1737", network_fee_drops: "10" },
      day: "2026-11-06",
      retry_blocked: true,
      signed: true,
      seller: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs",
      claim: { account: "rLegacySequenceHoldAccount1", amount: "1737", fee: "10" },
      updated_at: NOW,
    };
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
      JSON.stringify({ type: "mission.upsert", at: NOW, mission }),
      JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: mission.id, day: "2026-11-06", budget_drops: "1747", components: mission.budget }),
      JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: mission.id, day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
    ].join("\n")}\n`);
    const payee = xrpl.Wallet.generate().address;
    const blocked = await runNode(["src/diagnostics/controlled-seller.js"], {
      FOUNDRY_DIAGNOSTIC_PORT: "8794",
      FOUNDRY_DIAGNOSTIC_PAYEE: payee,
    });
    assert.equal(blocked.status, 1);
    assert.equal(blocked.stderr.trim(), "BIND");
    const payer = xrpl.Wallet.generate();
    const account = path.join(home, "buyer.json");
    writePrivateAccount(account, payer);
    const checked = await runNode(["src/diagnostics/account-file.js", account], {});
    assert.equal(checked.status, 0);
    assert.equal(checked.stdout.includes(payer.seed), false);
    assert.deepEqual(JSON.parse(checked.stdout), { address: payer.address });
    const preview = await runNode(["src/diagnostics/controlled-purchase.js"], {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_DIAGNOSTIC_PHRASE: PHRASE,
      FOUNDRY_DIAGNOSTIC_TOKEN: DIAG_TOKEN,
      FOUNDRY_DIAGNOSTIC_SELLER: "http://127.0.0.1:8795/paid",
      FOUNDRY_DIAGNOSTIC_PAYEE: payee,
    });
    assert.equal(preview.status, 0);
    const report = JSON.parse(preview.stdout);
    assert.equal(report.live, false);
    assert.equal(report.attempt_consumed, false);
    assert.equal(report.daily_used, "1747");
    assert.equal(preview.stdout.includes(payer.seed), false);
    assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), false);
    assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), false);
  });

  it("runs the live command against a simulated ledger socket and the loopback seller", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-live-"));
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const mission = {
      id: "msn5b5c3223e5e88526",
      status: "uncertain",
      hold: "unsubmitted",
      signed: true,
      seller: "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs",
      claim: { account: "rLegacySequenceHoldAccount1" },
      updated_at: NOW,
    };
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${[
      JSON.stringify({ type: "mission.upsert", at: NOW, mission }),
      JSON.stringify({ type: "budget.reserved", at: NOW, mission_id: mission.id, day: "2026-11-06", budget_drops: "1747", components: { budget_drops: "1747", payment_drops: "1737", network_fee_drops: "10" } }),
      JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: mission.id, day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
    ].join("\n")}\n`);
    const payer = xrpl.Wallet.generate();
    const payeeWallet = xrpl.Wallet.generate();
    const account = path.join(home, "buyer.json");
    const handover = path.join(home, "handover.json");
    writePrivateAccount(account, payer);
    writeHandover(handover, { buyer: payer.address, seller: payeeWallet.address });
    let settles = 0;
    const seller = await startSeller({
      payTo: payeeWallet.address,
      boundary: "simulated",
      scheme: {
        verify: async () => ({ isValid: true, payer: payer.address }),
        settle: async (payload) => {
          settles += 1;
          return { success: true, transaction: xrpl.hashes.hashSignedTx(payload.payload.signedTxBlob), payer: payer.address };
        },
      },
    });
    const rpc = await listen(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const params = (body.params && body.params[0]) || {};
      let result = { error: "unknown" };
      if (body.method === "server_info") result = { info: { network_id: 1, validated_ledger: { seq: 10000 } } };
      if (body.method === "account_info") {
        result = { validated: true, account_data: { Account: params.account, Sequence: 11, Balance: "20000000" } };
      }
      if (body.method === "tx") {
        result = { validated: true, hash: params.transaction, Destination: payeeWallet.address, Amount: "10", meta: { TransactionResult: "tesSUCCESS" } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
    try {
      const shared = {
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_DIAGNOSTIC_PHRASE: PHRASE,
        FOUNDRY_DIAGNOSTIC_TOKEN: DIAG_TOKEN,
        FOUNDRY_DIAGNOSTIC_SELLER: seller.url,
        FOUNDRY_DIAGNOSTIC_PAYEE: payeeWallet.address,
        FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE: account,
        FOUNDRY_DIAGNOSTIC_HANDOVER: handover,
        FOUNDRY_DIAGNOSTIC_LIVE: "yes",
        FOUNDRY_DIAGNOSTIC_SIMULATE: "yes",
        FOUNDRY_DIAGNOSTIC_SIM_RPC: rpc.url,
      };
      const done = await runNode(["src/diagnostics/controlled-purchase.js"], shared);
      assert.equal(done.status, 0, done.stderr);
      const report = JSON.parse(done.stdout);
      assert.equal(report.simulated, true);
      assert.equal(report.network_boundary, "simulated");
      assert.equal(report.settled, true);
      assert.equal(report.ledger_proof, "validated");
      assert.equal(report.vendor_signed, false);
      assert.equal(done.stdout.includes(payer.seed), false);
      assert.equal(settles, 1);
      const state = view(ledger, NOW);
      assert.equal(state.missions[report.mission_id].hold, "spent");
      assert.equal(state.missions[PERMANENT_HOLD].hold, "uncertain");
      assert.equal(state.days["2026-11-06"].uncertain, "1747");
      const again = await runNode(["src/diagnostics/controlled-purchase.js"], shared);
      assert.equal(again.status, 1);
      assert.equal(again.stderr.trim(), "NO_RETRY");
      assert.equal(settles, 1);
    } finally {
      await seller.close();
      await rpc.close();
    }
  });
});
