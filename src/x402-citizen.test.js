"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const rules = require("../web/lib/x402-rules");
const guard = require("./x402-outbound-guard");
const citizen = require("./x402-citizen-buy");

const FOREIGN = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
const ROOT = path.resolve(__dirname, "..");

function challenge(payTo, extra) {
  const required = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: (extra && extra.network) || "xrpl:1",
        amount: (extra && extra.amount) || "5000",
        asset: "XRP",
        payTo,
        extra: {
          sourceTag: extra && Object.prototype.hasOwnProperty.call(extra, "sourceTag") ? extra.sourceTag : 77402101,
          invoiceId: "foreign-day6",
        },
      },
    ],
  };
  return {
    status: 402,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "payment-required" ? rules.encodeHeader(required) : "";
      },
    },
    text: async () => JSON.stringify({ paymentRequired: required }),
  };
}

describe("citizen buyer", () => {
  it("dry-runs when no foreign shop is configured", async () => {
    const report = await citizen.run({
      args: citizen.parseArgs([]),
      env: {},
      urls: [],
      ledgerText: "",
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      },
    });
    assert.equal(report.dry_run, true);
    assert.equal(report.signed, false);
    assert.equal(report.hash, null);
    assert.equal(report.foreign_shop, null);
    assert.equal(report.network, "xrpl:1");
    assert.equal(report.network_id, 1);
    assert.equal(report.cap_drops, "500000");
    assert.equal(report.fingerprint_source_tag, 202609296);
    assert.equal(report.fingerprint_memo, "aether-foundry:f11");
    assert.match(report.reason, /no foreign shop/);
    const filed = JSON.parse(fs.readFileSync(citizen.CANDIDATES, "utf8"));
    assert.deepEqual(filed.urls, [
      {
        url: "https://verify.sciphr.io/v1/credential/verify",
        method: "POST",
        body: { subject: guard.W3_ADDRESS },
      },
      {
        url: "https://verify.sciphr.io/v1/did/resolve",
        method: "POST",
        body: { account: guard.W3_ADDRESS },
      },
      "https://x402.cryptobuddy.com.au/crypto/australia/best?asset=XRP&amount=5000&side=buy",
    ]);
    assert.equal(filed.network, "xrpl:1");
    const loaded = citizen.loadCandidates(citizen.CANDIDATES);
    assert.equal(loaded[0].method, "POST");
    assert.deepEqual(loaded[0].body, { subject: guard.W3_ADDRESS });
    assert.equal(loaded[1].method, "POST");
    assert.deepEqual(loaded[1].body, { account: guard.W3_ADDRESS });
    assert.equal(loaded[2].method, "GET");
    assert.equal(loaded[2].body, null);
  });

  it("probes a POST body and retries the signature with that same method and body", async () => {
    const verify = "https://verify.sciphr.io/v1/credential/verify";
    const body = JSON.stringify({ subject: guard.W3_ADDRESS });
    const calls = [];
    let submits = 0;
    const paid = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", verify]),
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      ledgerText: "",
      now: new Date("2026-09-29T12:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body, headers: init.headers });
        assert.equal(url, verify);
        assert.equal(init.method, "POST");
        assert.equal(init.body, body);
        assert.equal(init.headers["Content-Type"], "application/json");
        if (!init.headers["PAYMENT-SIGNATURE"]) {
          return challenge(FOREIGN, { amount: "2000", sourceTag: 804681468 });
        }
        const decoded = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]);
        if (!decoded.payload.transaction) {
          return {
            status: 402,
            headers: { get: () => "" },
            text: async () => JSON.stringify({ code: "payment_not_on_ledger" }),
          };
        }
        assert.equal(decoded.payload.signedTxBlob, "BLOB");
        assert.equal(decoded.payload.invoiceId, "foreign-day6");
        assert.equal(decoded.payload.transaction, "E".repeat(64));
        return {
          status: 200,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ ok: true }),
        };
      },
      sign: async (tx) => {
        assert.equal(tx.Amount, "2000");
        assert.equal(tx.Destination, FOREIGN);
        assert.equal(tx.SourceTag, 804681468);
        return { tx_blob: "BLOB", hash: "E".repeat(64) };
      },
      submit: async () => {
        submits += 1;
        return { hash: "E".repeat(64), result: "tesSUCCESS", ledger_index: 9 };
      },
    });
    assert.equal(calls.length, 3);
    assert.equal(calls.every((call) => call.method === "POST" && call.body === body), true);
    assert.equal(calls[0].headers["PAYMENT-SIGNATURE"], undefined);
    assert.equal(submits, 1);
    assert.equal(paid.dry_run, false);
    assert.equal(paid.method, "POST");
    assert.equal(paid.foreign_shop, verify);
    assert.equal(paid.drops, "2000");
    assert.equal(paid.source_tag, 804681468);
    assert.equal(paid.settlement, "client-submit");
    assert.equal(paid.http_status, 200);
    assert.equal(paid.hash, "E".repeat(64));
  });

  it("dry-runs the filed Sciphr credential POST and keeps Cryptobuddy on GET", async () => {
    const seen = [];
    const report = await citizen.run({
      args: citizen.parseArgs([]),
      env: {},
      ledgerText: "",
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init.method, body: init.body });
        return challenge("rUjBK34fKyMstVePdZwhfJhoQuz4U6wLDL", { amount: "2000", sourceTag: 804681468 });
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://verify.sciphr.io/v1/credential/verify");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].body, JSON.stringify({ subject: guard.W3_ADDRESS }));
    assert.equal(report.dry_run, true);
    assert.equal(report.signed, false);
    assert.equal(report.hash, null);
    assert.equal(report.method, "POST");
    assert.equal(report.foreign_shop, seen[0].url);
    assert.equal(report.pay_to, "rUjBK34fKyMstVePdZwhfJhoQuz4U6wLDL");
    assert.equal(report.drops, "2000");
    assert.equal(report.source_tag, 804681468);

    const buddy = [];
    const getReport = await citizen.run({
      args: citizen.parseArgs([
        "--url",
        "https://x402.cryptobuddy.com.au/crypto/australia/best?asset=XRP&amount=5000&side=buy",
      ]),
      env: {},
      ledgerText: "",
      fetchImpl: async (url, init) => {
        buddy.push({ url, method: init.method, body: init.body });
        return challenge(FOREIGN);
      },
    });
    assert.equal(buddy.length, 1);
    assert.equal(buddy[0].method, "GET");
    assert.equal(buddy[0].body, undefined);
    assert.equal(getReport.method, "GET");
    assert.equal(getReport.foreign_shop, buddy[0].url);
  });

  it("prints an unsigned foreign payment with the fingerprint and refuses the cap", async () => {
    const report = await citizen.run({
      args: citizen.parseArgs(["--url", "https://foreign.example/sku"]),
      env: {},
      ledgerText: "",
      fetchImpl: async () => challenge(FOREIGN),
    });
    assert.equal(report.dry_run, true);
    assert.equal(report.signed, false);
    assert.equal(report.hash, null);
    assert.equal(report.pay_to, FOREIGN);
    assert.equal(report.drops, "5000");
    assert.equal(report.source_tag, 77402101);
    assert.equal(report.tx.SourceTag, 77402101);
    const memo = report.tx.Memos.map((entry) => Buffer.from(entry.Memo.MemoData, "hex").toString("utf8"));
    assert.equal(memo.includes("foreign-day6"), true);
    assert.equal(memo.includes("aether-foundry:f11"), true);

    const bare = citizen.buildCitizenTx({
      account: guard.W3_ADDRESS,
      accept: { payTo: FOREIGN, amount: "1000", extra: { invoiceId: "inv-bare" } },
    });
    assert.equal(bare.SourceTag, citizen.FINGERPRINT_TAG);
    assert.throws(() => citizen.capDrops("600000"), (error) => error.code === "CAP");
    assert.equal(citizen.CAP_DROPS, 500000n);
  });

  it("does not pay a Foundry anchor, a mainnet accept, or a second live shot without the box gate", async () => {
    const skipped = await citizen.run({
      args: citizen.parseArgs(["--url", "https://desk.example/api/x402/reserve-audit"]),
      env: {},
      ledgerText: "",
      fetchImpl: async () => challenge(guard.W3_ADDRESS),
    });
    assert.equal(skipped.foreign_shop, null);
    assert.match(skipped.notes[0], /Foundry payTo/);

    const mainnet = await citizen.run({
      args: citizen.parseArgs(["--url", "https://foreign.example/sku"]),
      env: {},
      ledgerText: "",
      fetchImpl: async () => challenge(FOREIGN, { network: "xrpl:0" }),
    });
    assert.equal(mainnet.foreign_shop, null);
    assert.match(mainnet.notes[0], /mainnet/);

    let submitted = 0;
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: { CI: "", GITHUB_ACTIONS: "" },
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          submit: async () => {
            submitted += 1;
            return { hash: "B".repeat(64), result: "tesSUCCESS" };
          },
        }),
      (error) => error.code === "LIVE_GATE"
    );
    assert.equal(submitted, 0);
  });

  it("lets the shop settle a presigned blob and records only on HTTP 200", async () => {
    const payloads = [];
    let submitted = 0;
    const recorded = [];
    const paid = await citizen.run({
      args: citizen.parseArgs(["--live", "--record", "--url", "https://foreign.example/sku"]),
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      ledgerText: "",
      now: new Date("2026-09-29T12:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        if (!init || !init.headers || !init.headers["PAYMENT-SIGNATURE"]) return challenge(FOREIGN);
        const decoded = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]);
        payloads.push(decoded.payload);
        return {
          status: 200,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ ok: true, transaction: "C".repeat(64) }),
        };
      },
      sign: async (tx) => {
        assert.equal(tx.Account, guard.W3_ADDRESS);
        assert.equal(tx.Destination, FOREIGN);
        assert.equal(tx.Amount, "5000");
        const memo = tx.Memos.map((entry) => Buffer.from(entry.Memo.MemoData, "hex").toString("utf8"));
        assert.equal(memo.includes("foreign-day6"), true);
        assert.equal(memo.includes("aether-foundry:f11"), true);
        assert.equal(tx.SourceTag, 77402101);
        return { tx_blob: "BLOB", hash: "C".repeat(64) };
      },
      submit: async () => {
        submitted += 1;
        return { hash: "C".repeat(64), result: "tesSUCCESS" };
      },
      recordOutbound: (row) => {
        recorded.push(row);
        return { appended: true };
      },
    });
    assert.equal(submitted, 0);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].signedTxBlob, "BLOB");
    assert.equal(payloads[0].invoiceId, "foreign-day6");
    assert.equal(Object.prototype.hasOwnProperty.call(payloads[0], "transaction"), false);
    assert.equal(paid.signed, true);
    assert.equal(paid.submitted, false);
    assert.equal(paid.settlement, "shop-settle");
    assert.equal(paid.http_status, 200);
    assert.equal(paid.hash, "C".repeat(64));
    assert.equal(paid.dry_run, false);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].invoice_id, "foreign-day6");
    assert.equal(recorded[0].http_status, 200);
    assert.equal(recorded[0].hash, "C".repeat(64));
  });

  it("submits once when the shop only looks up a validated payment", async () => {
    const payloads = [];
    let submitted = 0;
    const paid = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      ledgerText: "",
      now: new Date("2026-09-29T12:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        if (!init || !init.headers || !init.headers["PAYMENT-SIGNATURE"]) return challenge(FOREIGN);
        const decoded = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]);
        payloads.push(decoded.payload);
        if (payloads.length === 1) {
          return {
            status: 402,
            headers: { get: () => "" },
            text: async () => JSON.stringify({ code: "payment_not_on_ledger", error: "not on ledger" }),
          };
        }
        return {
          status: 200,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ ok: true }),
        };
      },
      sign: async () => ({ tx_blob: "BLOB", hash: "D".repeat(64) }),
      submit: async () => {
        submitted += 1;
        return { hash: "D".repeat(64), result: "tesSUCCESS", ledger_index: 211 };
      },
    });
    assert.equal(submitted, 1);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].invoiceId, "foreign-day6");
    assert.equal(Object.prototype.hasOwnProperty.call(payloads[0], "transaction"), false);
    assert.equal(payloads[1].invoiceId, "foreign-day6");
    assert.equal(payloads[1].transaction, "D".repeat(64));
    assert.equal(paid.settlement, "client-submit");
    assert.equal(paid.submitted, true);
    assert.equal(paid.http_status, 200);
    assert.equal(paid.hash, "D".repeat(64));
    assert.equal(paid.network_id, 1);
  });

  it("counts foreign x402 hits and outbound hits outside WALLETS", () => {
    const foreign = "rForeignPayer1111111111111111111";
    const text = [
      JSON.stringify({ action: "x402_hit", sku: "reserve-audit", hash: "A".repeat(64), payer: foreign, network: "xrpl:1" }),
      JSON.stringify({ action: "x402_hit", sku: "reserve-audit", hash: "A".repeat(64), payer: foreign, network: "xrpl:1" }),
      JSON.stringify({ action: "x402_hit", sku: "reserve-audit", hash: "D".repeat(64), payer: guard.W3_ADDRESS, network: "xrpl:1" }),
      JSON.stringify({ action: "x402_outbound", hash: "B".repeat(64), pay_to: FOREIGN, payer: guard.W3_ADDRESS }),
    ].join("\n");
    const hits = citizen.hitReport(text);
    assert.equal(hits.x402_foreign_hits, 1);
    assert.equal(hits.x402_outbound_hits, 1);
    const src = fs.readFileSync(path.join(ROOT, "src", "x402-citizen-buy.js"), "utf8");
    assert.equal(src.includes("/settle"), false);
  });
});

