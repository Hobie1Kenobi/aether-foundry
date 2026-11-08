"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const config = require("../missions/config");
const { control, startMission, act, view } = require("../missions/engine");
const { applyChallenge, stampPrepared } = require("../missions/submit");
const { invoiceIdField } = require("../missions/x402-deliver");
const {
  challengeAccept,
  buildFoundryBuyerTx,
  diagnoseOffline,
  classifySupported,
  readHostedSupported,
  HOSTED_SUPPORTED,
} = require("./buyer-diagnostic");
const { packDiagnostic } = require("./pack");

const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const ROOT = path.resolve(__dirname, "..", "..");

function byShape(report, shape) {
  return report.cases.find((row) => row.shape === shape);
}

function byFault(report, shape) {
  return report.faults.find((row) => row.shape === shape);
}

describe("buyer diagnostic", () => {
  it("matches the mission unsigned payment and reports both challenge shapes", async () => {
    const payer = xrpl.Wallet.generate();
    const seller = xrpl.Wallet.generate();
    const invoiceId = "diag-offline-1";
    const accept = challengeAccept("vendor", seller.address, invoiceId);
    const built = buildFoundryBuyerTx({
      accept,
      account: payer.address,
      validatedLedger: 10000,
      sequence: 10,
    });
    const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "buyer-diag-")), "ledger");
    fs.mkdirSync(ledger);
    control(ledger, { action: "activate", confirm: config.ACTIVATE_PHRASE, token: TOKEN, now: NOW }, { token: TOKEN });
    const opened = startMission(ledger, {
      idempotency_key: "diag-buyer-01",
      now: NOW,
      observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: seller.address }] },
      payment_drops: "10",
      network_fee_drops: "10",
    }, { allowlist: { payees: [seller.address] } });
    const acted = act(ledger, { mission_id: opened.mission.id, now: NOW }, { wallet: { address: payer.address } }).mission;
    applyChallenge(ledger, {
      mission_id: acted.id,
      now: NOW,
      sourceTag: 7,
      invoiceId,
      invoiceIdField: invoiceIdField(invoiceId),
    });
    const stamped = stampPrepared(ledger, {
      mission_id: acted.id,
      now: NOW,
      sequence: 10,
      lastLedgerSequence: 10020,
    }).mission;
    assert.deepEqual(stamped.unsigned_tx, built);
    const source = fs.readFileSync(path.join(__dirname, "buyer-diagnostic.js"), "utf8");
    assert.equal(source.includes("stablecoingateways"), false);
    const report = await diagnoseOffline({ wallet: payer, payTo: seller.address, invoiceId, validatedLedger: 10000, sequence: 10 });
    const text = JSON.stringify(report);
    assert.equal(text.includes(payer.seed), false);
    assert.equal(text.includes("signedTxBlob"), false);
    assert.equal(text.includes("PAYMENT-SIGNATURE"), false);
    const vendor = byShape(report, "vendor_missing_areFeesSponsored");
    const official = byShape(report, "official_areFeesSponsored_false");
    assert.equal(vendor.echo_exact, true);
    assert.equal(vendor.are_fees_sponsored_injected, false);
    assert.equal(vendor.tx.network_id_omitted, true);
    assert.equal(vendor.tx.memos_omitted, true);
    assert.equal(vendor.tx.invoice_id_matches_sha256, true);
    assert.equal(vendor.tx.amount_matches, true);
    assert.equal(vendor.tx.destination_matches, true);
    assert.equal(vendor.tx.fee, "10");
    assert.equal(vendor.tx.last_ledger_sequence, 10020);
    assert.equal(vendor.structural.socket, false);
    assert.equal(vendor.structural.envelope_reason, "invalid_exact_xrpl_fees_sponsored_unsupported");
    assert.equal(vendor.official_verify, "not_run");
    assert.equal(vendor.official_settle, "not_run");
    assert.equal(vendor.settled, false);
    assert.equal(official.echo_exact, true);
    assert.equal(official.are_fees_sponsored_injected, false);
    assert.equal(official.structural.envelope_reason, null);
    assert.equal(official.structural.structure_reason, null);
    assert.equal(official.structural.expiry_reason, null);
    assert.equal(official.official_verify, "not_run");
    assert.equal(official.settled, false);
    assert.equal(byFault(report, "amount_mismatch").structural.structure_reason, "invalid_exact_xrpl_payload_amount_mismatch");
    assert.equal(byFault(report, "destination_mismatch").structural.structure_reason, "invalid_exact_xrpl_payload_destination_mismatch");
    assert.equal(byFault(report, "fee_too_high").structural.structure_reason, "invalid_exact_xrpl_payload_fee_too_high");
    assert.equal(byFault(report, "last_ledger_too_large").structural.expiry_reason, "invalid_exact_xrpl_payload_lastledgersequence_too_large");
    assert.equal(byFault(report, "memo_rejected").structural.structure_reason, "invalid_exact_xrpl_payload_memos_not_allowed");
    assert.equal(byFault(report, "network_id_present").structural.structure_reason, "invalid_exact_xrpl_payload_network_id_for_standard_network");
    for (const row of report.faults) {
      assert.equal(row.settled, false);
      assert.equal(row.official_settle, "not_run");
      assert.equal(row.builder, false);
    }
    assert.throws(
      () => buildFoundryBuyerTx({ accept: Object.assign({}, accept, { network: "xrpl:0" }), account: payer.address, validatedLedger: 10000, sequence: 10 }),
      (error) => error.code === "MAINNET"
    );
    assert.throws(
      () => buildFoundryBuyerTx({ accept, account: payer.address, fee: 10001, validatedLedger: 10000, sequence: 10 }),
      (error) => error.code === "FEE_CAP"
    );
  });

  it("classifies a hosted supported document without posting a payment", async () => {
    const fixture = {
      kinds: [
        { x402Version: 2, scheme: "exact", network: "xrpl:1" },
        { x402Version: 2, scheme: "upto", network: "xrpl:1" },
      ],
    };
    const classified = classifySupported(fixture);
    assert.equal(classified.exact_xrpl1, true);
    assert.equal(classified.hosted_verify_called, false);
    assert.equal(classified.endpoint, HOSTED_SUPPORTED);
    let posted = 0;
    const report = await readHostedSupported(async (url, init) => {
      assert.equal(url, HOSTED_SUPPORTED);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.signal.aborted, false);
      if (init.method !== "GET") posted += 1;
      return { ok: true, url: HOSTED_SUPPORTED, json: async () => fixture };
    });
    assert.equal(posted, 0);
    assert.equal(report.exact_xrpl1, true);
    assert.equal(report.seller_called, false);
    await assert.rejects(
      () => readHostedSupported(async () => ({ ok: true, redirected: true, url: HOSTED_SUPPORTED, json: async () => fixture })),
      (error) => error.code === "LEDGER"
    );
    await assert.rejects(
      () => readHostedSupported(async () => ({ ok: true, url: "https://example.com/supported", json: async () => fixture })),
      (error) => error.code === "HOST"
    );
  });

  it("packs the diagnostic sources without secrets", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "buyer-pack-"));
    const result = packDiagnostic({ root: ROOT, outDir: out });
    const names = spawnSync("tar", ["-tf", result.tarPath], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const name of names) {
      assert.equal(/\.env|events\.jsonl|\/lab\/|seed/i.test(name), false, name);
    }
    assert.equal(names.some((name) => name.endsWith("src/diagnostics/buyer-diagnostic.js")), true);
    assert.equal(names.some((name) => name.endsWith("package.json")), true);
    assert.equal(names.some((name) => name.endsWith("package-lock.json")), true);
    assert.equal(names.some((name) => name.endsWith("SHA256SUMS")), true);
    const extract = fs.mkdtempSync(path.join(os.tmpdir(), "buyer-unpack-"));
    assert.equal(spawnSync("tar", ["-xf", result.tarPath, "-C", extract]).status, 0);
    assert.equal(spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: extract }).status, 0);
  });
});
