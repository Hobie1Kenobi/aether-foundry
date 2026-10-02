"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const xrpl = require("xrpl");
const guard = require("./x402-outbound-guard");
const record = require("./x402-outbound-record");
const payer = require("./x402-outbound");
const runtimeOutbound = require("./runtime/actions/outbound");
const pub = require("../machines/x402-outbound/foreign-public");
const shop = require("../machines/x402-outbound/foreign-shop");
const rules = require("../web/lib/x402-rules");

const ROOT = path.resolve(__dirname, "..");
const KNOWN = {
  W0: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
  W1: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
  W2: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  W3: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
  W4: "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  W5: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  W6: "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
  AMM: "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w",
  BUYER: "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth",
  STRANGER: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
};

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function spawnPayer(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "x402-outbound.js"), ...args], {
      cwd: ROOT,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function isolatedEnv(extra) {
  return Object.assign(
    {
      PATH: process.env.PATH,
      AETHER_SECRETS: path.join(os.tmpdir(), "aether-outbound-missing.env"),
      CI: "",
      GITHUB_ACTIONS: "",
    },
    extra || {}
  );
}

function challengeServer(payTo, extra) {
  const required = {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    accepts: [
      {
        scheme: "exact",
        network: (extra && extra.network) || "xrpl:1",
        amount: (extra && extra.amount) || "5000",
        asset: "XRP",
        payTo,
        extra: {
          sourceTag: 1,
          invoiceId: "fx-test-invoice",
          diyCostDrops: extra && extra.diy != null ? extra.diy : "0",
        },
      },
    ],
    diyCostDrops: extra && extra.diy != null ? extra.diy : "0",
    resource: { url: "http://challenge.local", mimeType: "application/json" },
  };
  return http.createServer((req, res) => {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": rules.encodeHeader(required),
    });
    res.end(JSON.stringify({ paymentRequired: required, diyCostDrops: required.diyCostDrops }));
  });
}

describe("foundry payTo denylist", () => {
  it("loads every WALLETS anchor and excludes the foreign shop", () => {
    const index = guard.foundryIndex();
    for (const [id, address] of Object.entries(KNOWN)) {
      assert.equal(index.get(address), id);
      assert.throws(() => guard.assertForeignPayTo(address, index), /refusing Foundry payTo/);
    }
    assert.equal(index.has(pub.FOREIGN_ADDRESS), false);
    assert.doesNotThrow(() => guard.assertForeignPayTo(pub.FOREIGN_ADDRESS, index));
    assert.equal(pub.FOREIGN_ADDRESS === guard.W3_ADDRESS, false);
  });
});

describe("outbound accept parsing", () => {
  it("requires xrpl:1 exact XRP and refuses mainnet", () => {
    assert.throws(
      () =>
        guard.selectAccept({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "xrpl:0", amount: "5000", asset: "XRP", payTo: "rX" }],
        }),
      /refusing mainnet xrpl:0/
    );
    const accept = guard.selectAccept({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "xrpl:1",
          amount: "5000",
          asset: "XRP",
          payTo: pub.FOREIGN_ADDRESS,
          extra: { sourceTag: pub.SKU.sourceTag, invoiceId: "fx-foreign-oracle-ping-test" },
        },
      ],
    });
    assert.equal(accept.payTo, pub.FOREIGN_ADDRESS);
    assert.equal(accept.amount, "5000");
  });

  it("decodes a PAYMENT-REQUIRED header", () => {
    const required = shop.buildRequired({
      resourceUrl: "http://127.0.0.1:8787/foreign-oracle-ping",
      invoiceId: "fx-foreign-oracle-ping-test",
    });
    const parsed = guard.parsePaymentRequired(rules.encodeHeader(required), "");
    assert.equal(parsed.accepts[0].network, "xrpl:1");
    assert.equal(parsed.accepts[0].payTo, pub.FOREIGN_ADDRESS);
  });

  it("binds amount, SourceTag, and invoice on the Payment", () => {
    const accept = guard.selectAccept(
      shop.buildRequired({
        resourceUrl: "http://127.0.0.1/foreign-oracle-ping",
        invoiceId: "fx-foreign-oracle-ping-test",
      })
    );
    const tx = guard.buildPaymentTx({ account: guard.W3_ADDRESS, accept });
    assert.equal(tx.Destination, pub.FOREIGN_ADDRESS);
    assert.equal(tx.Amount, "5000");
    assert.equal(tx.SourceTag, pub.SKU.sourceTag);
    const memo = Buffer.from(tx.Memos[0].Memo.MemoData, "hex").toString("utf8");
    assert.equal(memo, "fx-foreign-oracle-ping-test");
    assert.equal(tx.Account, guard.W3_ADDRESS);
  });
});

