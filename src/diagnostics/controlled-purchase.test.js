"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const config = require("../missions/config");
const { control, view } = require("../missions/engine");
const { invoiceIdField } = require("../missions/x402-deliver");
const { buildSignaturePayload } = require("../x402-outbound-guard");
const { writePrivateAccount, writeHandover } = require("./account-file");
const { startSeller, SANCTIONS_PAYEE, assertDiagnosticPort, DIAGNOSTIC_PORT } = require("./controlled-seller");
const { PERMANENT_HOLD, PHRASE, officialScheme, consumeAttempt, runControlledPurchase } = require("./controlled-purchase");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const NOV8 = "2026-11-08T18:00:00.000Z";
const NOV9 = "2026-11-09T18:00:00.000Z";
const DIAG_TOKEN = "diagnostic-token-32-characters-min";
const HOUSE = anchors.WALLETS.W0.address;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diag-purchase-"));
  const ledger = path.join(home, "ledger");
  fs.mkdirSync(ledger);
  fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
  return { home, ledger };
}

function seedLegacy(ledger, drops) {
  const mission = {
    id: PERMANENT_HOLD,
    status: "uncertain",
    hold: "unsubmitted",
    budget: { budget_drops: "1747", payment_drops: "1737", network_fee_drops: "10" },
    day: "2026-11-06",
    retry_blocked: true,
    signed: true,
    seller: SANCTIONS_PAYEE,
    claim: { account: "rLegacySequenceHoldAccount1", amount: "1737", fee: "10" },
    updated_at: NOW,
  };
  const lines = [
    { type: "mission.upsert", at: NOW, mission },
    { type: "budget.reserved", at: NOW, mission_id: mission.id, day: "2026-11-06", budget_drops: "1747", components: mission.budget },
    { type: "budget.uncertain", at: NOW, mission_id: mission.id, day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true },
  ];
  if (drops) {
    lines.push({ type: "budget.spent", at: NOW, mission_id: "msnspent0000000001", day: "2026-11-06", drops, live: false });
  }
  fs.appendFileSync(path.join(ledger, "events.jsonl"), `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function baseEnv(home, ledger, seller, payee, extra) {
  return Object.assign({
    FOUNDRY_MISSION_HOME: home,
    FOUNDRY_MISSION_LEDGER: ledger,
    FOUNDRY_DIAGNOSTIC_PHRASE: PHRASE,
    FOUNDRY_DIAGNOSTIC_TOKEN: DIAG_TOKEN,
    FOUNDRY_DIAGNOSTIC_SELLER: seller,
    FOUNDRY_DIAGNOSTIC_PAYEE: payee,
    FOUNDRY_DIAGNOSTIC_PAYMENT_DROPS: "10",
    FOUNDRY_DIAGNOSTIC_FEE_DROPS: "10",
  }, extra || {});
}

function arm(home, payer, payee) {
  const account = path.join(home, "buyer.json");
  const handover = path.join(home, "handover.json");
  writePrivateAccount(account, payer);
  writeHandover(handover, { buyer: payer.address, seller: payee });
  return {
    FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE: account,
    FOUNDRY_DIAGNOSTIC_HANDOVER: handover,
    FOUNDRY_DIAGNOSTIC_LIVE: "yes",
  };
}

function ledgerRpc(buyer, seller, sequence) {
  return async (url, init) => {
    assert.equal(new URL(url).hostname, "testnet.xrpl-labs.com");
    const body = JSON.parse(init.body);
    if (body.method === "server_info") {
      return new Response(JSON.stringify({ result: { info: { network_id: 1, validated_ledger: { seq: 10000 } } } }), { status: 200 });
    }
    if (body.method === "account_info") {
      const account = body.params[0].account;
      return new Response(JSON.stringify({
        result: { validated: true, account_data: { Account: account, Sequence: account === buyer ? sequence : 1, Balance: "20000000" } },
      }), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  };
}

function proof(payTo, found) {
  return async (url, init) => {
    assert.equal(url, "https://testnet.xrpl-labs.com");
    const body = JSON.parse(init.body);
    assert.equal(body.method, "tx");
    if (!found) return new Response(JSON.stringify({ result: { error: "txnNotFound", validated: false } }), { status: 200 });
    return new Response(JSON.stringify({
      result: {
        validated: true,
        hash: body.params[0].transaction,
        Destination: payTo,
        Amount: "10",
        meta: { TransactionResult: "tesSUCCESS" },
      },
    }), { status: 200 });
  };
}

function schemeFor(hashBox) {
  return {
    verify: async () => ({ isValid: true, payer: hashBox.payer || null }),
    settle: async (payload) => {
      hashBox.settles = (hashBox.settles || 0) + 1;
      hashBox.hash = xrpl.hashes.hashSignedTx(payload.payload.signedTxBlob).toUpperCase();
      return { success: true, transaction: hashBox.hash, payer: hashBox.payer || null };
    },
  };
}

describe("controlled purchase", () => {
  it("previews the shared cap, including the Nov 6 hold on later Chicago days", async () => {
    assert.equal(DIAGNOSTIC_PORT, 8795);
    assert.throws(() => assertDiagnosticPort(8794), (error) => error.code === "BIND");
    assert.throws(() => assertDiagnosticPort(8788), (error) => error.code === "BIND");
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(ledger);
    const before = fs.readFileSync(path.join(ledger, "events.jsonl"));
    const payee = xrpl.Wallet.generate().address;
    const hashBox = { settles: 0, payer: payee };
    const armed = await startSeller({ payTo: payee, scheme: schemeFor(hashBox) });
    try {
      const vendor = await fetch(`${armed.url}?shape=vendor`);
      const vendorBody = JSON.parse(Buffer.from(vendor.headers.get("payment-required"), "base64").toString("utf8"));
      assert.equal(Object.prototype.hasOwnProperty.call(vendorBody.accepts[0].extra, "areFeesSponsored"), false);
      const payer = xrpl.Wallet.generate();
      const tx = {
        TransactionType: "Payment",
        Account: payer.address,
        Destination: payee,
        Amount: "10",
        Fee: "10",
        Sequence: 10,
        LastLedgerSequence: 10020,
        SourceTag: vendorBody.accepts[0].extra.sourceTag,
        InvoiceID: invoiceIdField(vendorBody.accepts[0].extra.invoiceId),
      };
      const payload = buildSignaturePayload({
        required: { resource: { url: armed.url } },
        accept: vendorBody.accepts[0],
        txBlob: payer.sign(tx).tx_blob,
      });
      const rejected = await fetch(armed.url, {
        method: "POST",
        headers: { "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") },
        body: "{}",
      });
      assert.equal(rejected.status, 402);
      assert.equal(hashBox.settles, 0);
      for (const instant of [NOW, NOV8, NOV9]) {
        const report = await runControlledPurchase(baseEnv(home, ledger, armed.url, payee), { now: instant });
        assert.equal(report.live, false);
        assert.equal(report.attempt_consumed, false);
        assert.equal(report.daily_used, "1747");
        assert.equal(report.legacy_drops, "1747");
        assert.equal(report.settled, false);
      }
      assert.equal(fs.readFileSync(path.join(ledger, "events.jsonl")).equals(before), true);
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), false);
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), false);
    } finally {
      await armed.close();
    }
  });

  it("refuses a reset ledger, the worker port, a house payee, and a fee-inclusive cap breach", async () => {
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const payee = xrpl.Wallet.generate().address;
    const seller = "http://127.0.0.1:8795/paid";
    await assert.rejects(() => runControlledPurchase(baseEnv(home, ledger, seller, payee), { now: NOW }), (error) => error.code === "CAP");
    const substitute = tmpHome();
    control(substitute.ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    fs.appendFileSync(path.join(substitute.ledger, "events.jsonl"), `${[
      JSON.stringify({ type: "mission.upsert", at: NOW, mission: { id: PERMANENT_HOLD, hold: "uncertain", signed: true, seller: SANCTIONS_PAYEE, updated_at: NOW } }),
      JSON.stringify({ type: "budget.uncertain", at: NOW, mission_id: "msnunrelated0000001", day: "2026-11-06", drops: "1747", settlement: "submit_unknown", live: true }),
    ].join("\n")}\n`);
    await assert.rejects(() => runControlledPurchase(baseEnv(substitute.home, substitute.ledger, seller, payee), { now: NOV8 }), (error) => error.code === "CAP");
    await assert.rejects(() => runControlledPurchase(baseEnv(substitute.home, substitute.ledger, seller, payee), { now: NOV9 }), (error) => error.code === "CAP");
    seedLegacy(ledger);
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: false }));
    await assert.rejects(() => runControlledPurchase(baseEnv(home, ledger, seller, payee), { now: NOW }), (error) => error.code === "ASLEEP");
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ asleep: true }));
    await assert.rejects(
      () => runControlledPurchase(baseEnv(home, ledger, "https://api.stablecoingateways.com/paid", payee), { now: NOW }),
      (error) => error.code === "HOST"
    );
    await assert.rejects(
      () => runControlledPurchase(baseEnv(home, ledger, "http://127.0.0.1:8794/paid", payee), { now: NOW }),
      (error) => error.code === "BIND"
    );
    await assert.rejects(
      () => runControlledPurchase(baseEnv(home, ledger, seller, HOUSE), { now: NOW }),
      (error) => error.code === "W0"
    );
    await assert.rejects(
      () => runControlledPurchase(baseEnv(home, ledger, seller, payee, { FOUNDRY_MISSION_EXECUTE: "yes" }), { now: NOW }),
      (error) => error.code === "AUTH"
    );
    fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
      type: "budget.uncertain",
      at: NOW,
      mission_id: PERMANENT_HOLD,
      day: "2026-11-06",
      drops: "4998243",
      settlement: "submit_unknown",
      live: true,
    })}\n`);
    await assert.rejects(() => runControlledPurchase(baseEnv(home, ledger, seller, payee), { now: NOV8 }), (error) => error.code === "CAP");
    await assert.rejects(() => runControlledPurchase(baseEnv(home, ledger, seller, payee), { now: NOV9 }), (error) => error.code === "CAP");
    assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), false);
  });

  it("does not consume the attempt when the ledger read fails, and blocks a second run after a crash", async () => {
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(ledger);
    const payer = xrpl.Wallet.generate();
    const payee = xrpl.Wallet.generate().address;
    const seller = await startSeller({ payTo: payee, scheme: schemeFor({}) });
    const legacy = JSON.stringify(view(ledger, NOW).missions[PERMANENT_HOLD]);
    try {
      await assert.rejects(
        () => runControlledPurchase(Object.assign(baseEnv(home, ledger, seller.url, payee), arm(home, payer, payee)), {
          now: NOW,
          fetch: async () => { throw Object.assign(new Error("timeout"), { code: "ABORT" }); },
        }),
        (error) => error.code === "ABORT"
      );
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.jsonl")), false);
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), false);
      const loose = path.join(home, "loose.json");
      fs.writeFileSync(loose, JSON.stringify({ address: payer.address, seed: payer.seed }), { mode: 0o644 });
      await assert.rejects(
        () => runControlledPurchase(baseEnv(home, ledger, seller.url, payee, {
          FOUNDRY_DIAGNOSTIC_LIVE: "yes",
          FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE: loose,
          FOUNDRY_DIAGNOSTIC_HANDOVER: path.join(home, "handover.json"),
        }), { now: NOW }),
        (error) => error.code === "AUTH"
      );
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), false);
      fs.appendFileSync(path.join(ledger, "events.jsonl"), `${JSON.stringify({
        type: "mission.upsert",
        at: NOW,
        mission: { id: "msncurrent000000001", hold: "unsubmitted", signed: false, unsigned_tx: { Account: payer.address } },
      })}\n`);
      await assert.rejects(
        () => runControlledPurchase(baseEnv(home, ledger, seller.url, payee, {
          FOUNDRY_DIAGNOSTIC_LIVE: "yes",
          FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE: path.join(home, "buyer.json"),
          FOUNDRY_DIAGNOSTIC_HANDOVER: path.join(home, "handover.json"),
        }), {
          now: NOW,
          ledgerFetch: ledgerRpc(payer.address, payee, 10),
        }),
        (error) => error.code === "ACCOUNT"
      );
      assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), false);
    } finally {
      await seller.close();
    }

    const second = tmpHome();
    control(second.ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(second.ledger);
    const seller2 = await startSeller({ payTo: payee, scheme: schemeFor({ payer: payer.address }) });
    try {
      await assert.rejects(
        () => runControlledPurchase(Object.assign(baseEnv(second.home, second.ledger, seller2.url, payee), arm(second.home, payer, payee)), {
          now: NOW,
          ledgerFetch: ledgerRpc(payer.address, payee, 10),
          beforeSign: async () => { throw Object.assign(new Error("crash"), { code: "CRASH" }); },
        }),
        (error) => error.code === "CRASH"
      );
      assert.equal(fs.existsSync(path.join(second.home, "diagnostic-attempt.lock")), true);
      assert.equal(JSON.stringify(view(second.ledger, NOW).missions[PERMANENT_HOLD]), legacy);
      await assert.rejects(
        () => runControlledPurchase(baseEnv(second.home, second.ledger, seller2.url, payee, {
          FOUNDRY_DIAGNOSTIC_LIVE: "yes",
          FOUNDRY_DIAGNOSTIC_ACCOUNT_FILE: path.join(second.home, "buyer.json"),
          FOUNDRY_DIAGNOSTIC_HANDOVER: path.join(second.home, "handover.json"),
        }), { now: NOW }),
        (error) => error.code === "NO_RETRY"
      );
    } finally {
      await seller2.close();
    }
  });

  it("settles only after the seller receipt and an independent validated proof", async () => {
    const empty = officialScheme();
    assert.equal(empty.hook_source, "official_default");
    assert.deepEqual(empty.scheme.options, {});
    const payer = xrpl.Wallet.generate();
    const payee = xrpl.Wallet.generate().address;
    const hashBox = { payer: payer.address, settles: 0 };
    const { home, ledger } = tmpHome();
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(ledger);
    const seller = await startSeller({ payTo: payee, scheme: schemeFor(hashBox), boundary: "supplied_scheme" });
    const legacy = JSON.stringify(view(ledger, NOW).missions[PERMANENT_HOLD]);
    try {
      const unproven = await runControlledPurchase(Object.assign(baseEnv(home, ledger, seller.url, payee), arm(home, payer, payee)), {
        now: NOW,
        ledgerFetch: ledgerRpc(payer.address, payee, 10),
        proofFetch: proof(payee, false),
      });
      assert.equal(unproven.settled, false);
      assert.equal(unproven.reason, "not_validated");
      assert.equal(unproven.vendor_signed, false);
      assert.equal(hashBox.settles, 1);
      const mission = view(ledger, NOW).missions[unproven.mission_id];
      assert.equal(mission.hold, "uncertain");
      assert.equal(mission.seller, payee);
      assert.equal(JSON.stringify(view(ledger, NOW).missions[PERMANENT_HOLD]), legacy);
      assert.equal(JSON.stringify(unproven).includes(payer.seed), false);
    } finally {
      await seller.close();
    }

    const fresh = tmpHome();
    control(fresh.ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    seedLegacy(fresh.ledger);
    const proved = { payer: payer.address, settles: 0 };
    const seller2 = await startSeller({ payTo: payee, scheme: schemeFor(proved), boundary: "supplied_scheme" });
    try {
      const result = await runControlledPurchase(Object.assign(baseEnv(fresh.home, fresh.ledger, seller2.url, payee, {
        FOUNDRY_DIAGNOSTIC_SIMULATE: "yes",
        FOUNDRY_DIAGNOSTIC_SIM_RPC: "http://127.0.0.1:9",
      }), arm(fresh.home, payer, payee)), {
        now: NOW,
        ledgerFetch: ledgerRpc(payer.address, payee, 11),
        proofFetch: proof(payee, true),
      });
      assert.equal(result.settled, true);
      assert.equal(result.ledger_proof, "validated");
      assert.equal(result.network_boundary, "testnet");
      assert.equal(result.official_settle, "supplied_scheme");
      assert.equal(fs.readFileSync(path.join(__dirname, "controlled-purchase.js"), "utf8").includes("FOUNDRY_DIAGNOSTIC_SIMULATE"), false);
      assert.equal(result.vendor_signed, false);
      assert.equal(proved.settles, 1);
      const state = view(fresh.ledger, NOW);
      assert.equal(state.missions[result.mission_id].hold, "spent");
      assert.equal(state.missions[PERMANENT_HOLD].hold, "uncertain");
      assert.equal(state.days["2026-11-06"].uncertain, "1747");
      assert.equal(state.days["2026-11-06"].spent, "20");
      assert.equal(JSON.stringify(result).includes(payer.seed), false);
    } finally {
      await seller2.close();
    }
  });

  it("keeps an ambiguous attempt and lets only one of two processes take the lock", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "diag-lock-"));
    const file = path.join(home, "diagnostic-attempt.jsonl");
    fs.writeFileSync(file, "{\"type\":\"attempt.used\"");
    const before = fs.readFileSync(file);
    await assert.rejects(async () => consumeAttempt(home, NOV8), (error) => error.code === "NO_RETRY");
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.equal(fs.existsSync(path.join(home, "diagnostic-attempt.lock")), true);
    await assert.rejects(async () => consumeAttempt(home, NOV8), (error) => error.code === "NO_RETRY");
    assert.equal(fs.readFileSync(file).equals(before), true);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "diag-race-"));
    const { spawn } = require("child_process");
    const root = path.resolve(__dirname, "..", "..");
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", "try { require('./src/diagnostics/controlled-purchase').consumeAttempt(process.env.DIAG_HOME, '2026-11-08T18:00:00.000Z'); process.exit(0); } catch (error) { process.stderr.write(error.code || 'ERR'); process.exit(1); }"], {
        cwd: root,
        env: Object.assign({}, process.env, { DIAG_HOME: other }),
      });
      let err = "";
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("close", (status) => resolve({ status, err }));
    });
    const [left, right] = await Promise.all([run(), run()]);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [0, 1]);
    const loser = left.status === 0 ? right : left;
    assert.equal(loser.err, "NO_RETRY");
    const lines = fs.readFileSync(path.join(other, "diagnostic-attempt.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });
});
