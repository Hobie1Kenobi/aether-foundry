"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const guard = require("./xahau-split-guard");

const ROOT = path.resolve(__dirname, "..");

describe("w7 split math", () => {
  it("splits 1 XAH into 40/25/20/10 and a 5% sink", () => {
    const split = guard.splitDrops(1_000_000);
    assert.equal(split.action, "split");
    assert.equal(split.shares.MARKET, 400_000n);
    assert.equal(split.shares.ATELIER, 250_000n);
    assert.equal(split.shares.RESEARCH, 200_000n);
    assert.equal(split.shares.GRANTS, 100_000n);
    assert.equal(split.shares.SINK, 50_000n);
    assert.equal(split.emitted, 1_000_000n);
    assert.equal(split.kept, 0n);
  });

  it("gives the odd drop to the sink", () => {
    const split = guard.splitDrops(1_000_001n);
    const sum = Object.values(split.shares).reduce((acc, n) => acc + n, 0n);
    assert.equal(sum, 1_000_001n);
    assert.equal(split.shares.SINK, 50_001n);
    assert.equal(split.shares.MARKET, 400_000n);
  });

  it("keeps dust below 0.1 XAH on the treasury", () => {
    const under = guard.splitDrops(99_999);
    assert.equal(under.action, "keep");
    assert.equal(under.emitted, 0n);
    assert.equal(under.kept, 99_999n);
    const edge = guard.splitDrops(100_000n);
    assert.equal(edge.action, "split");
    assert.equal(edge.emitted, 100_000n);
    assert.equal(edge.shares.MARKET, 40_000n);
    assert.equal(edge.shares.SINK, 5_000n);
  });

  it("matches floor division on a supply-sized amount without overflowing", () => {
    const drops = 100_000_000_000_000_000n;
    const split = guard.splitDrops(drops);
    assert.equal(split.emitted, drops);
    assert.equal(split.shares.MARKET, (drops / 10000n) * 4000n);
    assert.equal(split.shares.SINK, drops / 20n);
  });

  it("rejects negative drops", () => {
    assert.throws(() => guard.splitDrops(-1), /drops/);
  });
});

describe("w7 hook masks", () => {
  it("fires only on Payment and can emit only Payment", () => {
    const on = guard.hookOnPayment();
    const none = guard.hookOnNone();
    assert.equal(on.length, 64);
    assert.equal(guard.canHookTT(0, on), true);
    for (const tt of [1, 2, 3, 22, 99]) {
      assert.equal(guard.canHookTT(tt, on), false, `tt ${tt}`);
    }
    assert.equal(guard.canHookTT(0, none), false);
    assert.equal(guard.canHookTT(22, none), false);
    assert.equal(guard.bitOf(on, 0), 0);
    assert.equal(guard.bitOf(on, 22), 0);
    assert.equal(guard.bitOf(on, 1), 1);
  });

  it("encodes parameter names as ASCII, including RESEARCH", () => {
    const address = "rNyvdd2DZQRLoG9zJ7oDtp8recCx1dgrqj";
    const book = {
      MARKET: address,
      ATELIER: address,
      RESEARCH: address,
      GRANTS: address,
      SINK: address,
    };
    assert.throws(() => guard.hookParameters(book), /dup|missing|self|ADDR|distinct/);
  });
});

describe("w7 hosts and signing gate", () => {
  it("allows only Xahau Testnet hosts", () => {
    assert.equal(guard.assertXahauTestnetUrl("wss://xahau-test.net"), "wss://xahau-test.net");
    assert.equal(
      guard.assertXahauTestnetUrl("https://xahau-test.net"),
      "https://xahau-test.net"
    );
    for (const bad of [
      "wss://xahau.network",
      "wss://s.altnet.rippletest.net:51233",
      "https://xrplcluster.com",
      "https://s1.ripple.com",
      "wss://testnet.xrpl-labs.com",
    ]) {
      assert.throws(() => guard.assertXahauTestnetUrl(bad), /refusing/);
    }
  });

  it("refuses mainnet network ids", () => {
    assert.equal(guard.assertNetworkId(21338), 21338);
    assert.throws(() => guard.assertNetworkId(21337), /refusing/);
    assert.throws(() => guard.assertNetworkId(0), /refusing/);
  });

  it("refuses CI", () => {
    assert.equal(guard.envIsCi({}), false);
    assert.equal(guard.envIsCi({ CI: "true" }), true);
    assert.equal(guard.envIsCi({ GITHUB_ACTIONS: "true" }), true);
    assert.throws(() => guard.assertCanSign({ CI: "true" }), /CI/);
  });
});

describe("w7 seed decoding", () => {
  it("derives the address from the seed type", () => {
    const xahau = require("xahau");
    const made = xahau.Wallet.generate(xahau.ECDSA.secp256k1);
    const decoded = xahau.decodeSeed(made.seed);
    assert.equal(decoded.type, "secp256k1");
    const again = guard.walletFromSecret(made.seed);
    assert.equal(again.address, made.address);
    const wrongFamily = xahau.Wallet.fromSeed(made.seed);
    assert.notEqual(wrongFamily.address, made.address);
  });
});

describe("w7 payment skeleton", () => {
  it("matches the canonical partial Payment encoding", () => {
    const hex = guard.nativePaymentSkeleton(
      "rNyvdd2DZQRLoG9zJ7oDtp8recCx1dgrqj",
      1000000,
      740
    );
    assert.equal(
      hex,
      "12000023000002E46140000000000F42408314995DB2CBCCA5818EE4A17C50FA78A06BED9160D4"
    );
  });
});

describe("w7 wasm pack", () => {
  it("exports hook and only allowlisted env imports", () => {
    const wasmPath = path.join(ROOT, "hooks", "w7-split", "w7-split.wasm");
    const wasm = fs.readFileSync(wasmPath);
    const info = guard.assertHookWasm(wasm);
    assert.ok(info.exports.some((row) => row.name === "hook"));
    assert.equal(info.start, false);
    assert.deepEqual(info.custom, []);
    const meta = JSON.parse(
      fs.readFileSync(path.join(ROOT, "hooks", "w7-split", "build-meta.json"), "utf8")
    );
    assert.equal(meta.bytes, wasm.length);
    assert.equal(meta.sha256.length, 64);
  });
});

describe("desk stays read-only", () => {
  it("does not sign from the Xahau card", () => {
    const card = fs.readFileSync(
      path.join(ROOT, "web", "components", "XahauSplitCard.tsx"),
      "utf8"
    );
    const pub = fs.readFileSync(path.join(ROOT, "web", "lib", "xrpl-public.ts"), "utf8");
    assert.equal(card.includes("Wallet.sign"), false);
    assert.equal(card.includes("sign("), false);
    assert.equal(pub.includes("XAHAU_W7"), true);
    assert.match(pub, /wss:\/\/xahau-test\.net/);
  });
});
