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
const { beginSubmit, notePresign } = require("./submit");
const { decideNewAccount } = require("./new-account");
const { executeOnce } = require("./execute-once");
const { publishHealth } = require("./publish-health");
const policy = require("./policy");

const REVIEWED = "rDbkEYdqLHcnWAHAVFwhH6KM6puCPbXNgs";
const TOKEN = "mission-internal-16";
const ACCOUNT_TOKEN = "account-decision-token-32chars-min";
const EXECUTE_TOKEN = "execute-one-shot-token-32chars-min";
const PUBLISH_TOKEN = "publish-health-token-32chars-minimum";
const ROOT = path.resolve(__dirname, "..", "..");
const SANCTIONS = "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const WATCHED = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const INVOICE = "fresh1753aabbccdd9012";
const NOW = "2026-11-06T21:20:00.000Z";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mission-execute-"));
}

function activate(ledger) {
  control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
}

function hold(ledger, address) {
  const old = startMission(ledger, {
    idempotency_key: "old-hold-1747",
    now: NOW,
    observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: REVIEWED }] },
    payment_drops: "1737",
    network_fee_drops: "10",
    resource_url: "https://shop.test/old",
  }, { allowlist: { payees: [REVIEWED] } });
  const ready = act(ledger, { mission_id: old.mission.id, now: NOW }, { wallet: { address } }).mission;
  beginSubmit(ledger, { mission_id: ready.id, now: NOW });
  notePresign(ledger, ready.id, "AB".repeat(32));
  return ready.id;
}

function challenge(invoiceId, amount, retrieved) {
  return {
    retrieved_at: retrieved || NOW,
    http_status: 402,
    paid: false,
    proof_sent: false,
    resource_url_requested: SANCTIONS,
    resource_url_in_body: SANCTIONS,
    resource_url_exact_match: true,
    x402Version: 2,
    reviewed_row: {
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      amount,
      payTo: REVIEWED,
      maxTimeoutSeconds: 600,
      extra: { sourceTag: 26100014, invoiceId },
    },
  };
}

function accountEnv(home, ledger, extra) {
  return Object.assign({
    FOUNDRY_MISSION_HOME: home,
    FOUNDRY_MISSION_LEDGER: ledger,
    FOUNDRY_MISSION_ACCOUNT_TOKEN: ACCOUNT_TOKEN,
    FOUNDRY_MISSION_ACCOUNT_PHRASE: "USE-NEW-ISOLATED-ACCOUNT",
  }, extra || {});
}

describe("new account decision", () => {
  it("records the open claim without resetting the day or retrying it", () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const oldWallet = xrpl.Wallet.generate();
    const prior = hold(ledger, oldWallet.address);
    const before = policy.dayUsed(view(ledger, NOW), "2026-11-06");
    const decision = decideNewAccount(ledger, accountEnv(home, ledger, { FOUNDRY_MISSION_PRIOR_CLAIM: prior }), NOW);
    assert.equal(decision.recorded, true);
    assert.equal(decision.decision.preserves_hold, true);
    assert.equal(decision.decision.resets_budget, false);
    assert.equal(decision.decision.retries_prior_key, false);
    assert.equal(decision.decision.execute, false);
    assert.equal(view(ledger, NOW).missions[prior].hold, "uncertain");
    assert.equal(view(ledger, NOW).missions[prior].budget.budget_drops, "1747");
    assert.equal(policy.dayUsed(view(ledger, NOW), "2026-11-06"), before);
    const again = decideNewAccount(ledger, accountEnv(home, ledger), NOW);
    assert.equal(again.replay, true);
  });
});

