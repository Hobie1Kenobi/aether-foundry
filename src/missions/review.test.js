"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");
const xrpl = require("xrpl");
const config = require("./config");
const { control, view, startMission, act } = require("./engine");
const { beginSubmit, notePresign, stampPrepared, narrowUnsubmittedFee, releasePassedWindow } = require("./submit");
const { tick } = require("./worker");
const ledgerWindow = require("./ledger-window");
const serviceResult = require("./service-result");
const policy = require("./policy");

const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const ROOT = path.resolve(__dirname, "..", "..");
const FX = "https://api.stablecoingateways.com/v1/fx/convert?from=USD&to=EUR&amount=1";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-review-"));
}

function activate(ledger, now) {
  control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now }, { token: TOKEN });
}

describe("exact resource result", () => {
  it("rejects host suffixes, path prefixes, and an empty data object", () => {
    assert.equal(serviceResult.supportsResource("https://api.stablecoingateways.com.evil/v1/fx/convert"), false);
    assert.equal(serviceResult.supportsResource("https://evil.api.stablecoingateways.com/v1/fx/convert"), false);
    assert.equal(serviceResult.supportsResource("https://api.stablecoingateways.com/v1/fx"), false);
    assert.equal(serviceResult.supportsResource("https://api.stablecoingateways.com/v1/fx/convert/extra"), false);
    assert.equal(serviceResult.supportsResource(FX), true);
    const empty = serviceResult.validatePurchasedService(FX, 200, { data: {} });
    assert.equal(empty.useful, false);
    assert.equal(empty.code, "incomplete_result");
    const useful = serviceResult.validatePurchasedService(FX, 200, {
      data: { from: "USD", amount: 1, rate_date: "2026-11-06", conversions: { EUR: {} } },
    });
    assert.equal(useful.useful, true);
  });
});

describe("validated reads", () => {
  it("rejects the wrong network, an unvalidated account, and a dead RPC", async () => {
    await assert.rejects(
      () => ledgerWindow.readValidatedAccount(async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "server_info") {
          return { ok: true, json: async () => ({ result: { info: { network_id: 0, validated_ledger: { seq: 10 } } } }) };
        }
        return { ok: true, json: async () => ({}) };
      }, REVIEWED),
      (error) => error.code === "MAINNET"
    );
    await assert.rejects(
      () => ledgerWindow.readValidatedAccount(async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "server_info") {
          return { ok: true, json: async () => ({ result: { info: { network_id: 1, validated_ledger: { seq: 22118869 } } } }) };
        }
        return { ok: true, json: async () => ({ result: { validated: false, account_data: { Sequence: 22117391 } } }) };
      }, REVIEWED),
      (error) => error.code === "LEDGER"
    );
    await assert.rejects(
      () => ledgerWindow.readValidatedAccount(async () => { throw new Error("down"); }, REVIEWED),
      (error) => error.code === "LEDGER"
    );
  });

  it("rejects a rolled-back validated ledger against a stored window", () => {
    assert.throws(
      () => ledgerWindow.assertPrepared({
        TransactionType: "Payment",
        Account: REVIEWED,
        Destination: REVIEWED,
        Amount: "1737",
        Fee: "10",
        NetworkID: 1,
        Sequence: 22117391,
        LastLedgerSequence: 22118889,
      }, { validated: 22118800, sequence: 22117391 }),
      (error) => error.code === "LEDGER"
    );
  });
});

