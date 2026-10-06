"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const protocol = require("./protocol");
const herald = require("./herald");
const scribe = require("./scribe-server");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
}

function seedOpen(root, opts) {
  const hash = (opts && opts.hash) || protocol.syntheticHash("4");
  const frame = {
    hash,
    ledger: 3,
    account: protocol.W3,
    destination: protocol.W5,
    peer: protocol.W5,
    t: protocol.ACCEPT,
    legacy: false,
    synthetic: opts && opts.synthetic === true,
    ledger_claim: !(opts && opts.synthetic),
    body: {
      v: 1,
      t: protocol.ACCEPT,
      from: protocol.HERALD_ID,
      net: "xrpl:1",
      nonce: "acceptnon",
      session: "s_a11ce00000000001",
      ep: "http://127.0.0.1:8791",
      ttl: 900,
      chat_nonce: "fedcba9876543210",
      offer_hash: protocol.syntheticHash("3"),
    },
  };
  herald.archiveSessions(herald.sessionsPath(root), [frame], new Date("2026-10-06T02:41:00.000Z"));
  return { hash, session: "s_a11ce00000000001", peer: protocol.W5 };
}

async function post(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json() };
}

describe("scribe", () => {
  it("refuses open without an accept and chats on the mock path", async () => {
    const root = tempRoot();
    const started = await scribe.startScribe({
      host: "127.0.0.1",
      port: 0,
      root,
      env: { AETHER_SCRIBE_MOCK: "1" },
    });
    try {
      const health = await fetch(`${started.url}/health`);
      const healthBody = await health.json();
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.agent, "aether-scribe");
      assert.equal(healthBody.network, "xrpl:1");
      assert.equal(healthBody.mock, true);
      assert.equal(healthBody.model, protocol.OLLAMA_MODEL);
      const denied = await post(`${started.url}/v1/session/open`, {
        session: "s_a11ce00000000001",
        peer: protocol.W5,
        accept_hash: protocol.syntheticHash("4"),
      });
      assert.equal(denied.status, 403);
      const openRow = seedOpen(root, { synthetic: true });
      const opened = await post(`${started.url}/v1/session/open`, {
        session: openRow.session,
        peer: openRow.peer,
        accept_hash: openRow.hash,
      });
      assert.equal(opened.status, 200);
      assert.equal(typeof opened.body.chat_token, "string");
      const bare = await post(`${started.url}/v1/chat`, { message: "hi" });
      assert.equal(bare.status, 401);
      const chat = await post(`${started.url}/v1/chat`, { message: protocol.SCOUT_TURNS[0] }, {
        authorization: `Bearer ${opened.body.chat_token}`,
      });
      assert.equal(chat.status, 200);
      assert.match(chat.body.message, /Testnet/);
      assert.match(chat.body.message, /seed/);
      const file = path.join(root, "lab", "peers", "chats", `${openRow.session}.jsonl`);
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).role, "scout");
      assert.equal(JSON.parse(lines[1]).role, "scribe");
      const listed = await fetch(`${started.url}/v1/sessions`);
      const listBody = await listed.json();
      assert.equal(listBody.sessions[0].session, openRow.session);
      assert.equal(JSON.stringify(listBody).includes(opened.body.chat_token), false);
    } finally {
      await started.close();
    }
  });

  it("refuses a synthetic accept when the mock flag is off", async () => {
    const root = tempRoot();
    const openRow = seedOpen(root, { synthetic: true });
    const started = await scribe.startScribe({
      host: "127.0.0.1",
      port: 0,
      root,
      env: {},
    });
    try {
      const denied = await post(`${started.url}/v1/session/open`, {
        session: openRow.session,
        peer: openRow.peer,
        accept_hash: openRow.hash,
      });
      assert.equal(denied.status, 403);
      assert.match(denied.body.error, /synthetic/);
    } finally {
      await started.close();
    }
  });

  it("refuses a bind that is not loopback", () => {
    assert.throws(() => scribe.assertBind("0.0.0.0"), /loopback/);
  });
});