describe("one-shot purchase guards", () => {
  it("refuses wake, a stale challenge, the same account, and a cap breach", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const oldWallet = xrpl.Wallet.generate();
    const next = xrpl.Wallet.generate();
    const prior = hold(ledger, oldWallet.address);
    decideNewAccount(ledger, accountEnv(home, ledger, { FOUNDRY_MISSION_PRIOR_CLAIM: prior }), NOW);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({ payees: [{ address: REVIEWED, resource: SANCTIONS }] }));
    const file = path.join(home, "challenge.json");
    const base = {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_EXECUTE_TOKEN: EXECUTE_TOKEN,
      FOUNDRY_MISSION_EXECUTE_PHRASE: "EXECUTE-ONE-FRESH-PURCHASE",
      FOUNDRY_MISSION_CHALLENGE_FILE: file,
      MISSION_XRPL_ADDRESS: next.address,
    };
    await assert.rejects(
      () => executeOnce(Object.assign({}, base, { FOUNDRY_MISSION_EXECUTE_PHRASE: "WAKE-MISSION-CONTROL" }), { now: NOW, spawnSigner: false }),
      (error) => error.code === "AUTH"
    );
    fs.writeFileSync(file, JSON.stringify(challenge(INVOICE, "1753", "2026-11-06T20:00:00.000Z")));
    await assert.rejects(
      () => executeOnce(base, { now: NOW, spawnSigner: false }),
      (error) => error.code === "stale_challenge"
    );
    fs.writeFileSync(file, JSON.stringify(challenge("1793992874-ebc1623318b14ea7-d1737-4c212402f35bab060de0ac45", "1737", NOW)));
    await assert.rejects(
      () => executeOnce(base, { now: NOW, spawnSigner: false }),
      (error) => error.code === "NO_RETRY"
    );
    fs.writeFileSync(file, JSON.stringify(challenge(INVOICE, "1753", NOW)));
    await assert.rejects(
      () => executeOnce(Object.assign({}, base, { MISSION_XRPL_ADDRESS: oldWallet.address }), { now: NOW, spawnSigner: false }),
      (error) => error.code === "SEQUENCE_HELD"
    );
    assert.equal(view(ledger, NOW).missions[prior].hold, "uncertain");
    assert.equal(view(ledger, NOW).missions[prior].presigned_hash, "AB".repeat(32));
    fs.writeFileSync(file, JSON.stringify(challenge("wide1753ddff001122", "4990000", NOW)));
    const blocked = await executeOnce(base, {
      now: NOW,
      spawnSigner: false,
      fetch: async () => new Response(JSON.stringify({
        result: {
          info: { network_id: 1, validated_ledger: { seq: 22118869 } },
          drops: { open_ledger_fee: "10" },
        },
      }), { status: 200 }),
    });
    assert.equal(blocked.complete, false);
    assert.equal(blocked.signed, false);
    assert.notEqual(blocked.execute_lease_used, true);
    assert.equal(view(ledger, NOW).missions[prior].budget.budget_drops, "1747");
  });
});

describe("health publish while execute is off", () => {
  it("refreshes the observation time without clearing the 1747 hold", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const prior = hold(ledger, xrpl.Wallet.generate().address);
    const env = {
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_PUBLISH_TOKEN: PUBLISH_TOKEN,
      FOUNDRY_MISSION_PUBLISH_PHRASE: "PUBLISH-HEALTH-SNAPSHOT",
    };
    const first = await publishHealth(env, { now: NOW, fetch: async () => { throw new Error("no secret"); } });
    assert.equal(first.uploaded, false);
    assert.equal(first.reason, "no_ingest_secret");
    assert.equal(first.execute, false);
    const snap = JSON.parse(fs.readFileSync(path.join(ledger, "public-status.json"), "utf8"));
    assert.equal(snap.worker_asleep, true);
    assert.equal(snap.execute, false);
    assert.equal(snap.health, "asleep");
    assert.equal(snap.source_observed_at, NOW);
    assert.equal(snap.uncertain_drops, "1747");
    const second = await publishHealth(env, { now: "2026-11-06T21:22:00.000Z", fetch: async () => { throw new Error("no secret"); } });
    assert.equal(second.reason, "fresh");
    const later = await publishHealth(env, { now: "2026-11-06T21:26:00.000Z", fetch: async () => { throw new Error("no secret"); } });
    assert.equal(later.changed, true);
    const refreshed = JSON.parse(fs.readFileSync(path.join(ledger, "public-status.json"), "utf8"));
    assert.equal(refreshed.source_observed_at, "2026-11-06T21:26:00.000Z");
    assert.equal(refreshed.sequence, snap.sequence + 1);
    assert.equal(view(ledger, NOW).missions[prior].hold, "uncertain");
    assert.equal(policy.dayUsed(view(ledger, NOW), "2026-11-06"), 1747n);
  });
});