describe("old hold and fee narrow", () => {
  it("keeps the 1747 uncertain hold in the cap and narrows a later fee in one fold", () => {
    const ledger = path.join(tmp(), "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T19:12:16.314Z";
    activate(ledger, now);
    const old = startMission(ledger, {
      idempotency_key: "old-hold-1747",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1737",
      network_fee_drops: "10",
      resource_url: "https://shop.test/old",
    }, { allowlist: { payees: [REVIEWED] } });
    const ready = act(ledger, { mission_id: old.mission.id, now }, {
      wallet: { address: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ" },
    }).mission;
    beginSubmit(ledger, { mission_id: ready.id, now });
    notePresign(ledger, ready.id, "AB".repeat(32));
    assert.equal(policy.dayUsed(view(ledger, now), "2026-11-06"), 1747n);
    const blocked = startMission(ledger, {
      idempotency_key: "cap-would-pass",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "4982534",
      network_fee_drops: "0",
      resource_url: "https://shop.test/old",
    }, { allowlist: { payees: [REVIEWED] } });
    assert.equal(blocked.mission.code, "CAP");
    const opened = startMission(ledger, {
      idempotency_key: "narrow-later-1",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1000",
      network_fee_drops: "1010",
      resource_url: "https://shop.test/old",
    }, { allowlist: { payees: [REVIEWED] } });
    const next = act(ledger, { mission_id: opened.mission.id, now }, {
      wallet: { address: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ" },
    });
    const narrowed = narrowUnsubmittedFee(ledger, {
      mission_id: next.mission.id,
      now,
      fee_drops: "12",
    }).mission;
    assert.equal(narrowed.budget.network_fee_drops, "12");
    assert.equal(narrowed.budget.budget_drops, "1012");
    assert.equal(view(ledger, now).missions[next.mission.id].unsigned_tx.Fee, "12");
    const state = view(ledger, now);
    assert.equal(state.missions[ready.id].hold, "uncertain");
    assert.equal(state.missions[ready.id].last_ledger_sequence, undefined);
    assert.equal(state.missions[ready.id].complete, false);
    assert.equal(policy.dayUsed(state, "2026-11-06") >= 1747n, true);
    stampPrepared(ledger, { mission_id: next.mission.id, now, sequence: 22117391, lastLedgerSequence: 22118889 });
    assert.throws(
      () => stampPrepared(ledger, { mission_id: next.mission.id, now, sequence: 22117392, lastLedgerSequence: 22118909 }),
      (error) => error.code === "NO_RETRY"
    );
    assert.equal(view(ledger, now).missions[next.mission.id].last_ledger_sequence, 22118889);
    const kept = releasePassedWindow(ledger, {
      mission_id: ready.id,
      now,
      validatedLedger: 99999999,
      hashFound: false,
    });
    assert.equal(kept.released, false);
  });
});

describe("worker does not sign unsupported or unpersisted proofs", () => {
  it("does not transmit when the signer did not store the hash", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T19:00:00.000Z";
    activate(ledger, now);
    let proofs = 0;
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({ payees: [REVIEWED] }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [{
        id: "cand-no-persist",
        observed_at: now,
        resource: { url: FX, method: "GET" },
        x402: {
          x402Version: 2,
          resource: FX,
          accepts: [{
            scheme: "exact",
            network: "xrpl:1",
            asset: "XRP",
            amount: "1737",
            payTo: REVIEWED,
            maxTimeoutSeconds: 300,
          }],
        },
      }],
    }));
    const body = await tick({
      env: {
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_WORKER: "yes",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ",
      },
      now,
      quoteFee: async () => ({ fee_drops: "10", quoted_at: now, source: "https://testnet.xrpl-labs.com" }),
      preparedAccount: { validated: 22118869, sequence: 22117391 },
      resourceFetch: async () => {
        proofs += 1;
        return { status: 402, json: async () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:1", amount: "1737", payTo: REVIEWED }] }) };
      },
      presign: async () => ({ tx_blob: "BLOB", hash: "AB".repeat(32) }),
    });
    assert.equal(body.code, "persistence_missing");
    assert.equal(body.complete, false);
    assert.equal(proofs, 1);
    const mission = Object.values(view(ledger, now).missions).find((item) => item.idempotency_key === "cand-no-persist");
    assert.equal(mission.hold, "uncertain");
    assert.equal(mission.presigned_hash, undefined);
    assert.equal(mission.complete, false);
  });
});

describe("signer sees a newer validated sequence", () => {
  it("does not transmit or retry the old claim when the sequence advances", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    const now = "2026-11-06T19:12:16.314Z";
    activate(ledger, now);
    const wallet = xrpl.Wallet.generate();
    const old = startMission(ledger, {
      idempotency_key: "old-nolls-claim",
      now,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
      payment_drops: "1737",
      network_fee_drops: "10",
      resource_url: "https://shop.test/old",
    }, { allowlist: { payees: [REVIEWED] } });
    const ready = act(ledger, { mission_id: old.mission.id, now }, { wallet: { address: wallet.address } }).mission;
    beginSubmit(ledger, { mission_id: ready.id, now });
    notePresign(ledger, ready.id, "EF".repeat(32));
    fs.writeFileSync(path.join(home, "proofs.txt"), "");
    fs.writeFileSync(path.join(home, "seq.txt"), "0");
    fs.writeFileSync(path.join(home, "preload.js"), `
      const fs = require("fs");
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        const body = init && init.body ? JSON.parse(init.body) : {};
        if (target === "https://testnet.xrpl-labs.com") {
          if (body.method === "server_info") {
            return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: 22118869 } } } }), { status: 200 });
          }
          if (body.method === "account_info") {
            const next = Number(fs.readFileSync(process.env.SEQ_FILE, "utf8")) + 1;
            fs.writeFileSync(process.env.SEQ_FILE, String(next));
            const sequence = next === 1 ? 22117391 : 22117392;
            return new Response(JSON.stringify({ result: { validated: true, account_data: { Sequence: sequence } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ result: { drops: { open_ledger_fee: "10", base_fee: "10", median_fee: "5000" }, ledger_current_index: 22118869 } }), { status: 200 });
        }
        if (target.startsWith("https://api.stablecoingateways.com/v1/fx/convert")) {
          fs.appendFileSync(process.env.PROOF_FILE, "sent\\n");
          return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "1737", payTo: ${JSON.stringify(REVIEWED)}, maxTimeoutSeconds: 300 }] }), { status: 402 });
        }
        return new Response("{}", { status: 500 });
      };
    `);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({ payees: [{ address: REVIEWED, resource: FX }] }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [{
        id: "cand-seq-advance",
        observed_at: now,
        resource: { url: FX, method: "GET" },
        x402: {
          x402Version: 2,
          resource: FX,
          accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "1737", payTo: REVIEWED, maxTimeoutSeconds: 300 }],
        },
      }],
    }));
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        CI: "",
        GITHUB_ACTIONS: "",
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18793",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: wallet.address,
        MISSION_XRPL_SEED: wallet.seed,
        PROOF_FILE: path.join(home, "proofs.txt"),
        SEQ_FILE: path.join(home, "seq.txt"),
        NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18793/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    const child = spawn(process.execPath, ["src/missions/worker.js", "--once"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        CI: "",
        GITHUB_ACTIONS: "",
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_WORKER: "yes",
        FOUNDRY_MISSION_EXECUTE: "yes",
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18793",
        MISSION_XRPL_ADDRESS: wallet.address,
        PROOF_FILE: path.join(home, "proofs.txt"),
        SEQ_FILE: path.join(home, "seq.txt"),
        NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
      }),
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    signer.kill("SIGTERM");
    assert.equal(code, 0, stdout);
    const body = JSON.parse(stdout);
    assert.equal(body.complete, false);
    assert.notEqual(body.reason, "cand-seq-advance-fee-retry-1");
    assert.equal(fs.readFileSync(path.join(home, "proofs.txt"), "utf8").includes("sent"), false);
    const prior = view(ledger, now).missions[ready.id];
    assert.equal(prior.hold, "uncertain");
    assert.equal(prior.presigned_hash, "EF".repeat(32));
    assert.equal(prior.last_ledger_sequence, undefined);
    assert.equal(prior.complete, false);
    const ids = Object.values(view(ledger, now).missions).map((item) => item.idempotency_key);
    assert.equal(ids.includes("old-nolls-claim-fee-retry-1"), false);
  });
});
