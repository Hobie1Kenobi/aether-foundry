"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const protocol = require("./protocol");
const herald = require("./herald");

const FIXTURE = path.join(__dirname, "..", "fixtures", "agent-chat-account-tx.json");
const NOW = new Date("2026-10-06T02:40:00.123Z");
const TOKEN = "0123456789abcdef";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "herald-"));
}

function jsonResponse(body, status) {
  return {
    ok: (status || 200) < 300,
    status: status || 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("herald archive", () => {
  it("keeps the fixture to the four synthetic session frames and ignores noise", () => {
    const page = herald.loadFixturePage(FIXTURE);
    assert.match(fs.readFileSync(FIXTURE, "utf8"), /not ledger claims/);
    const frames = protocol.collectFrames(page.transactions, { synthetic: true });
    assert.deepEqual(frames.map((row) => row.t), [
      protocol.HELLO,
      protocol.ACK,
      protocol.OFFER,
      protocol.ACCEPT,
    ]);
    assert.equal(frames.every((row) => row.synthetic && row.ledger_claim === false), true);
  });

  it("appends frames and sessions once", () => {
    const root = tempRoot();
    const page = herald.loadFixturePage(FIXTURE);
    const frames = protocol.collectFrames(page.transactions, { synthetic: true });
    const first = herald.archiveFrames(herald.framesPath(root), frames, NOW);
    const sessions = herald.archiveSessions(herald.sessionsPath(root), frames, NOW);
    assert.equal(first.length, 4);
    assert.equal(sessions.length, 4);
    assert.equal(sessions[3].state, "open");
    const before = fs.readFileSync(herald.framesPath(root), "utf8");
    const again = herald.archiveFrames(herald.framesPath(root), frames, NOW);
    assert.equal(again.length, 0);
    assert.equal(fs.readFileSync(herald.framesPath(root), "utf8"), before);
    const sessionAgain = herald.archiveSessions(herald.sessionsPath(root), frames, NOW);
    assert.equal(sessionAgain.length, 0);
  });

  it("stays dry on a fixture and refuses live-ack against it", async () => {
    const root = tempRoot();
    const logs = [];
    const code = await herald.run(["node", "herald.js", "--fixture", FIXTURE, "--dry", "--root", root], {
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
      now: () => NOW,
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(herald.framesPath(root)), false);
    assert.match(logs.join("\n"), /write=no/);
    const refused = await herald.run(
      ["node", "herald.js", "--fixture", FIXTURE, "--live-ack", "--root", root],
      { log: () => {}, error: (line) => logs.push(line), env: {} }
    );
    assert.equal(refused, 1);
    assert.match(logs.join("\n"), /refusing --live-ack/);
  });

  it("posts an ack only when both live flags are set and the signer returns tesSUCCESS", async () => {
    const root = tempRoot();
    const hello = protocol.validateEnvelope({
      v: 1,
      t: protocol.HELLO,
      from: "aether-scout",
      net: "xrpl:1",
      nonce: "livehello",
      repo: "https://github.com/example/peer",
    });
    const helloHash = "AB".repeat(32);
    const entry = {
      hash: helloHash,
      ledger_index: 77,
      validated: true,
      meta: { TransactionResult: "tesSUCCESS" },
      tx_json: protocol.paymentTx({
        account: protocol.W5,
        destination: protocol.W3,
        body: hello,
      }),
    };
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(String(url));
      const target = String(url);
      if (target.includes("xrpl-labs.com") || target.includes("rippletest")) {
        const body = JSON.parse(init.body);
        if (body.method === "server_info") return jsonResponse({ result: { info: { network_id: 1 } } });
        return jsonResponse({ result: { validated: true, transactions: [entry] } });
      }
      if (target.endsWith("/health")) return jsonResponse({ signing: true, network_id: 1 });
      if (target.endsWith("/sign")) {
        const payload = JSON.parse(init.body);
        assert.equal(payload.wallet, "W3");
        assert.equal(payload.tx.Account, protocol.W3);
        assert.equal(payload.tx.Destination, protocol.W5);
        assert.equal(payload.tx.Amount, "1");
        assert.equal(payload.intent, protocol.ACK);
        return jsonResponse({ hash: "CD".repeat(32), ledger_index: 78, result: "tesSUCCESS" });
      }
      throw new Error(`unexpected ${target}`);
    };
    const env = {
      FOUNDRY_AGENT_SIGN: "yes",
      AETHER_NET_CHAT_LIVE: "yes",
      FOUNDRY_SIGNER_TOKEN: TOKEN,
    };
    const missing = await herald.run(["node", "herald.js", "--live-ack", "--root", root, "--quiet"], {
      env: { FOUNDRY_AGENT_SIGN: "yes" },
      fetchImpl,
      error: () => {},
    });
    assert.equal(missing, 1);
    assert.equal(calls.some((url) => url.endsWith("/sign")), false);
    const code = await herald.run(["node", "herald.js", "--live-ack", "--root", root, "--quiet"], {
      env,
      fetchImpl,
      now: () => NOW,
      nonce: () => "abcdef0123456789",
      sessionId: () => "s_a11ce00000000001",
    });
    assert.equal(code, 0);
    assert.equal(calls.some((url) => url.endsWith("/sign")), true);
    const frames = herald.readJsonl(herald.framesPath(root));
    const ack = frames.find((row) => row.t === protocol.ACK);
    assert.equal(ack.hash, "CD".repeat(32));
    assert.equal(ack.ledger_claim, true);
    assert.equal(ack.synthetic, false);
    assert.equal(ack.body.hello_hash, helloHash);
    const again = await herald.run(["node", "herald.js", "--live-ack", "--root", root, "--quiet"], {
      env,
      fetchImpl,
      now: () => NOW,
    });
    assert.equal(again, 0);
    const signed = calls.filter((url) => url.endsWith("/sign")).length;
    assert.equal(signed, 1);
  });

  it("refuses a mainnet RPC host and network id 0", async () => {
    const logs = [];
    const mainnet = await herald.run(["node", "herald.js", "--rpc", "https://xrplcluster.com/", "--root", tempRoot()], {
      error: (line) => logs.push(line),
      log: () => {},
    });
    assert.equal(mainnet, 1);
    assert.match(logs.join("\n"), /mainnet/);
    const code = await herald.run(["node", "herald.js", "--root", tempRoot(), "--quiet"], {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "server_info") return jsonResponse({ result: { info: { network_id: 0 } } });
        throw new Error("should not account_tx");
      },
      error: (line) => logs.push(line),
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /NetworkID 0/);
  });
});