describe("production one-shot entrypoint", () => {
  it("buys once from the new account and leaves the old claim and cand-17 untouched", async () => {
    const home = tmp();
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    activate(ledger);
    const oldWallet = xrpl.Wallet.generate();
    const next = xrpl.Wallet.generate();
    const prior = hold(ledger, oldWallet.address);
    decideNewAccount(ledger, accountEnv(home, ledger, { FOUNDRY_MISSION_PRIOR_CLAIM: prior }), NOW);
    const discovery = JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [{ id: "cand-17-51ec932c8e", observed_at: "2026-11-06T19:00:00.000Z" }],
    });
    fs.writeFileSync(path.join(home, "discovery.json"), discovery);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({ payees: [{ address: REVIEWED, resource: SANCTIONS }] }));
    const freshAt = new Date().toISOString();
    fs.writeFileSync(path.join(home, "challenge.json"), JSON.stringify(challenge(INVOICE, "1753", freshAt)));
    const proof = path.join(home, "proofs.txt");
    fs.writeFileSync(proof, "");
    fs.writeFileSync(path.join(home, "preload.js"), `
      const fs = require("fs");
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
            return new Response(JSON.stringify({
              x402Version: 2,
              accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "1753", payTo: ${JSON.stringify(REVIEWED)}, maxTimeoutSeconds: 600, extra: { invoiceId: ${JSON.stringify(INVOICE)}, sourceTag: 26100014 } }],
            }), { status: 402 });
          }
          fs.appendFileSync(process.env.PROOF_FILE, "sent\\n");
          return new Response(JSON.stringify({ data: { listed: false, query: { address: ${JSON.stringify(WATCHED)} } } }), { status: 200 });
        }
        if (target.startsWith("http://127.0.0.1:") || target.startsWith("http://localhost:")) return original(url, init);
        return new Response("{}", { status: 500 });
      };
    `);
    const signer = spawn(process.execPath, ["src/missions/signer.js"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        CI: "",
        GITHUB_ACTIONS: "",
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18795",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: next.address,
        MISSION_XRPL_SEED: next.seed,
        PROOF_FILE: proof,
        NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("signer did not listen")), 5000);
      const wait = () => {
        fetch("http://127.0.0.1:18795/health").then((res) => res.json()).then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(() => setTimeout(wait, 50));
      };
      wait();
    });
    const childEnv = Object.assign({}, process.env, {
      CI: "",
      GITHUB_ACTIONS: "",
      FOUNDRY_MISSION_HOME: home,
      FOUNDRY_MISSION_LEDGER: ledger,
      FOUNDRY_MISSION_EXECUTE_TOKEN: EXECUTE_TOKEN,
      FOUNDRY_MISSION_EXECUTE_PHRASE: "EXECUTE-ONE-FRESH-PURCHASE",
      FOUNDRY_MISSION_CHALLENGE_FILE: path.join(home, "challenge.json"),
      FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
      FOUNDRY_MISSION_SIGNER_PORT: "18795",
      MISSION_XRPL_ADDRESS: next.address,
      PROOF_FILE: proof,
      NODE_OPTIONS: `--require ${path.join(home, "preload.js")}`,
    });
    delete childEnv.FOUNDRY_MISSION_EXECUTE;
    const child = spawn(process.execPath, ["src/missions/execute-once.js"], {
      cwd: ROOT,
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    signer.kill("SIGTERM");
    assert.equal(code, 0, `${stderr}\n${stdout}`);
    const body = JSON.parse(stdout);
    assert.equal(body.complete, true);
    assert.equal(body.signed, true);
    assert.equal(body.prior_claim_id, prior);
    assert.match(body.purchase_key, /^buy-[a-f0-9]{24}$/);
    assert.equal(body.purchase_key.includes("cand-17"), false);
    assert.equal(body.purchase_key.includes("fee-retry"), false);
    const state = view(ledger, NOW);
    assert.equal(state.missions[prior].hold, "uncertain");
    assert.equal(state.missions[prior].budget.budget_drops, "1747");
    assert.equal(state.missions[prior].presigned_hash, "AB".repeat(32));
    const bought = state.missions[body.mission_id];
    assert.equal(bought.complete, true);
    assert.equal(bought.prior_claim_id, prior);
    assert.equal(bought.sequence, 22117391);
    assert.equal(bought.last_ledger_sequence, 22118889);
    assert.equal(bought.invoice_id, INVOICE);
    assert.equal(bought.claim.account, next.address);
    assert.notEqual(bought.claim.account, oldWallet.address);
    const text = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(text.includes("tx_blob"), false);
    assert.equal(text.includes("fee-retry"), false);
    assert.equal(text.includes(next.seed), false);
    assert.equal(fs.readFileSync(path.join(home, "discovery.json"), "utf8"), discovery);
    assert.equal(fs.readFileSync(proof, "utf8").trim(), "sent");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "worker.json"), "utf8")).asleep, true);
    assert.equal(policy.dayUsed(state, "2026-11-06") > 1747n, true);
    assert.equal(policy.dayUsed(state, "2026-11-06") <= 5000000n, true);
    const again = spawn(process.execPath, ["src/missions/execute-once.js"], { cwd: ROOT, env: childEnv });
    let againErr = "";
    again.stderr.on("data", (chunk) => { againErr += chunk; });
    const againCode = await new Promise((resolve) => again.on("exit", resolve));
    assert.equal(againCode, 1);
    assert.match(againErr, /NO_RETRY/);
  });
});