describe("cheapness gate", () => {
  it("prints too expensive vs DIY when the ask is above the ceiling", () => {
    const stated = guard.statedDiyDrops(
      { diyCostDrops: "0" },
      { extra: { diyCostDrops: "0" }, amount: "5000" },
      null
    );
    const ceiling = guard.resolveCeiling({ maxDropsFlag: null, envMax: null, statedDiy: stated });
    assert.equal(ceiling.ceiling, "0");
    const verdict = guard.priceVerdict("5000", ceiling.ceiling);
    assert.equal(verdict.pay, false);
    assert.equal(verdict.message, "too expensive vs DIY");
    const raised = guard.resolveCeiling({
      maxDropsFlag: "10000",
      envMax: "1",
      statedDiy: "0",
    });
    assert.equal(raised.ceiling, "10000");
    assert.equal(guard.priceVerdict("5000", raised.ceiling).pay, true);
    assert.equal(guard.priceVerdict("5000", "5000").pay, true);
  });
});

describe("x402 outbound record", () => {
  it("appends one real hash and refuses Foundry payTo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-outbound-"));
    const paths = {
      logPath: path.join(dir, "ledger-log.jsonl"),
      pnlPath: path.join(dir, "pnl.md"),
    };
    fs.writeFileSync(paths.pnlPath, "| x402_outbound_hits | 0 | |\n");
    const event = {
      hash: "ab".repeat(32),
      pay_to: pub.FOREIGN_ADDRESS,
      resource_url: "http://127.0.0.1/foreign-oracle-ping",
      amount_drops: "5000",
      network: "xrpl:1",
    };
    const first = record.recordOutbound(event, paths);
    assert.equal(first.appended, true);
    assert.equal(first.count, 1);
    assert.match(fs.readFileSync(paths.pnlPath, "utf8"), /\| x402_outbound_hits \| 1 \|/);
    const second = record.recordOutbound(event, paths);
    assert.equal(second.appended, false);
    assert.equal(second.count, 1);
    assert.throws(
      () => record.normalize({ hash: "cd".repeat(32), pay_to: KNOWN.W3, network: "xrpl:1" }),
      /Foundry payTo/
    );
    assert.throws(
      () =>
        record.normalize({
          hash: "cd".repeat(32),
          pay_to: pub.FOREIGN_ADDRESS,
          network: "xrpl:0",
        }),
      /mainnet/
    );
  });
});

describe("seed loading", () => {
  it("reads W3_SEED from a secrets file and does not require other seed names", () => {
    const file = path.join(os.tmpdir(), `w3-only-${process.pid}.env`);
    fs.writeFileSync(file, "FOREIGN_SEED=not-the-payer\nW3_SEED=from-file\n");
    assert.equal(payer.loadW3Seed({ AETHER_SECRETS: file, W3_SEED: "" }), "from-file");
    assert.equal(payer.loadW3Seed({ W3_SEED: "from-env", AETHER_SECRETS: file }), "from-env");
    fs.writeFileSync(file, "W3_REGULAR_SEED=file-regular\nW3_SEED=file-master\n");
    assert.deepEqual(guard.loadW3SignerSeed({ AETHER_SECRETS: file, W3_SEED: "env-master" }), {
      seed: "file-regular",
      key_env: "W3_REGULAR_SEED",
    });
    fs.unlinkSync(file);
    const pack = guard.w3RegularAddress({});
    assert.notEqual(pack, guard.W3_ADDRESS);
    const checked = guard.assertW3Signer({ classicAddress: pack }, { key_env: "W3_REGULAR_SEED" }, {});
    assert.equal(checked.account, guard.W3_ADDRESS);
    assert.equal(checked.signer, pack);
    assert.throws(
      () => guard.assertW3Signer({ classicAddress: pack }, { key_env: "W3_SEED" }, {}),
      (error) => error.code === "ACCOUNT" && /W3 CHANNELS/.test(error.message)
    );
  });

  it("does not log a seed from the payer source", () => {
    const src = fs.readFileSync(path.join(__dirname, "x402-outbound.js"), "utf8");
    assert.match(src, /fromSeed/);
    assert.doesNotMatch(src, /console\.(log|error)\([^)\n]*[Ss]eed/);
    const shopDir = path.join(ROOT, "machines", "x402-outbound");
    for (const name of fs.readdirSync(shopDir)) {
      if (!name.endsWith(".js")) continue;
      const text = fs.readFileSync(path.join(shopDir, name), "utf8");
      assert.doesNotMatch(text, /fromSeed|Wallet\.sign/, name);
    }
  });
});

