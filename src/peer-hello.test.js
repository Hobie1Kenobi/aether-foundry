"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hello = require("./peer-hello");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "peer-hello-account-tx.json");
const STRANGER = "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss";
const FOREIGN = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
const NOW = new Date("2026-10-06T01:36:00.123Z");
const SEEN = "2026-10-06T01:36:00Z";

function hex(text) {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peer-hello-"));
}

function payment(opts) {
  const entry = {
    hash: opts.hash,
    ledger_index: opts.ledger,
    validated: opts.validated !== false,
    meta: { TransactionResult: opts.result || "tesSUCCESS" },
    tx_json: {
      TransactionType: opts.type || "Payment",
      Account: opts.account,
      Destination: opts.destination || hello.W3,
      Amount: opts.amount || "1",
      Memos: opts.memos || [],
    },
  };
  return entry;
}

function helloMemos(payload) {
  return [
    {
      Memo: {
        MemoType: hex(hello.HELLO_TYPE),
        MemoFormat: hex("application/json"),
        MemoData: hex(JSON.stringify(payload)),
      },
    },
  ];
}

describe("peer-hello memo parse", () => {
  it("decodes the documented MemoType, MemoFormat, and JSON MemoData", () => {
    const payload = {
      repo: "https://github.com/example/peer",
      x402: "https://peer.example/api/x402",
    };
    const row = hello.helloFromEntry(
      payment({
        hash: "A".repeat(64),
        ledger: 42,
        account: STRANGER,
        memos: helloMemos(payload),
      })
    );
    assert.equal(row.account, STRANGER);
    assert.equal(row.hash, "A".repeat(64));
    assert.equal(row.ledger, 42);
    assert.equal(row.memo.MemoType, "aether-peer-hello");
    assert.equal(row.memo.MemoFormat, "application/json");
    assert.equal(row.memo.MemoData, JSON.stringify(payload));
    assert.equal(row.memo.repo, payload.repo);
    assert.equal(row.memo.x402, payload.x402);
  });

  it("accepts a purpose memo whose data is aether-peer-hello", () => {
    const payload = { repo: "https://github.com/example/other", x402: "https://other.example/x402" };
    const row = hello.helloFromEntry(
      payment({
        hash: "B".repeat(64),
        ledger: 43,
        account: FOREIGN,
        memos: [
          { Memo: { MemoType: hex("purpose"), MemoData: hex(hello.HELLO_TYPE) } },
          {
            Memo: {
              MemoFormat: hex("application/json"),
              MemoData: hex(JSON.stringify(payload)),
            },
          },
        ],
      })
    );
    assert.equal(row.memo.MemoType, "aether-peer-hello");
    assert.equal(row.memo.repo, payload.repo);
    assert.equal(row.memo.x402, payload.x402);
  });

  it("archives a hello whose JSON does not parse", () => {
    const row = hello.helloFromEntry(
      payment({
        hash: "E".repeat(64),
        ledger: 45,
        account: STRANGER,
        memos: [
          {
            Memo: {
              MemoType: hex(hello.HELLO_TYPE),
              MemoData: hex("{not-json"),
            },
          },
        ],
      })
    );
    assert.equal(row.memo.MemoData, "{not-json");
    assert.equal(row.memo.repo, null);
    assert.equal(row.memo.x402, null);
  });

  it("ignores other payments, failed txs, outbound W3 payments, and unvalidated rows", () => {
    const rows = hello.collectHellos([
      payment({
        hash: "1".repeat(64),
        ledger: 1,
        account: STRANGER,
        memos: [{ Memo: { MemoType: hex("invoice"), MemoData: hex("nope") } }],
      }),
      payment({
        hash: "2".repeat(64),
        ledger: 2,
        account: STRANGER,
        destination: FOREIGN,
        memos: helloMemos({ repo: "https://github.com/example/nope" }),
      }),
      payment({
        hash: "3".repeat(64),
        ledger: 3,
        account: hello.W3,
        memos: helloMemos({ repo: "https://github.com/example/self" }),
      }),
      payment({
        hash: "4".repeat(64),
        ledger: 4,
        account: STRANGER,
        result: "tecUNFUNDED_PAYMENT",
        memos: helloMemos({ repo: "https://github.com/example/fail" }),
      }),
      payment({
        hash: "5".repeat(64),
        ledger: 5,
        account: STRANGER,
        validated: false,
        memos: helloMemos({ repo: "https://github.com/example/open" }),
      }),
      payment({
        hash: "6".repeat(64),
        ledger: 6,
        account: STRANGER,
        type: "TrustSet",
        memos: helloMemos({ repo: "https://github.com/example/trust" }),
      }),
    ]);
    assert.deepEqual(rows, []);
  });

  it("keeps the fixture page to the two synthetic hellos, oldest ledger first", () => {
    const page = hello.loadFixture(FIXTURE);
    assert.equal(page.length, 4);
    const rows = hello.collectHellos(page, hello.TX_LIMIT);
    assert.deepEqual(
      rows.map((row) => row.hash),
      ["A".repeat(64), "B".repeat(64)]
    );
    assert.equal(rows[0].ledger, 42);
    assert.equal(rows[0].memo.repo, "https://github.com/example/peer");
    assert.equal(rows[1].memo.repo, "https://github.com/example/other");
    assert.match(fs.readFileSync(FIXTURE, "utf8"), /not ledger claims/);
  });
});