describe("spawned signer ledger and asleep latch", () => {
  it("signs against the named ledger while worker.json stays asleep", async () => {
    const home = tmp();
    const ledger = path.join(home, "separate");
    fs.mkdirSync(ledger);
    activate(ledger);
    const oldWallet = xrpl.Wallet.generate();
    const next = xrpl.Wallet.generate();
    const prior = hold(ledger, oldWallet.address);
    decideNewAccount(ledger, accountEnv(home, ledger, { FOUNDRY_MISSION_PRIOR_CLAIM: prior }), NOW);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    fs.writeFileSync(path.join(home, "account.json"), JSON.stringify({ address: next.address, seed: next.seed }), { mode: 0o600 });
    fs.chmodSync(path.join(home, "account.json"), 0o600);
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({ payees: [{ address: REVIEWED, resource: SANCTIONS }] }));
    const freshAt = new Date().toISOString();
    fs.writeFileSync(path.join(home, "challenge.json"), JSON.stringify(challenge("spawnfresh100aabbcc02", "100", freshAt)));
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
            return new Response(JSON.stringify({ result: { validated: true, account_data: { Sequence: 11 } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ result: { drops: { open_ledger_fee: "10" } } }), { status: 200 });
        }
        if (target.startsWith("https://api.stablecoingateways.com/")) {
          const header = init && init.headers && (init.headers["PAYMENT-SIGNATURE"] || init.headers["payment-signature"]);
          if (!header) {
            return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "100", payTo: ${JSON.stringify(REVIEWED)}, maxTimeoutSeconds: 600, extra: { invoiceId: "spawnfresh100aabbcc02", sourceTag: 26100014 } }] }), { status: 402 });
          }
          return new Response(JSON.stringify({ code: "verify_failed" }), { status: 402 });
        }
        if (String(url).startsWith("http://127.0.0.1:")) return original(url, init);
        return new Response("{}", { status: 500 });
      };
    `);
    const redact = (text) => String(text || "").split(next.seed).join("[redacted]");
    const realFetch = globalThis.fetch;
    let result;
    try {
      result = await executeOnce({
        FOUNDRY_MISSION_HOME: home,
        FOUNDRY_MISSION_LEDGER: ledger,
        FOUNDRY_MISSION_EXECUTE_TOKEN: EXECUTE_TOKEN,
        FOUNDRY_MISSION_EXECUTE_PHRASE: "EXECUTE-ONE-FRESH-PURCHASE",
        FOUNDRY_MISSION_CHALLENGE_FILE: path.join(home, "challenge.json"),
        FOUNDRY_MISSION_SIGNER_TOKEN: TOKEN,
        FOUNDRY_MISSION_SIGNER_PORT: "18798",
        MISSION_XRPL_ADDRESS: next.address,
        NODE_OPTIONS: `--require ${preload}`,
      }, {
        now: freshAt,
        fetch: async (url, init) => {
          const target = String(url);
          if (target.startsWith("http://127.0.0.1:") || target.startsWith("http://localhost:")) return realFetch(url, init);
          const body = init && init.body ? JSON.parse(init.body) : {};
          if (target === "https://testnet.xrpl-labs.com") {
            if (body.method === "server_info") return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: 22118869 } } } }), { status: 200 });
            if (body.method === "account_info") return new Response(JSON.stringify({ result: { validated: true, account_data: { Sequence: 11 } } }), { status: 200 });
            return new Response(JSON.stringify({ result: { drops: { open_ledger_fee: "10" } } }), { status: 200 });
          }
          const header = init && init.headers && (init.headers["PAYMENT-SIGNATURE"] || init.headers["payment-signature"]);
          if (!header) {
            return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "100", payTo: REVIEWED, maxTimeoutSeconds: 600, extra: { invoiceId: "spawnfresh100aabbcc02", sourceTag: 26100014 } }] }), { status: 402 });
          }
          return new Response(JSON.stringify({ code: "verify_failed" }), { status: 402 });
        },
      });
    } catch (error) {
      assert.fail(redact(error && error.stack));
    }
    assert.equal(result.reason, "delivery_failed");
    assert.equal(result.complete, false);
    assert.equal(result.signed, true);
    assert.equal(result.execute_lease_used, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "worker.json"), "utf8")).asleep, true);
    const text = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(/[0-9A-F]{64}/.test(text), true);
    assert.equal(text.includes(next.seed), false);
    assert.equal(fs.existsSync(path.join(home, "ledger", "events.jsonl")), false);
    assert.equal(view(ledger, freshAt).missions[prior].hold, "uncertain");
  });
});