describe("foreign agent shop", () => {
  it("unpaid GET is 402 to the foreign address", async () => {
    const server = shop.createServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/foreign-oracle-ping`);
      const text = await res.text();
      assert.equal(res.status, 402);
      const header = res.headers.get("payment-required");
      const required = rules.decodeHeader(header);
      assert.equal(required.x402Version, 2);
      assert.equal(required.accepts[0].network, "xrpl:1");
      assert.equal(required.accepts[0].payTo, pub.FOREIGN_ADDRESS);
      assert.equal(required.accepts[0].amount, "5000");
      assert.equal(required.diyCostDrops, "0");
      const body = JSON.parse(text);
      assert.equal(body.foundry_revenue, false);
      assert.equal(body.shop, "foreign-agent");
    } finally {
      await close(server);
    }
  });

  it("returns ledger_index work after a matching proof", async () => {
    const invoice = "fx-foreign-oracle-ping-test";
    const hash = "AB".repeat(32);
    const required = shop.buildRequired({
      resourceUrl: "http://shop.local/foreign-oracle-ping",
      invoiceId: invoice,
    });
    const tx = {
      hash,
      validated: true,
      TransactionType: "Payment",
      Account: guard.W3_ADDRESS,
      Destination: pub.FOREIGN_ADDRESS,
      Amount: pub.SKU.drops,
      SourceTag: pub.SKU.sourceTag,
      LastLedgerSequence: 21000000,
      NetworkID: 1,
      Memos: [
        {
          Memo: {
            MemoData: Buffer.from(invoice, "utf8").toString("hex").toUpperCase(),
          },
        },
      ],
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: pub.SKU.drops },
      ledger_index: 211,
    };
    const signature = rules.encodeHeader({
      x402Version: 2,
      accepted: required.accepts[0],
      payload: { transaction: hash },
    });
    const result = await shop.handleForeignRequest({
      method: "GET",
      url: "/foreign-oracle-ping",
      headers: { "payment-signature": signature },
      resourceUrl: "http://shop.local/foreign-oracle-ping",
      lookupTx: async () => ({ found: true, tx }),
      ledgerIndex: async () => 21099390,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.work, "foreign-oracle-ping");
    assert.equal(result.body.ledger_index, 21099390);
    assert.equal(result.body.foundry_revenue, false);
    assert.equal(result.body.pay_to, pub.FOREIGN_ADDRESS);
  });

  it("refuses a proof that pays W3", async () => {
    const invoice = "fx-foreign-oracle-ping-test";
    const hash = "CD".repeat(32);
    const required = shop.buildRequired({
      resourceUrl: "http://shop.local/foreign-oracle-ping",
      invoiceId: invoice,
    });
    const accepted = Object.assign({}, required.accepts[0], { payTo: guard.W3_ADDRESS });
    const signature = rules.encodeHeader({
      x402Version: 2,
      accepted,
      payload: { transaction: hash },
    });
    const result = await shop.handleForeignRequest({
      method: "GET",
      url: "/foreign-oracle-ping",
      headers: { "payment-signature": signature },
      lookupTx: async () => {
        throw new Error("lookup should not run");
      },
    });
    assert.equal(result.status, 402);
    assert.equal(result.body.code, "destination_mismatch");
  });
});

describe("outbound CLI", () => {
  let foreign;
  let foreignPort;

  before(async () => {
    foreign = shop.createServer();
    foreignPort = await listen(foreign);
  });

  after(async () => {
    await close(foreign);
  });

  it("refuses CI before signing", async () => {
    const result = await spawnPayer(["--url", "http://127.0.0.1/unused", "--max-drops", "10000"], {
      PATH: process.env.PATH,
      CI: "true",
      GITHUB_ACTIONS: "",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to sign under CI/);
  });

  it("refuses a Foundry payTo", async () => {
    const server = challengeServer(KNOWN.W3);
    const port = await listen(server);
    try {
      const result = await spawnPayer(
        [
          "--url",
          `http://127.0.0.1:${port}/sku`,
          "--max-drops",
          "10000",
          "--dry-run",
        ],
        isolatedEnv()
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /refusing Foundry payTo/);
      assert.match(result.stderr, /W3/);
    } finally {
      await close(server);
    }
  });

  it("refuses mainnet xrpl:0", async () => {
    const server = challengeServer(pub.FOREIGN_ADDRESS, { network: "xrpl:0" });
    const port = await listen(server);
    try {
      const result = await spawnPayer(
        ["--url", `http://127.0.0.1:${port}/sku`, "--dry-run"],
        isolatedEnv()
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /refusing mainnet xrpl:0/);
    } finally {
      await close(server);
    }
  });

  it("exits unpaid when the foreign ask is above DIY", async () => {
    const result = await spawnPayer(
      ["--url", `http://127.0.0.1:${foreignPort}/foreign-oracle-ping`],
      isolatedEnv()
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /too expensive vs DIY/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /paid /);
  });

  it("dry-run plans a foreign payment and does not invent a hash", async () => {
    const result = await spawnPayer(
      [
        "--url",
        `http://127.0.0.1:${foreignPort}/foreign-oracle-ping`,
        "--max-drops",
        "10000",
        "--dry-run",
      ],
      isolatedEnv({ CI: "true", W3_SEED: "not-a-real-seed" })
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run/);
    assert.match(result.stdout, new RegExp(pub.FOREIGN_ADDRESS));
    assert.match(result.stdout, /drops 5000/);
    assert.match(result.stdout, /no tx hash \(not submitted\)/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not-a-real-seed/);
  });

  it("refuses a regular key seed that is not the W3 regular key before connecting", async () => {
    const regular = xrpl.Wallet.generate();
    const other = xrpl.Wallet.generate();
    const url = `http://127.0.0.1:${foreignPort}/foreign-oracle-ping`;
    const result = await spawnPayer(
      ["--url", url, "--max-drops", "10000"],
      isolatedEnv({
        W3_REGULAR_SEED: regular.seed,
        W3_SEED: other.seed,
        W3_REGULAR_ADDRESS: other.classicAddress,
      })
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular key/);
    assert.match(result.stderr, new RegExp(other.classicAddress));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /paid /);
    assert.equal(`${result.stdout}${result.stderr}`.includes(regular.seed), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(other.seed), false);
  });

  it("refuses a master seed whose classic address is not W3", async () => {
    const master = xrpl.Wallet.generate();
    const url = `http://127.0.0.1:${foreignPort}/foreign-oracle-ping`;
    const result = await spawnPayer(
      ["--url", url, "--max-drops", "10000"],
      isolatedEnv({ W3_SEED: master.seed })
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /W3 CHANNELS/);
    assert.match(result.stderr, new RegExp(guard.W3_ADDRESS));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /paid /);
    assert.equal(`${result.stdout}${result.stderr}`.includes(master.seed), false);
  });

  it("asks for W3_SEED and prints the one-click when the ceiling allows a pay", async () => {
    const url = `http://127.0.0.1:${foreignPort}/foreign-oracle-ping`;
    const result = await spawnPayer(["--url", url, "--max-drops", "10000", "--record"], isolatedEnv());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /W3_REGULAR_SEED or W3_SEED is not loaded/);
    assert.match(result.stderr, /npm run x402:foreign/);
    assert.match(result.stderr, /npm run x402:outbound -- --url /);
    assert.match(result.stderr, /--record/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /paid /);
  });
});

