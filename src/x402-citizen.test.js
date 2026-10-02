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
      "https://x402.cryptobuddy.com.au/crypto/australia/best?asset=XRP&amount=5000&side=buy",
    ]);
    assert.equal(filed.network, "xrpl:1");
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

    const paid = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      ledgerText: "",
      now: new Date("2026-09-29T12:00:00.000Z"),
      fetchImpl: async () => challenge(FOREIGN),
      submit: async (tx) => {
        submitted += 1;
        assert.equal(tx.Account, guard.W3_ADDRESS);
        assert.equal(tx.Destination, FOREIGN);
        assert.equal(tx.Amount, "5000");
        return { hash: "C".repeat(64), result: "tesSUCCESS" };
      },
    });
    assert.equal(submitted, 1);
    assert.equal(paid.signed, true);
    assert.equal(paid.hash, "C".repeat(64));
    assert.equal(paid.dry_run, false);
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
      fetchImpl: async () => challenge(FOREIGN),
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
      connect: async () => fakeClient(),
    });
    assert.equal(seenSeed, "regular-placeholder");
    assert.equal(report.signed, true);
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
      fetchImpl: async () => challenge(FOREIGN),
      connect: async (url) => {
        assert.equal(url, guard.XRPL_WS);
        return fakeClient({
          submitAndWait(blob) {
            const decoded = xrpl.decode(blob);
            assert.equal(decoded.Account, guard.W3_ADDRESS);
            assert.notEqual(decoded.Account, regular.classicAddress);
            assert.equal(decoded.SigningPubKey, regular.publicKey);
            return { result: { hash: "E".repeat(64), ledger_index: 4, meta: { TransactionResult: "tesSUCCESS" } } };
          },
        });
      },
    });
    assert.equal(report.signed, true);
    assert.equal(report.hash, "E".repeat(64));
    assert.equal(report.key_env, "W3_REGULAR_SEED");
    assert.equal(report.payer, guard.W3_ADDRESS);
    assert.equal(JSON.stringify(report).includes(regular.seed), false);
  });

  it("refuses a regular seed that is not the known regular key, and a master seed that is not W3", async () => {
    const stranger = xrpl.Wallet.generate();
    let connects = 0;
    const connect = async () => {
      connects += 1;
      throw new Error("should not connect");
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
    assert.equal(connects, 0);
    const master = await citizen.run({
      args: citizen.parseArgs(["--live", "--url", "https://foreign.example/sku"]),
      env: liveEnv({ W3_SEED: "master-placeholder" }),
      ledgerText: "",
      fetchImpl: async () => challenge(FOREIGN),
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
          return { result: { hash: "F".repeat(64), meta: { TransactionResult: "tesSUCCESS" } } };
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