describe("peer-hello archive", () => {
  it("appends once and leaves earlier lines untouched", () => {
    const root = tempRoot();
    const file = hello.logPath(root);
    const first = hello.archiveHellos(
      file,
      hello.collectHellos(hello.loadFixture(FIXTURE)),
      NOW
    );
    assert.equal(first.length, 2);
    assert.equal(first[0].seen_at, SEEN);
    assert.equal(first[0].network, "xrpl:1");
    assert.equal(first[0].account, STRANGER);
    const before = fs.readFileSync(file, "utf8");
    const extra = hello.archiveHellos(
      file,
      [
        {
          account: FOREIGN,
          hash: "F".repeat(64),
          ledger: 90,
          memo: {
            MemoType: hello.HELLO_TYPE,
            MemoFormat: null,
            MemoData: "",
            repo: null,
            x402: null,
          },
        },
      ].concat(hello.collectHellos(hello.loadFixture(FIXTURE))),
      new Date("2026-10-06T02:00:00.000Z")
    );
    assert.equal(extra.length, 1);
    assert.equal(extra[0].hash, "F".repeat(64));
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after.startsWith(before), true);
    assert.equal(after.split("\n").filter(Boolean).length, 3);
  });

  it("repairs a torn last line before appending", () => {
    const root = tempRoot();
    const file = hello.logPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{\"hash\":\"ABC\"}");
    hello.archiveHellos(
      file,
      [
        {
          account: STRANGER,
          hash: "A".repeat(64),
          ledger: 7,
          memo: {
            MemoType: hello.HELLO_TYPE,
            MemoFormat: "application/json",
            MemoData: "{}",
            repo: null,
            x402: null,
          },
        },
      ],
      NOW
    );
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).hash, "A".repeat(64));
  });

  it("does not write on a fixture dry run, and --record writes under --root", async () => {
    const root = tempRoot();
    const logs = [];
    const dry = await hello.run(
      ["node", "peer-hello", "--fixture", FIXTURE, "--dry", "--root", root],
      { log: (line) => logs.push(line), now: () => NOW }
    );
    assert.equal(dry, 0);
    assert.equal(fs.existsSync(hello.logPath(root)), false);
    assert.match(logs.join("\n"), /write=no/);
    assert.match(logs.join("\n"), /example\/peer/);

    const recorded = await hello.run(
      ["node", "peer-hello", "--fixture", FIXTURE, "--record", "--root", root, "--quiet"],
      { now: () => NOW, log: () => {} }
    );
    assert.equal(recorded, 0);
    const lines = fs.readFileSync(hello.logPath(root), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const again = await hello.run(
      ["node", "peer-hello", "--fixture", FIXTURE, "--record", "--root", root, "--alert"],
      { now: () => NOW, log: () => {} }
    );
    assert.equal(again, 0);
    assert.equal(fs.readFileSync(hello.logPath(root), "utf8").trim().split("\n").length, 2);
  });

  it("exits 2 from --alert only when a new hello is written", async () => {
    const root = tempRoot();
    const code = await hello.run(
      ["node", "peer-hello", "--fixture", FIXTURE, "--record", "--alert", "--root", root, "--quiet"],
      { now: () => NOW, log: () => {} }
    );
    assert.equal(code, 2);
  });
});