function jsonReply(status, body) {
  return {
    status,
    headers: { get: () => "" },
    text: async () => JSON.stringify(body),
  };
}

describe("PAYMENT-SIGNATURE invoiceId", () => {
  const accept = {
    scheme: "exact",
    network: "xrpl:1",
    amount: "1000",
    asset: "XRP",
    payTo: pub.FOREIGN_ADDRESS,
    extra: { sourceTag: 20260908, invoiceId: "02DEA90ED40A4CFFB8A774C6F74B0109" },
  };

  it("echoes accept.extra.invoiceId and keeps the signed blob", () => {
    const payload = guard.buildSignaturePayload({
      required: { resource: { url: "https://x402.example/sku" } },
      accept,
      txBlob: "BLOB",
      hash: "AB".repeat(32),
    });
    assert.equal(payload.x402Version, 2);
    assert.equal(payload.payload.signedTxBlob, "BLOB");
    assert.equal(payload.payload.transaction, "AB".repeat(32));
    assert.equal(payload.payload.invoiceId, "02DEA90ED40A4CFFB8A774C6F74B0109");
  });

  it("omits invoiceId and transaction when the challenge has neither", () => {
    const payload = guard.buildSignaturePayload({
      required: {},
      accept: { payTo: pub.FOREIGN_ADDRESS, amount: "1000", extra: {} },
      txBlob: "BLOB",
    });
    assert.equal(payload.payload.signedTxBlob, "BLOB");
    assert.equal(Object.prototype.hasOwnProperty.call(payload.payload, "invoiceId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.payload, "transaction"), false);
  });

  it("shop-settle returns 200 without submitting", async () => {
    let submits = 0;
    const seen = [];
    const delivered = await guard.deliverForeignPayment({
      resourceUrl: "https://x402.example/sku",
      required: { resource: { url: "https://x402.example/sku" } },
      accept,
      txBlob: "BLOB",
      hash: "C".repeat(64),
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        seen.push(rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]).payload);
        return jsonReply(200, { ok: true });
      },
      submit: async () => {
        submits += 1;
        return { hash: "C".repeat(64), result: "tesSUCCESS" };
      },
    });
    assert.equal(submits, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].signedTxBlob, "BLOB");
    assert.equal(seen[0].invoiceId, accept.extra.invoiceId);
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0], "transaction"), false);
    assert.equal(delivered.mode, "shop-settle");
    assert.equal(delivered.submitted, false);
    assert.equal(delivered.http_status, 200);
    assert.equal(delivered.hash, "C".repeat(64));
  });

  it("does not submit when the shop rejects the signature", async () => {
    let submits = 0;
    const delivered = await guard.deliverForeignPayment({
      resourceUrl: "https://x402.example/sku",
      accept,
      txBlob: "BLOB",
      hash: "C".repeat(64),
      sleep: async () => {},
      fetchImpl: async () => jsonReply(400, { error: "missing_invoiceId" }),
      submit: async () => {
        submits += 1;
        return { hash: "C".repeat(64), result: "tesSUCCESS" };
      },
    });
    assert.equal(submits, 0);
    assert.equal(delivered.mode, "refused");
    assert.equal(delivered.submitted, false);
    assert.equal(delivered.http_status, 400);
    assert.equal(delivered.hash, null);
  });

  it("retries a POST body on the signature and again after payment_not_on_ledger", async () => {
    const body = { subject: guard.W3_ADDRESS };
    const seen = [];
    let submits = 0;
    const delivered = await guard.deliverForeignPayment({
      resourceUrl: "https://verify.sciphr.io/v1/credential/verify",
      method: "POST",
      body,
      accept,
      txBlob: "BLOB",
      hash: "E".repeat(64),
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init.method, body: init.body });
        assert.equal(init.method, "POST");
        assert.equal(init.body, JSON.stringify(body));
        assert.equal(init.headers["Content-Type"], "application/json");
        const payload = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]).payload;
        if (seen.length === 1) {
          assert.equal(Object.prototype.hasOwnProperty.call(payload, "transaction"), false);
          return jsonReply(402, { code: "payment_not_on_ledger" });
        }
        assert.equal(payload.transaction, "E".repeat(64));
        assert.equal(payload.invoiceId, accept.extra.invoiceId);
        return jsonReply(200, { ok: true });
      },
      submit: async () => {
        submits += 1;
        return { hash: "E".repeat(64), result: "tesSUCCESS" };
      },
    });
    assert.equal(submits, 1);
    assert.equal(seen.length, 2);
    assert.equal(seen.every((call) => call.method === "POST" && call.body === JSON.stringify(body)), true);
    assert.equal(delivered.mode, "client-submit");
    assert.equal(delivered.http_status, 200);
    assert.throws(
      () => guard.resourceRequest({ url: "https://foreign.example/sku", method: "PUT" }),
      (error) => error.code === "PARSE"
    );
    assert.throws(
      () => guard.resourceRequest({ url: "https://foreign.example/sku", body: { subject: "r" } }),
      (error) => error.code === "PARSE"
    );
  });

  it("submits once after payment_not_on_ledger and retries with the hash", async () => {
    let submits = 0;
    const seen = [];
    const delivered = await guard.deliverForeignPayment({
      resourceUrl: "https://x402.example/sku",
      accept,
      txBlob: "BLOB",
      hash: "E".repeat(64),
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        const payload = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]).payload;
        seen.push(payload);
        if (seen.length === 1) return jsonReply(402, { code: "payment_not_on_ledger" });
        return jsonReply(200, { ok: true, ledger_index: 88 });
      },
      submit: async () => {
        submits += 1;
        return { hash: "E".repeat(64), result: "tesSUCCESS", ledger_index: 87 };
      },
    });
    assert.equal(submits, 1);
    assert.equal(seen[0].invoiceId, accept.extra.invoiceId);
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0], "transaction"), false);
    assert.equal(seen[1].transaction, "E".repeat(64));
    assert.equal(seen[1].invoiceId, accept.extra.invoiceId);
    assert.equal(delivered.mode, "client-submit");
    assert.equal(delivered.submitted, true);
    assert.equal(delivered.http_status, 200);
    assert.equal(delivered.ledger_index, 88);
    assert.equal(delivered.hash, "E".repeat(64));
  });

  it("desk buyer still submits before the signature helper", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "x402-pay.js"), "utf8");
    const submitAt = src.indexOf("submitAndWait");
    const payloadAt = src.indexOf("buildSignaturePayload");
    assert.ok(submitAt > 0);
    assert.ok(payloadAt > submitAt);
    for (const file of ["src/x402-outbound.js", "src/x402-citizen-buy.js"]) {
      const payerSrc = fs.readFileSync(path.join(ROOT, file), "utf8");
      const deliverAt = payerSrc.indexOf("deliverForeignPayment");
      const waitAt = payerSrc.indexOf("submitAndWait");
      assert.ok(deliverAt > 0, file);
      assert.ok(waitAt > deliverAt, file);
      assert.equal(payerSrc.indexOf("submitAndWait", waitAt + 1), -1, file);
    }
    const runtimeSrc = fs.readFileSync(path.join(ROOT, "src", "runtime", "actions", "outbound.js"), "utf8");
    assert.ok(runtimeSrc.includes("deliverForeignPayment"));
    assert.equal(runtimeSrc.includes("submitAndWait"), false);
  });
});

