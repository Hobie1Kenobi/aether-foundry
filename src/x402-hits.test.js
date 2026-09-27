"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hits = require("./x402-hits");

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-hits-"));
  return {
    logPath: path.join(dir, "ledger-log.jsonl"),
    pnlPath: path.join(dir, "pnl.md"),
  };
}

describe("x402 hits", () => {
  it("appends once and rewrites the pnl count", () => {
    const paths = tempPaths();
    fs.writeFileSync(paths.pnlPath, "| x402_hits | 0 | |\n");
    const event = {
      x402_hit: {
        sku: "reserve-audit",
        hash: "ab".repeat(32),
        network: "xrpl:1",
        payer: "rBuyer",
        amount_drops: "250000",
      },
    };
    const first = hits.recordHit(event, paths);
    assert.equal(first.appended, true);
    assert.equal(first.count, 1);
    const pnl = fs.readFileSync(paths.pnlPath, "utf8");
    assert.match(pnl, /\| x402_hits \| 1 \|/);
    const second = hits.recordHit(event, paths);
    assert.equal(second.appended, false);
    assert.equal(second.count, 1);
    const lines = fs.readFileSync(paths.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });

  it("refuses a mainnet hit", () => {
    assert.throws(
      () => hits.normalize({ sku: "reserve-audit", hash: "aa".repeat(32), network: "xrpl:0" }),
      /mainnet/
    );
  });
});
