"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pub = require("./walk-in-public");
const buy = require("./walk-in-buy");
const pay = require("./x402-pay");
const guard = require("./x402-outbound-guard");

const LIVE_OFFER = "AB".repeat(32);
const LIVE_NFT = "CD".repeat(32);
const ACCEPT_HASH = "EF".repeat(32);
const UNLABELED = "rUnlabeledWalkInBuyerxxxx";

function jsonResponse(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { result };
    },
  };
}

function openFetch(offerId = LIVE_OFFER) {
  return async () =>
    jsonResponse({
      status: "success",
      validated: true,
      ledger_index: 21100001,
      account_objects: [
        {
          index: offerId,
          NFTokenID: LIVE_NFT,
          Flags: 1,
          Amount: "10000000",
          Owner: pub.W2,
        },
      ],
    });
}

function soldOutFetch() {
  return async () =>
    jsonResponse({
      status: "success",
      validated: true,
      ledger_index: 21100002,
      account_objects: [],
    });
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "walk-in-buy-"));
}

describe("walk-in buy", () => {
  it("dry-run prints the live offer and does not load a seed", async () => {
    const logs = [];
    let seeded = 0;
    let fetched = 0;
    const code = await buy.run(["node", "buy", "--dry-run"], {
      env: {
        XRPL_HTTP: pub.XRPL_HTTP,
        XRPL_WS_URL: pub.XRPL_WS,
        WALKIN_BUYER_SEED: "sEdNotLoadedOnDryRunxxxxxxxxxx",
        CI: "true",
      },
      fetchImpl: async (url, init) => {
        fetched += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.method, "account_objects");
        assert.equal(body.params[0].type, "nft_offer");
        assert.equal(body.params[0].ledger_index, "validated");
        assert.equal(body.params[0].account, pub.W2);
        return openFetch()();
      },
      walletFromSeed() {
        seeded += 1;
        throw new Error("dry-run loaded a seed");
      },
      existsSync() {
        throw new Error("dry-run read secrets");
      },
      log: (line) => logs.push(String(line)),
      error() {},
    });
    const text = logs.join("\n");
    assert.equal(code, 0);
    assert.equal(fetched, 1);
    assert.equal(seeded, 0);
    assert.match(text, /dry-run/);
    assert.match(text, /signed false/);
    assert.match(text, new RegExp(LIVE_OFFER));
    assert.match(text, new RegExp(LIVE_NFT));
    assert.match(text, /amount 10000000/);
    assert.match(text, /tx NFTokenAcceptOffer/);
    assert.match(text, /buyer not loaded/);
    assert.match(text, /aeth skipped/);
    assert.match(text, /published OfferID is not required/);
    assert.equal(text.includes(pub.KNOWN_OFFER_ID), false);
  });

  it("refuses a Foundry labeled wallet before signing", async () => {
    const errors = [];
    let signed = 0;
    const index = guard.foundryIndex();
    const buyer = index.get("rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth");
    assert.equal(buyer, "BUYER");
    const code = await buy.run(["node", "buy"], {
      env: {
        XRPL_HTTP: pub.XRPL_HTTP,
        XRPL_WS_URL: pub.XRPL_WS,
        WALKIN_BUYER_SEED: "present",
      },
      fetchImpl: openFetch(),
      walletFromSeed() {
        return {
          classicAddress: "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth",
          sign() {
            signed += 1;
            throw new Error("signed");
          },
        };
      },
      connectClient() {
        throw new Error("connected");
      },
      log() {},
      error: (line) => errors.push(String(line)),
    });
    assert.equal(code, buy.EXIT.FOUNDRY);
    assert.equal(signed, 0);
    assert.match(errors.join("\n"), /refusing Foundry wallet BUYER/);
    assert.match(errors.join("\n"), /does not count as walk-in/);
  });

  it("refuses mainnet hosts before discovery", async () => {
    const errors = [];
    let fetched = 0;
    const code = await buy.run(["node", "buy", "--dry-run"], {
      env: {
        XRPL_HTTP: "https://s1.ripple.com:51234",
        XRPL_WS_URL: "wss://xrplcluster.com",
      },
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("fetched");
      },
      log() {},
      error: (line) => errors.push(String(line)),
    });
    assert.equal(code, buy.EXIT.ERROR);
    assert.equal(fetched, 0);
    assert.match(errors.join("\n"), /refusing mainnet/);
  });

  it("exits sold-out when W2 has no sell offer", async () => {
    const errors = [];
    const code = await buy.run(["node", "buy", "--dry-run"], {
      env: { XRPL_HTTP: pub.XRPL_HTTP, XRPL_WS_URL: pub.XRPL_WS },
      fetchImpl: soldOutFetch(),
      log() {},
      error: (line) => errors.push(String(line)),
    });
    assert.equal(code, buy.EXIT.SOLD_OUT);
    assert.equal(code, 3);
    assert.match(errors.join("\n"), /SOLD OUT/);
  });

  it("refuses live signing under CI and GitHub Actions", async () => {
    for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
      const errors = [];
      let seeded = 0;
      const code = await buy.run(["node", "buy"], {
        env: Object.assign({ XRPL_HTTP: pub.XRPL_HTTP, XRPL_WS_URL: pub.XRPL_WS }, env),
        fetchImpl: openFetch(),
        walletFromSeed() {
          seeded += 1;
          return { classicAddress: UNLABELED, sign() {} };
        },
        log() {},
        error: (line) => errors.push(String(line)),
      });
      assert.equal(code, 1);
      assert.equal(seeded, 0);
      assert.match(errors.join("\n"), /refusing to sign under CI/);
    }
  });

  it("refuses NetworkID 0 before sign", async () => {
    let signed = 0;
    const errors = [];
    const code = await buy.run(["node", "buy"], {
      env: {
        XRPL_HTTP: pub.XRPL_HTTP,
        XRPL_WS_URL: pub.XRPL_WS,
        WALKIN_BUYER_SEED: "present",
      },
      fetchImpl: openFetch(),
      walletFromSeed() {
        return {
          classicAddress: UNLABELED,
          sign() {
            signed += 1;
            return { tx_blob: "00" };
          },
        };
      },
      connectClient: async () => ({
        async request() {
          return { result: { info: { network_id: 0 } } };
        },
        async disconnect() {},
      }),
      log() {},
      error: (line) => errors.push(String(line)),
    });
    assert.equal(code, 1);
    assert.equal(signed, 0);
    assert.match(errors.join("\n"), /NetworkID 0/);
  });

  it("records only a submitted accept hash", async () => {
    const root = tempRoot();
    const logs = [];
    const code = await buy.run(["node", "buy", "--record"], {
      env: {
        XRPL_HTTP: pub.XRPL_HTTP,
        XRPL_WS_URL: pub.XRPL_WS,
        WALKIN_BUYER_SEED: "present",
      },
      root,
      now: () => new Date("2026-09-27T22:10:00.000Z"),
      fetchImpl: openFetch(),
      walletFromSeed() {
        return {
          classicAddress: UNLABELED,
          sign() {
            return { tx_blob: "00" };
          },
        };
      },
      connectClient: async () => ({
        async request(req) {
          assert.equal(req.command, "server_info");
          return { result: { info: { network_id: 1 } } };
        },
        async autofill(tx) {
          return Object.assign({ NetworkID: 1, Sequence: 1, Fee: "12" }, tx);
        },
        async submitAndWait() {
          return {
            result: {
              hash: ACCEPT_HASH,
              ledger_index: 21100011,
              meta: { TransactionResult: "tesSUCCESS" },
            },
          };
        },
        async disconnect() {},
      }),
      log: (line) => logs.push(String(line)),
      error() {},
    });
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /aeth skipped/);
    const line = fs.readFileSync(path.join(root, "lab", "ledger-log.jsonl"), "utf8").trim();
    const row = JSON.parse(line);
    assert.equal(row.action, "walk_in_buy");
    assert.equal(row.hash, ACCEPT_HASH);
    assert.equal(row.offer_id, LIVE_OFFER);
    assert.equal(row.buyer, UNLABELED);
    assert.equal(row.aeth, false);
    assert.equal(row.signed, true);
    const results = fs.readFileSync(
      path.join(root, "machines", "walk-in-window", "RESULTS.md"),
      "utf8"
    );
    assert.match(results, new RegExp(ACCEPT_HASH));
    assert.match(results, /not a Foundry labeled wallet/i);

    const errors = [];
    const refused = await buy.run(["node", "buy", "--dry-run", "--record"], {
      env: { XRPL_HTTP: pub.XRPL_HTTP, XRPL_WS_URL: pub.XRPL_WS },
      fetchImpl: openFetch(),
      root,
      log() {},
      error: (line) => errors.push(String(line)),
    });
    assert.equal(refused, 1);
    assert.match(errors.join("\n"), /--record needs a submitted hash/);
    const still = fs.readFileSync(path.join(root, "lab", "ledger-log.jsonl"), "utf8").trim().split("\n");
    assert.equal(still.length, 1);
  });

  it("does not embed the published OfferID or a seed", () => {
    const src = fs.readFileSync(path.join(__dirname, "walk-in-buy.js"), "utf8");
    assert.equal(src.includes(pub.KNOWN_OFFER_ID), false);
    assert.doesNotMatch(src, /sEd[1-9A-HJ-NP-Za-km-z]{15,}/);
  });

  it("refuses W3 as the x402 desk buyer", () => {
    assert.throws(
      () => pay.assertNotCircularBuyer("rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw", "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw"),
      /circular/
    );
    assert.doesNotThrow(() =>
      pay.assertNotCircularBuyer("rUnlabeledWalkInBuyerxxxx", "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw")
    );
  });
});

describe("inbound MCP schema", () => {
  it("exposes inbound tools without seed arguments", () => {
    const file = path.join(__dirname, "..", "machines", "inbound-mcp", "tools.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const names = doc.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "walk_in_status",
      "walk_in_buy",
      "x402_catalog",
      "x402_buy",
      "director_status",
      "grant_eligibility",
      "amm_quote",
    ]);
    const blob = JSON.stringify(doc.tools.map((tool) => tool.inputSchema));
    assert.doesNotMatch(blob, /seed|secret|private/i);
    const status = doc.tools[0];
    const walkBuy = doc.tools[1];
    assert.equal(status.annotations.readOnlyHint, true);
    assert.equal(status.binding.seeds, false);
    assert.match(walkBuy.binding.command, /npm run buy:walk-in/);
    assert.equal(walkBuy.binding.seedsInArguments, false);
    assert.match(doc.tools[3].binding.command, /npm run x402:pay/);
    assert.match(doc.tools[3].description, /W3/);
  });
});