describe("runtime outbound shop-settle", () => {
  const required = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "xrpl:1",
        amount: "5000",
        asset: "XRP",
        payTo: pub.FOREIGN_ADDRESS,
        extra: { sourceTag: 1, invoiceId: "fx-runtime-invoice" },
      },
    ],
  };

  function state() {
    return {
      wallets: { W3: { regular_key: "rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q" } },
      watched: { batch: { atomic_enabled: false } },
    };
  }

  it("records HTTP 200 without submitBlob when the shop settles", async () => {
    let submits = 0;
    const recorded = [];
    const done = await runtimeOutbound.execute({
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      state: state(),
      now: new Date("2026-09-29T12:00:00.000Z"),
      history: [],
      required,
      resourceUrl: "https://foreign.example/sku",
      sleep: async () => {},
      sign: async (tx) => {
        assert.equal(tx.Destination, pub.FOREIGN_ADDRESS);
        assert.equal(tx.Amount, "5000");
        return { tx_blob: "BLOB", hash: "C".repeat(64) };
      },
      submitBlob: async () => {
        submits += 1;
        return { hash: "C".repeat(64), result: "tesSUCCESS" };
      },
      fetchImpl: async (_url, init) => {
        const payload = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]).payload;
        assert.equal(payload.invoiceId, "fx-runtime-invoice");
        assert.equal(payload.signedTxBlob, "BLOB");
        assert.equal(Object.prototype.hasOwnProperty.call(payload, "transaction"), false);
        return jsonReply(200, { ok: true });
      },
      archive: () => {},
      recordOutbound: (row) => recorded.push(row),
    });
    assert.equal(submits, 0);
    assert.equal(done.settlement, "shop-settle");
    assert.equal(done.submitted, false);
    assert.equal(done.http_status, 200);
    assert.equal(done.hash, "C".repeat(64));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].invoice_id, "fx-runtime-invoice");
    assert.equal(recorded[0].action, "x402_outbound");
  });

  it("uses submitBlob only after payment_not_on_ledger", async () => {
    let submits = 0;
    let calls = 0;
    const done = await runtimeOutbound.execute({
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      state: state(),
      now: new Date("2026-09-29T12:00:00.000Z"),
      history: [],
      required,
      resourceUrl: "https://foreign.example/sku",
      sleep: async () => {},
      sign: async () => ({ tx_blob: "BLOB", hash: "E".repeat(64) }),
      submitBlob: async (blob) => {
        submits += 1;
        assert.equal(blob, "BLOB");
        return { hash: "E".repeat(64), result: "tesSUCCESS", ledger_index: 12 };
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonReply(402, { code: "payment_not_on_ledger" });
        return jsonReply(200, { ok: true });
      },
      archive: () => {},
      recordOutbound: () => {},
    });
    assert.equal(submits, 1);
    assert.equal(done.settlement, "client-submit");
    assert.equal(done.submitted, true);
    assert.equal(done.http_status, 200);
  });

  it("probes and pays a filed POST candidate with the same JSON body", async () => {
    const url = "https://verify.sciphr.io/v1/did/resolve";
    const body = JSON.stringify({ account: guard.W3_ADDRESS });
    const calls = [];
    const required = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "xrpl:1",
          amount: "2000",
          asset: "XRP",
          payTo: pub.FOREIGN_ADDRESS,
          extra: { sourceTag: 804681468, invoiceId: "post-body" },
        },
      ],
    };
    const done = await runtimeOutbound.execute({
      env: { FOUNDRY_DAEMON_LIVE: "yes", CI: "", GITHUB_ACTIONS: "" },
      state: state(),
      now: new Date("2026-09-29T12:00:00.000Z"),
      history: [],
      resourceUrl: url,
      sleep: async () => {},
      sign: async (tx) => {
        assert.equal(tx.Amount, "2000");
        assert.equal(tx.Destination, pub.FOREIGN_ADDRESS);
        return { tx_blob: "BLOB", hash: "C".repeat(64) };
      },
      submitBlob: async () => {
        throw new Error("shop-settle must not submit");
      },
      fetchImpl: async (target, init) => {
        calls.push({ target, method: init.method, body: init.body, signed: Boolean(init.headers["PAYMENT-SIGNATURE"]) });
        assert.equal(target, url);
        assert.equal(init.method, "POST");
        assert.equal(init.body, body);
        if (!init.headers["PAYMENT-SIGNATURE"]) {
          return {
            status: 402,
            headers: {
              get(name) {
                return String(name).toLowerCase() === "payment-required" ? rules.encodeHeader(required) : "";
              },
            },
            text: async () => JSON.stringify(required),
          };
        }
        const payload = rules.decodeHeader(init.headers["PAYMENT-SIGNATURE"]).payload;
        assert.equal(payload.invoiceId, "post-body");
        assert.equal(payload.signedTxBlob, "BLOB");
        assert.equal(Object.prototype.hasOwnProperty.call(payload, "transaction"), false);
        return jsonReply(200, { ok: true });
      },
      archive: () => {},
      recordOutbound: () => {},
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signed, false);
    assert.equal(calls[1].signed, true);
    assert.equal(calls.every((call) => call.method === "POST" && call.body === body), true);
    assert.equal(done.settlement, "shop-settle");
    assert.equal(done.submitted, false);
    assert.equal(done.http_status, 200);
    assert.equal(done.hash, "C".repeat(64));
  });
});
