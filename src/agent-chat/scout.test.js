"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const protocol = require("./protocol");
const scout = require("./scout");
const demoLive = require("./demo-live");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scout-"));
}

describe("scout", () => {
  it("prints an unsigned dry run", async () => {
    const logs = [];
    const code = await scout.run(["node", "scout.js", "--dry"], {
      log: (line) => logs.push(line),
      nonce: () => "drynonce01",
    });
    assert.equal(code, 0);
    const body = JSON.parse(logs.join("\n"));
    assert.equal(body.signed, false);
    assert.equal(body.key_loaded, false);
    assert.equal(body.wallet, "W5");
    assert.equal(body.hello.Amount, "1");
    assert.equal(body.hello.Destination, protocol.W3);
    assert.equal(body.offer.Account, protocol.W5);
    assert.doesNotMatch(logs.join("\n"), /sEd/);
  });

  it("runs the sim loop and writes a multi-turn transcript", async () => {
    const root = tempRoot();
    const result = await scout.runSim({
      mock: true,
      env: { AETHER_SCRIBE_MOCK: "1" },
      root,
      outDir: path.join(root, "demo"),
      now: () => new Date("2026-10-06T03:00:00.000Z"),
    });
    assert.equal(result.turns.length, 6);
    assert.equal(result.meta.synthetic, true);
    assert.equal(result.meta.ledger_claim, false);
    assert.equal(result.meta.scribe, "mock");
    const transcript = fs.readFileSync(path.join(result.dir, "transcript.md"), "utf8");
    assert.match(transcript, /## scout/);
    assert.match(transcript, /## scribe/);
    assert.match(transcript, /seed/);
    const frames = JSON.parse(fs.readFileSync(path.join(result.dir, "frames.json"), "utf8"));
    assert.equal(frames.length, 5);
    assert.equal(frames.every((row) => row.synthetic === true && row.ledger_claim === false), true);
    assert.equal(frames[4].t, protocol.CLOSE);
    const packed = fs.readdirSync(result.dir)
      .filter((name) => fs.statSync(path.join(result.dir, name)).isFile())
      .map((name) => fs.readFileSync(path.join(result.dir, name), "utf8"))
      .join("\n");
    assert.equal(packed.includes("chat_token"), false);
    assert.doesNotMatch(packed, /sEd/);
    assert.match(fs.readFileSync(path.join(result.dir, "README.md"), "utf8"), /not ledger claims|not XRPL transaction hashes|synthetic/i);
  });

  it("refuses live without the signer gate", async () => {
    const logs = [];
    const code = await scout.run(["node", "scout.js", "--live"], {
      env: { CI: "true", FOUNDRY_AGENT_SIGN: "yes", AETHER_NET_CHAT_LIVE: "yes", OLLAMA_API_KEY: "not-a-real-key" },
      error: (line) => logs.push(line),
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /CI|desk|sign/i);
  });
});

describe("demo live preflight", () => {
  it("fails closed when the Ollama key or signer is missing", async () => {
    await assert.rejects(
      () => demoLive.preflight({ FOUNDRY_AGENT_SIGN: "yes", AETHER_NET_CHAT_LIVE: "yes", FOUNDRY_SIGNER_TOKEN: "0123456789abcdef" }, async () => {
        throw new Error("should not fetch");
      }),
      /OLLAMA_API_KEY/
    );
    await assert.rejects(
      () => demoLive.preflight({
        FOUNDRY_AGENT_SIGN: "yes",
        AETHER_NET_CHAT_LIVE: "yes",
        FOUNDRY_SIGNER_TOKEN: "0123456789abcdef",
        OLLAMA_API_KEY: "local-test-key",
        AETHER_SCRIBE_MOCK: "1",
      }, async () => {
        throw new Error("should not fetch");
      }),
      /mock or CI/
    );
  });
});