describe("peer-hello testnet gate", () => {
  it("refuses mainnet, Xahau, and any network id other than 1", () => {
    assert.throws(() => hello.assertTestnetUrl("https://s1.ripple.com:51234"), /mainnet/);
    assert.throws(() => hello.assertTestnetUrl("https://xrplcluster.com"), /mainnet/);
    assert.throws(() => hello.assertTestnetUrl("wss://s.altnet.rippletest.net:51233"), /non-HTTP/);
    assert.throws(() => hello.assertTestnetUrl("https://xahau.testnet.example"), /Xahau|non-testnet/);
    assert.throws(() => hello.assertTestnetUrl("https://s.altnet.rippletest.net.evil.com"), /non-testnet/);
    assert.equal(hello.assertTestnetUrl(hello.XRPL_HTTP), hello.XRPL_HTTP);
    assert.throws(() => hello.assertNetworkId(0), /NetworkID 0/);
    assert.throws(() => hello.assertNetworkId(21337), /NetworkID/);
    assert.doesNotThrow(() => hello.assertNetworkId(null));
    assert.doesNotThrow(() => hello.assertNetworkId(1));
  });

  it("asks for one validated page and stops before account_tx on network id 0", async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.method === "server_info") {
        return { ok: true, async json() { return { result: { info: { network_id: 0 } } }; } };
      }
      throw new Error("account_tx should not run");
    };
    const code = await hello.run(["node", "peer-hello", "--quiet"], {
      fetchImpl,
      error: () => {},
    });
    assert.equal(code, 1);
    assert.deepEqual(calls.map((row) => row.method), ["server_info"]);
  });

  it("requests a capped account_tx page and does not send a marker", async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.method === "server_info") {
        return { ok: true, async json() { return { result: { info: { network_id: 1 } } }; } };
      }
      return {
        ok: true,
        async json() {
          return {
            result: {
              validated: true,
              marker: "do-not-follow",
              transactions: hello.loadFixture(FIXTURE),
            },
          };
        },
      };
    };
    const root = tempRoot();
    const code = await hello.run(
      ["node", "peer-hello", "--root", root, "--quiet", "--limit", "2"],
      { fetchImpl, now: () => NOW, log: () => {} }
    );
    assert.equal(code, 0);
    const txCall = calls.find((row) => row.method === "account_tx");
    assert.equal(txCall.params[0].account, hello.W3);
    assert.equal(txCall.params[0].limit, 2);
    assert.equal(txCall.params[0].ledger_index_min, -1);
    assert.equal(txCall.params[0].ledger_index_max, -1);
    assert.equal(txCall.params[0].forward, false);
    assert.equal("marker" in txCall.params[0], false);
    const lines = fs.readFileSync(hello.logPath(root), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).hash, "B".repeat(64));
    assert.equal(JSON.parse(lines[0]).ledger, 43);
  });
});

describe("peer-hello hands hook", () => {
  it("keeps the archive when the hands hook throws", async () => {
    const root = tempRoot();
    const errors = [];
    const code = await hello.run(
      ["node", "peer-hello", "--fixture", FIXTURE, "--record", "--root", root, "--quiet"],
      {
        now: () => NOW,
        hook: () => {
          throw new Error("hands down");
        },
        error: (line) => errors.push(line),
      }
    );
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(hello.logPath(root), "utf8").trim().split("\n").length, 2);
    assert.match(errors.join("\n"), /hands notify failed/);
  });

  it("appends a hands file and still returns when that write fails", async () => {
    const root = tempRoot();
    const hands = path.join(root, "hands", "note.jsonl");
    const note = await hello.notifyHands(
      [{ account: STRANGER, hash: "A".repeat(64) }],
      { handsFile: hands, quiet: true }
    );
    assert.equal(note.notified, true);
    assert.match(fs.readFileSync(hands, "utf8"), /aether-peer-hello/);
    const broken = await hello.notifyHands([{ account: STRANGER, hash: "B".repeat(64) }], {
      handsFile: path.join(root, "nope"),
      fs: {
        mkdirSync() {
          throw new Error("disk full");
        },
        appendFileSync() {
          throw new Error("disk full");
        },
      },
      error: () => {},
    });
    assert.equal(broken.notified, false);
    assert.equal(broken.reason, "fail-soft");
  });

  it("does not sign", () => {
    const src = fs.readFileSync(path.join(__dirname, "peer-hello.js"), "utf8");
    assert.equal(/fromSeed|\.submit\(|\bWallet\b/.test(src), false);
  });

  it("names the watcher next to the W3 hello convention", () => {
    const doc = fs.readFileSync(path.join(ROOT, "lab", "peers", "HOW-TO-PING.md"), "utf8");
    assert.match(doc, new RegExp(hello.W3));
    assert.match(doc, /aether-peer-hello/);
    assert.match(doc, /peers:hello/);
    assert.match(doc, /hellos\.jsonl/);
  });
});
