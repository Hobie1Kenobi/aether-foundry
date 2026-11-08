"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./config");
const { control, startMission, act, view, publicFeed } = require("./engine");
const { applyChallenge, stampPrepared, beginSubmit, notePresign, noteDeliveryFailure } = require("./submit");
const { bindChallenge, invoiceIdField } = require("./x402-deliver");
const { exactXrplPayment } = require("./x402-exact");
const guard = require("../x402-outbound-guard");
const { sanitizeDiagnostic } = require("./service-result");
const { tick } = require("./worker");

const FOREIGN = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const ISOLATED = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const INVOICE = "inv-1";
const HASH = "AB".repeat(32);
const ECHOED = "ECHOED-SECRET-VALUE";
const BLOB = "ab".repeat(40);

function ledgerDir() {
  const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mission-echo-")), "ledger");
  fs.mkdirSync(ledger);
  control(ledger, {
    action: "activate",
    confirm: config.ACTIVATE_PHRASE,
    token: TOKEN,
    now: NOW,
  }, { token: TOKEN });
  return ledger;
}

function ready(ledger) {
  const started = startMission(ledger, {
    idempotency_key: "echo-bind-1",
    now: NOW,
    observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: FOREIGN }] },
    payment_drops: "100000",
    network_fee_drops: "12",
  }, { allowlist: { payees: [FOREIGN] } });
  return act(ledger, { mission_id: started.mission.id, now: NOW }, { wallet: { address: ISOLATED } }).mission;
}

