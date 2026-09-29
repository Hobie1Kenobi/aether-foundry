"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
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
    assert.deepEqual(filed.urls, []);
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