function liveEnv(extra) {
  return Object.assign(
    {
      FOUNDRY_DAEMON_LIVE: "yes",
      CI: "",
      GITHUB_ACTIONS: "",
      AETHER_SECRETS: path.join(os.tmpdir(), "aether-citizen-missing.env"),
    },
    extra || {}
  );
}

function fakeClient(hooks) {
  return {
    networkID: hooks && hooks.networkID != null ? hooks.networkID : 1,
    async autofill(tx) {
      if (hooks && hooks.autofill) return hooks.autofill(tx);
      return Object.assign({}, tx, { Fee: "12", Sequence: 1 });
    },
    async submitAndWait(blob) {
      if (hooks && hooks.submitAndWait) return hooks.submitAndWait(blob);
      return { result: { hash: "D".repeat(64), meta: { TransactionResult: "tesSUCCESS" } } };
    },
    async disconnect() {},
  };
}

describe("W3 regular key signer", () => {
  const packRegular = guard.w3RegularAddress({});

  it("accepts the activated regular key and keeps the payment Account on W3", async () => {
    assert.notEqual(packRegular, guard.W3_ADDRESS);
    assert.doesNotThrow(() =>
      guard.assertW3Signer({ classicAddress: packRegular }, { key_env: "W3_REGULAR_SEED" }, {})
    );
    assert.throws(
      () => guard.assertW3Signer({ classicAddress: guard.W3_ADDRESS }, { key_env: "W3_REGULAR_SEED" }, {}),
      (error) => error.code === "ACCOUNT" && /regular key/.test(error.message)
    );
    let seenSeed = "";
    const report = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
      env: liveEnv({ W3_REGULAR_SEED: "regular-placeholder", W3_SEED: "master-placeholder" }),
      ledgerText: "",
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        if (!init || !init.headers || !init.headers["PAYMENT-SIGNATURE"]) return challenge(FOREIGN);
        const decoded = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]);
        assert.equal(decoded.payload.signedTxBlob, "blob");
        assert.equal(decoded.payload.invoiceId, "foreign-day6");
        assert.equal(Object.prototype.hasOwnProperty.call(decoded.payload, "transaction"), false);
        return {
          status: 200,
          headers: { get: () => "" },
          text: async () => "{}",
        };
      },
      walletFromSeed(seed) {
        seenSeed = seed;
        return {
          classicAddress: packRegular,
          sign(tx) {
            assert.equal(tx.Account, guard.W3_ADDRESS);
            return { tx_blob: "blob", hash: "D".repeat(64) };
          },
        };
      },
      connect: async () => fakeClient({
        submitAndWait() {
          throw new Error("shop-settle must not submit");
        },
      }),
    });
    assert.equal(seenSeed, "regular-placeholder");
    assert.equal(report.signed, true);
    assert.equal(report.submitted, false);
    assert.equal(report.settlement, "shop-settle");
    assert.equal(report.payer, guard.W3_ADDRESS);
    assert.equal(report.key_env, "W3_REGULAR_SEED");
    assert.equal(report.tx.Account, guard.W3_ADDRESS);
    assert.equal(report.hash, "D".repeat(64));
  });

  it("signs with the regular key wallet when W3_REGULAR_ADDRESS matches that classic", async () => {
    const regular = xrpl.Wallet.generate();
    const report = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
      env: liveEnv({
        W3_REGULAR_SEED: regular.seed,
        W3_SEED: xrpl.Wallet.generate().seed,
        W3_REGULAR_ADDRESS: regular.classicAddress,
      }),
      ledgerText: "",
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        if (!init || !init.headers || !init.headers["PAYMENT-SIGNATURE"]) return challenge(FOREIGN);
        const decoded = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]);
        const tx = xrpl.decode(decoded.payload.signedTxBlob);
        assert.equal(tx.Account, guard.W3_ADDRESS);
        assert.notEqual(tx.Account, regular.classicAddress);
        assert.equal(tx.SigningPubKey, regular.publicKey);
        assert.equal(decoded.payload.invoiceId, "foreign-day6");
        return {
          status: 200,
          headers: { get: () => "" },
          text: async () => "{}",
        };
      },
      connect: async (url) => {
        assert.equal(url, guard.XRPL_WS);
        return fakeClient({
          submitAndWait() {
            throw new Error("shop-settle must not submit");
          },
        });
      },
    });
    assert.equal(report.signed, true);
    assert.equal(report.submitted, false);
    assert.equal(report.settlement, "shop-settle");
    assert.match(report.hash, /^[0-9A-F]{64}$/);
    assert.equal(report.key_env, "W3_REGULAR_SEED");
    assert.equal(report.payer, guard.W3_ADDRESS);
    assert.equal(JSON.stringify(report).includes(regular.seed), false);
  });

  it("refuses a regular seed that is not the known regular key, and a master seed that is not W3", async () => {
    const stranger = xrpl.Wallet.generate();
    let connects = 0;
    let submits = 0;
    const connect = async () => {
      connects += 1;
      return fakeClient({
        submitAndWait() {
          submits += 1;
          throw new Error("must not submit");
        },
      });
    };
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: liveEnv({ W3_REGULAR_SEED: stranger.seed, W3_SEED: "master-should-not-be-used" }),
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          connect,
        }),
      (error) => error.code === "ACCOUNT" && /regular key/.test(error.message) && error.message.includes(packRegular)
    );
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: liveEnv({ W3_SEED: stranger.seed }),
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          connect,
        }),
      (error) => error.code === "ACCOUNT" && /W3 CHANNELS/.test(error.message)
    );
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: liveEnv({ W3_REGULAR_SEED: "not-a-seed" }),
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          connect,
        }),
      (error) => error.code === "SEED"
    );
    assert.equal(connects, 3);
    assert.equal(submits, 0);
    const master = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
      env: liveEnv({ W3_SEED: "master-placeholder" }),
      ledgerText: "",
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        if (!init || !init.headers || !init.headers["PAYMENT-SIGNATURE"]) return challenge(FOREIGN);
        return {
          status: 200,
          headers: { get: () => "" },
          text: async () => "{}",
        };
      },
      walletFromSeed(seed) {
        assert.equal(seed, "master-placeholder");
        return {
          classicAddress: guard.W3_ADDRESS,
          sign(tx) {
            assert.equal(tx.Account, guard.W3_ADDRESS);
            return { tx_blob: "blob", hash: "F".repeat(64) };
          },
        };
      },
      connect: async () => fakeClient({
        submitAndWait() {
          throw new Error("shop-settle must not submit");
        },
      }),
    });
    assert.equal(master.signed, true);
    assert.equal(master.key_env, "W3_SEED");
    assert.equal(master.payer, guard.W3_ADDRESS);
  });

  it("refuses CI and a non-testnet websocket before signing", async () => {
    const regular = xrpl.Wallet.generate();
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: liveEnv({ CI: "true", W3_REGULAR_SEED: regular.seed }),
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          connect: async () => {
            throw new Error("should not connect");
          },
        }),
      (error) => error.code === "CI"
    );
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: liveEnv({
            W3_REGULAR_SEED: regular.seed,
            W3_REGULAR_ADDRESS: regular.classicAddress,
            XRPL_WS_URL: "wss://xrplcluster.com",
          }),
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          connect: async () => {
            throw new Error("should not connect");
          },
        }),
      (error) => error.code === "MAINNET"
    );
    await assert.rejects(
      () =>
        citizen.run({
          args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
          env: liveEnv({
            W3_REGULAR_SEED: regular.seed,
            W3_REGULAR_ADDRESS: regular.classicAddress,
          }),
          ledgerText: "",
          fetchImpl: async () => challenge(FOREIGN),
          connect: async () => fakeClient({ networkID: 0 }),
        }),
      (error) => error.code === "invalid_network"
    );
  });

  it("prefers a regular seed in the secrets file over an env master seed", () => {
    const file = path.join(os.tmpdir(), `w3-regular-${process.pid}.env`);
    fs.writeFileSync(file, "W3_REGULAR_SEED=file-regular\nW3_SEED=file-master\n");
    const fromFile = citizen.loadSignerSeed({ AETHER_SECRETS: file, W3_SEED: "env-master" });
    assert.deepEqual(fromFile, { seed: "file-regular", key_env: "W3_REGULAR_SEED" });
    const fromEnv = citizen.loadSignerSeed({
      AETHER_SECRETS: file,
      W3_REGULAR_SEED: "env-regular",
      W3_SEED: "env-master",
    });
    assert.deepEqual(fromEnv, { seed: "env-regular", key_env: "W3_REGULAR_SEED" });
    fs.unlinkSync(file);
    assert.equal(guard.w3RegularAddress({ W3_REGULAR_ADDRESS: `  ${packRegular}  ` }), packRegular);
    assert.throws(
      () => guard.w3RegularAddress({ W3_REGULAR_ADDRESS: guard.W3_ADDRESS }),
      (error) => error.code === "ACCOUNT"
    );
    assert.throws(
      () => guard.w3RegularAddress({ W3_REGULAR_ADDRESS: "not-an-address" }),
      (error) => error.code === "ACCOUNT"
    );
  });
});