describe("exact challenge echo", () => {
  it("builds the unsigned xrpl:1 payment without NetworkID or Memos", () => {
    const ledger = ledgerDir();
    const mission = ready(ledger);
    const events = path.join(ledger, "events.jsonl");
    const lines = fs.readFileSync(events, "utf8").trim().split("\n");
    const prior = JSON.parse(lines.filter((line) => line.includes("\"unsigned_tx\"")).at(-1));
    prior.mission.unsigned_tx.Memos = guard.buildPaymentTx({
      account: ISOLATED,
      accept: { payTo: FOREIGN, amount: "100000", extra: { invoiceId: INVOICE, sourceTag: 26100014 } },
    }).Memos;
    prior.mission.unsigned_tx.NetworkID = 1;
    fs.appendFileSync(events, `${JSON.stringify(prior)}\n`);
    const prefix = fs.readFileSync(events, "utf8");
    assert.equal(prefix.includes("\"NetworkID\":1"), true);
    assert.equal(guard.buildPaymentTx({
      account: ISOLATED,
      accept: { payTo: FOREIGN, amount: "100000", extra: { invoiceId: INVOICE, sourceTag: 26100014 } },
    }).Memos.length, 1);

    const bound = bindChallenge({
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      amount: "100000",
      payTo: FOREIGN,
      maxTimeoutSeconds: 300,
      extra: { invoiceId: INVOICE, sourceTag: 26100014 },
    });
    assert.equal(bound.invoiceIdField, invoiceIdField(INVOICE));
    applyChallenge(ledger, {
      mission_id: mission.id,
      now: NOW,
      sourceTag: bound.sourceTag,
      invoiceId: bound.invoiceId,
      invoiceIdField: bound.invoiceIdField,
    });
    const stamped = stampPrepared(ledger, {
      mission_id: mission.id,
      now: NOW,
      sequence: 22117391,
      lastLedgerSequence: 22118889,
    }).mission;
    const begun = beginSubmit(ledger, { mission_id: mission.id, now: NOW });
    const tx = begun.tx;
    assert.equal(Object.prototype.hasOwnProperty.call(tx, "NetworkID"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(tx, "Memos"), false);
    assert.equal(tx.InvoiceID, bound.invoiceIdField);
    assert.equal(tx.SourceTag, 26100014);
    assert.equal(exactXrplPayment(tx, {
      payTo: FOREIGN,
      amount: "100000",
      sourceTag: 26100014,
      invoiceId: INVOICE,
    }).ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(stamped.signed_fields, "NetworkID"), false);
    assert.equal(stamped.signed_fields.InvoiceID, bound.invoiceIdField);
    assert.equal(stamped.signed_fields.memos_present, undefined);
    assert.equal(fs.readFileSync(events, "utf8").startsWith(prefix), true);
    const folded = view(ledger, NOW).missions[mission.id];
    assert.equal(Object.prototype.hasOwnProperty.call(folded.signed_fields, "NetworkID"), false);
    notePresign(ledger, mission.id, HASH, { tx });
    const recorded = view(ledger, NOW).missions[mission.id].signed_fields;
    assert.equal(Object.prototype.hasOwnProperty.call(recorded, "NetworkID"), false);
    assert.equal(recorded.Sequence, 22117391);
    assert.equal(recorded.InvoiceID, bound.invoiceIdField);
  });

  it("rejects an extra field and keeps a supplied areFeesSponsored boolean", () => {
    assert.throws(
      () => bindChallenge({
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        amount: "100000",
        payTo: FOREIGN,
        extra: { invoiceId: INVOICE, sourceTag: 26100014, fee_drops: "999999" },
      }),
      (error) => error.code === "TX"
    );
    const kept = bindChallenge({
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      amount: "100000",
      payTo: FOREIGN,
      extra: { invoiceId: INVOICE, sourceTag: 26100014, areFeesSponsored: false },
    });
    assert.equal(kept.invoiceId, INVOICE);
    assert.throws(
      () => bindChallenge({
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        amount: "100000",
        payTo: FOREIGN,
        extra: { invoiceId: INVOICE, sourceTag: 26100014, areFeesSponsored: "false" },
      }),
      (error) => error.code === "TX"
    );
  });

  it("stores only allowlisted diagnostic tokens from a hostile 402 body", () => {
    const ledger = ledgerDir();
    const mission = ready(ledger);
    applyChallenge(ledger, {
      mission_id: mission.id,
      now: NOW,
      sourceTag: 26100014,
      invoiceId: INVOICE,
      invoiceIdField: invoiceIdField(INVOICE),
    });
    stampPrepared(ledger, {
      mission_id: mission.id,
      now: NOW,
      sequence: 22117391,
      lastLedgerSequence: 22118889,
    });
    beginSubmit(ledger, { mission_id: mission.id, now: NOW });
    notePresign(ledger, mission.id, HASH, {
      tx: {
        TransactionType: "Payment",
        Account: ISOLATED,
        Destination: FOREIGN,
        Amount: "100000",
        Fee: "12",
        Sequence: 22117391,
        LastLedgerSequence: 22118889,
        SourceTag: 26100014,
        InvoiceID: invoiceIdField(INVOICE),
      },
    });
    const hostile = {
      error: "verify_failed",
      invalidReason: "invalid_exact_xrpl_fees_sponsored_unsupported",
      payload: {
        signedTxBlob: BLOB,
        reason: "Not A Token",
        accepted: { extra: { invoiceId: INVOICE, echoed: ECHOED } },
      },
      nested: [{ errorReason: "seller_verify_failed", authorization: ECHOED }],
      reason: ECHOED,
    };
    const before = JSON.stringify(hostile);
    const diagnostic = sanitizeDiagnostic(hostile);
    assert.equal(JSON.stringify(hostile), before);
    assert.equal(diagnostic.invalid_reason, "invalid_exact_xrpl_fees_sponsored_unsupported");
    assert.equal(diagnostic.error_reason, "seller_verify_failed");
    assert.equal(diagnostic.reason, null);
    noteDeliveryFailure(ledger, {
      mission_id: mission.id,
      now: NOW,
      http_status: 402,
      error_code: "verify_failed",
      parsed: hostile,
    });
    const stored = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf8");
    assert.equal(stored.includes(ECHOED), false);
    assert.equal(stored.includes(BLOB), false);
    assert.equal(stored.includes("signedTxBlob"), false);
    assert.equal(stored.includes("Not A Token"), false);
    const feed = publicFeed(ledger, NOW);
    const row = feed.missions.find((item) => item.id === mission.id);
    assert.equal(row.delivery_http_status, 402);
    assert.equal(row.delivery_error_code, "verify_failed");
    assert.equal(row.delivery_invalid_reason, "invalid_exact_xrpl_fees_sponsored_unsupported");
    assert.equal(row.delivery_error_reason, "seller_verify_failed");
    assert.equal(row.delivery_reason, null);
    assert.equal(JSON.stringify(feed).includes(ECHOED), false);
    const day = view(ledger, NOW).days["2026-11-06"];
    assert.equal(day.uncertain, "100012");
    assert.equal(view(ledger, NOW).missions[mission.id].retry_blocked, true);
  });
});

describe("unexpected challenge field", () => {
  it("does not presign when the live extra is not the payment requirement", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mission-echo-tick-"));
    const ledger = path.join(home, "ledger");
    fs.mkdirSync(ledger);
    control(ledger, {
      action: "activate",
      confirm: config.ACTIVATE_PHRASE,
      token: TOKEN,
      now: NOW,
    }, { token: TOKEN });
    const resource = "https://api.stablecoingateways.com/v1/sanctions/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
    fs.writeFileSync(path.join(home, "allowlist.json"), JSON.stringify({ payees: [FOREIGN] }));
    fs.writeFileSync(path.join(home, "discovery.json"), JSON.stringify({
      schema: "aether.missions.discovery",
      network: "xrpl:1",
      network_id: 1,
      items: [{
        id: "echo-bad-01",
        observed_at: NOW,
        resource: { url: resource, method: "GET" },
        x402: {
          x402Version: 2,
          resource,
          accepts: [{
            scheme: "exact",
            network: "xrpl:1",
            asset: "XRP",
            amount: "100000",
            payTo: FOREIGN,
            maxTimeoutSeconds: 300,
            extra: { invoiceId: INVOICE, sourceTag: 26100014 },
          }],
        },
      }],
    }));
    let presigns = 0;
    let fetches = 0;
    const body = await tick({
      home,
      ledger,
      discovery: path.join(home, "discovery.json"),
      allowlist: path.join(home, "allowlist.json"),
      env: {
        FOUNDRY_MISSION_WORKER: "yes",
        FOUNDRY_MISSION_EXECUTE: "yes",
        MISSION_XRPL_ADDRESS: ISOLATED,
      },
      now: NOW,
      quoteFee: async () => ({ fee_drops: "12", quoted_at: NOW, source: "https://testnet.xrpl-labs.com" }),
      preparedAccount: { validated: 22118869, sequence: 22117391 },
      fetch: async () => {
        fetches += 1;
        throw new Error("network");
      },
      resourceFetch: async () => ({
        status: 402,
        json: async () => ({
          x402Version: 2,
          accepts: [{
            scheme: "exact",
            network: "xrpl:1",
            asset: "XRP",
            amount: "100000",
            payTo: FOREIGN,
            maxTimeoutSeconds: 300,
            extra: { invoiceId: INVOICE, sourceTag: 26100014, fee_drops: "999999" },
          }],
        }),
      }),
      presign: async () => {
        presigns += 1;
        return { tx_blob: "BLOB", hash: HASH };
      },
    });
    assert.equal(body.code, "TX");
    assert.equal(presigns, 0);
    assert.equal(fetches, 0);
    const mission = Object.values(view(ledger, NOW).missions)[0];
    assert.equal(mission.hold, "released");
    assert.equal(mission.signed, false);
    assert.equal(view(ledger, NOW).live_spend_drops, "0");
  });
});
