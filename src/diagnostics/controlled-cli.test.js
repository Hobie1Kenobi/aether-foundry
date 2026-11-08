"use strict";

/**
 * Shipped command entrypoints. They do not accept a simulated ledger.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("../missions/config");
const { control } = require("../missions/engine");
const { writePrivateAccount, inspectAccount } = require("./account-file");
const { PHRASE } = require("./controlled-purchase");

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

  it("ignores a simulate switch and does not replace an existing account file", async () => {
    const source = fs.readFileSync(path.join(ROOT, "src/diagnostics/controlled-purchase.js"), "utf8");
    assert.equal(source.includes("FOUNDRY_DIAGNOSTIC_SIMULATE"), false);
    assert.equal(source.includes("FOUNDRY_DIAGNOSTIC_SIM_RPC"), false);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-sim-"));
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const refused = await runNode(["src/diagnostics/controlled-purchase.js"], {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_DIAGNOSTIC_PHRASE: PHRASE,
      FOUNDRY_DIAGNOSTIC_TOKEN: DIAG_TOKEN,
      FOUNDRY_DIAGNOSTIC_SELLER: "http://127.0.0.1:8795/paid",
      FOUNDRY_DIAGNOSTIC_PAYEE: xrpl.Wallet.generate().address,
      FOUNDRY_DIAGNOSTIC_LIVE: "yes",
      FOUNDRY_DIAGNOSTIC_SIMULATE: "yes",
      FOUNDRY_DIAGNOSTIC_SIM_RPC: "http://127.0.0.1:9",
    });
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr.trim(), "CAP");
    assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-account-"));
    const wallet = xrpl.Wallet.generate();
    const existing = path.join(dir, "buyer.json");
    fs.writeFileSync(existing, "keep-me", { mode: 0o600 });
    assert.throws(() => writePrivateAccount(existing, wallet), (error) => error.code === "AUTH");
    assert.equal(fs.readFileSync(existing, "utf8"), "keep-me");
    const target = path.join(dir, "target.json");
    fs.writeFileSync(target, "target-keep", { mode: 0o600 });
    const link = path.join(dir, "link.json");
    fs.symlinkSync(target, link);
    assert.throws(() => writePrivateAccount(link, wallet), (error) => error.code === "AUTH");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), "target-keep");
    assert.throws(() => inspectAccount(link), (error) => error.code === "AUTH");
    assert.equal(fs.readFileSync(target, "utf8"), "target-keep");
  });
});
