"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");
const tools = require("./tools");
const server = require("./server");

const ROOT = path.resolve(__dirname, "..", "..");
const SENTINEL = "mcp-forbidden-value-9f3c";
const DESK = "https://aether-foundry-desk.vercel.app";

function throwsCode(promise, code) {
  return promise.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (error) => {
      assert.equal(error.code, code);
      assert.equal(String(error.message).includes(SENTINEL), false);
      return error;
    }
  );
}

function jsonRes(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

function deskFetch(routes) {
  return async (url, init) => {
    const target = String(url);
    if (routes.has(target)) return routes.get(target)(url, init);
    throw new Error(`unexpected fetch ${target}`);
  };
}

describe("catalog", () => {
  it("lists the inbound tools without a seed field", () => {
    const listed = tools.listTools();
    const names = listed.map((tool) => tool.name);
    assert.deepEqual(names, [
      "walk_in_status",
      "walk_in_buy",
      "x402_catalog",
      "x402_buy",
      "director_status",
      "grant_eligibility",
      "amm_quote",
    ]);
    const blob = JSON.stringify(listed);
    assert.doesNotMatch(blob, /seed|secret|private_key/i);
    assert.equal(listed.every((tool) => tool.inputSchema.additionalProperties === false), true);
  });

  it("does not embed Wallet.sign or a seed literal in the server", () => {
    const src = ["tools.js", "server.js"]
      .map((name) => fs.readFileSync(path.join(__dirname, name), "utf8"))
      .join("\n");
    assert.equal(src.includes("Wallet.sign"), false);
    assert.equal(src.includes("child_process"), false);
    assert.doesNotMatch(src, /sEd[1-9A-HJ-NP-Za-km-z]{15,}/);
  });
});

describe("delegated buys", () => {
  it("walk_in_buy defaults to the dry-run command", async () => {
    const out = await tools.callTool("walk_in_buy", { faucet: true, record: true }, { env: {} });
    assert.equal(out.delegated, true);
    assert.equal(out.signed, false);
    assert.equal(out.executed, false);
    assert.equal(out.command, "npm run buy:walk-in -- --dry-run");
    assert.deepEqual(out.argv, ["npm", "run", "buy:walk-in", "--", "--dry-run"]);
  });

  it("x402_buy returns argv and does not run it when MCP_SIGN is off", async () => {
    const out = await tools.callTool(
      "x402_buy",
      { sku: "reserve-audit", record: true },
      { env: { MCP_SIGN: "off" } }
    );
    assert.equal(out.delegated, true);
    assert.equal(out.signed, false);
    assert.equal(out.executed, false);
    assert.deepEqual(out.argv, ["npm", "run", "x402:pay", "--", "reserve-audit"]);
    assert.equal(out.command, "npm run x402:pay -- reserve-audit");
  });

  it("refuses CI and GITHUB_ACTIONS on the signing path", async () => {
    await throwsCode(
      tools.callTool("x402_buy", { sku: "machine-spec" }, { env: { MCP_SIGN: "on", CI: "true" } }),
      "CI"
    );
    await throwsCode(
      tools.callTool("walk_in_buy", { faucet: true }, { env: { MCP_SIGN: "on", GITHUB_ACTIONS: "true" } }),
      "CI"
    );
    await throwsCode(
      tools.callTool("x402_buy", { sku: "composition-quote" }, { env: { MCP_SIGN: "on", CI: "1" } }),
      "CI"
    );
  });

  it("MCP_SIGN=on still does not execute", async () => {
    const out = await tools.callTool(
      "walk_in_buy",
      { faucet: true },
      { env: { MCP_SIGN: "on", CI: "false" } }
    );
    assert.equal(out.executed, false);
    assert.equal(out.signed, false);
    assert.equal(out.command, "npm run buy:walk-in -- --faucet");
  });
});

describe("forbidden arguments", () => {
  it("rejects seed, secret, and private_key without logging the value", async () => {
    const logs = [];
    const log = (line) => logs.push(String(line));
    for (const arguments_ of [
      { seed: SENTINEL },
      { secret: SENTINEL },
      { private_key: SENTINEL },
      { nested: { private_key: SENTINEL } },
    ]) {
      await throwsCode(tools.callTool("walk_in_status", arguments_, { env: {}, log, fetch: async () => {
        throw new Error("fetch should not run");
      } }), "FORBIDDEN_ARG");
    }
    const shaped = `sEd${"a".repeat(24)}`;
    await throwsCode(
      tools.callTool(
        "x402_buy",
        { sku: "machine-spec", prompt: shaped },
        { env: {}, log, fetch: async () => { throw new Error("fetch should not run"); } }
      ),
      "FORBIDDEN_ARG"
    );
    const text = logs.join("\n");
    assert.match(text, /forbidden argument name/);
    assert.equal(text.includes(SENTINEL), false);
    assert.equal(text.includes(shaped), false);
  });
});

describe("mainnet", () => {
  it("refuses mainnet hosts and network id 0 before fetch", async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(String(url));
      return jsonRes({ networkId: 1, status: "open", offers: [] });
    };
    await throwsCode(
      tools.callTool("walk_in_status", {}, { env: {}, fetch, deskUrl: "https://s1.ripple.com" }),
      "MAINNET"
    );
    await throwsCode(
      tools.callTool("amm_quote", {}, { env: {}, fetch, xrplHttp: "https://xrplcluster.com" }),
      "MAINNET"
    );
    await throwsCode(
      tools.callTool("x402_catalog", {}, { env: {}, fetch, deskUrl: "https://xahau.network" }),
      "MAINNET"
    );
    assert.equal(calls.length, 0);
    await throwsCode(
      tools.callTool("walk_in_status", {}, {
        env: {},
        deskUrl: DESK,
        fetch: async () => jsonRes({ networkId: 0, status: "open", offers: [] }),
      }),
      "MAINNET"
    );
  });

  it("halts when amm RPC does not prove network id", async () => {
    let amm = 0;
    await throwsCode(
      tools.callTool("amm_quote", {}, {
        env: {},
        xrplHttp: "https://s.altnet.rippletest.net:51234",
        deskUrl: DESK,
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          if (body.method === "server_info") {
            return jsonRes({ result: { status: "success", info: {} } });
          }
          amm += 1;
          return jsonRes({ result: { status: "success", validated: true, ledger_index: 1, amm: { account: "r" } } });
        },
      }),
      "RPC"
    );
    assert.equal(amm, 0);
    await throwsCode(
      tools.callTool("amm_quote", {}, {
        env: {},
        xrplHttp: "https://s.altnet.rippletest.net:51234",
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(body.method, "server_info");
          return jsonRes({ result: { status: "success", info: { network_id: 0 } } });
        },
      }),
      "MAINNET"
    );
  });
});

describe("read tools", () => {
  it("projects walk_in_status and drops buyer-variable hints", async () => {
    const out = await tools.callTool("walk_in_status", {}, {
      env: {},
      deskUrl: DESK,
      fetch: async (url) => {
        assert.equal(url, `${DESK}/api/inbound/walk-in`);
        return jsonRes({
          networkId: 1,
          status: "open",
          seller: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
          deskSigns: false,
          offers: [{ offerId: "A".repeat(64), nftokenId: "B".repeat(64), amount: "10 XRP", priceXrp: "10" }],
          howToBuy: ["WALKIN_BUYER_SEED=..."],
        });
      },
    });
    assert.equal(out.status, "open");
    assert.equal(out.networkId, 1);
    assert.equal(out.deskSigns, false);
    assert.equal(out.offers[0].offerId, "A".repeat(64));
    assert.doesNotMatch(JSON.stringify(out), /seed|secret|private_key/i);
  });

  it("director_status degrades when desk status is 404", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-director-"));
    const statePath = path.join(dir, "director-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        updated_at: "2026-09-28T12:00:00-05:00",
        last_session_id: "mcp",
        networks: {
          xrpl_testnet: { network_id: 1, validated_ledger_index: 21102567 },
          xahau_testnet: { network_id: 21338, validated_ledger_index: 12696465 },
        },
        next_actions: ["one", "two", "three"],
        blockers: [],
      })
    );
    const out = await tools.callTool("director_status", {}, {
      env: {},
      deskUrl: DESK,
      statePath,
      now: new Date("2026-09-28T18:00:00.000Z"),
      fetch: async (url) => {
        assert.equal(url, `${DESK}/api/status`);
        return jsonRes("missing", 404);
      },
    });
    assert.equal(out.signing, "none");
    assert.equal(out.state.available, true);
    assert.equal(out.state.xrpl_validated_ledger_index, 21102567);
    assert.equal(out.state.stale, false);
    assert.deepEqual(out.desk, { available: false, status: 404 });
    assert.doesNotMatch(JSON.stringify(out), /seed|secret|private_key/i);
  });

  it("grant_eligibility is a read-only scan", async () => {
    let paid = false;
    const engine = {
      async executeScan() {
        return {
          report: {
            selectable: [
              {
                address: "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN",
                reason: "walk_in_acceptor",
                sources: ["ledger-log"],
                evidence: null,
              },
            ],
            excluded: [{ address: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs", why: "labeled" }],
          },
          text: "scan\nno payment (scan is read-only)",
        };
      },
      async execute() {
        paid = true;
      },
    };
    const out = await tools.callTool("grant_eligibility", {}, { env: {}, engine });
    assert.equal(paid, false);
    assert.equal(out.readOnly, true);
    assert.equal(out.signed, false);
    assert.equal(out.selectable[0].address, "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN");
    assert.equal(out.excluded_labeled, 1);
    assert.match(out.text, /read-only/);
    assert.doesNotMatch(JSON.stringify(out), /seed|secret|private_key/i);
  });

  it("amm_quote uses public amm_info and leaves the desk unpaid", async () => {
    const out = await tools.callTool("amm_quote", {}, {
      env: {},
      xrplHttp: "https://s.altnet.rippletest.net:51234",
      deskUrl: DESK,
      fetch: async (url, init) => {
        if (String(url).includes("composition-quote")) return jsonRes({ error: "payment required" }, 402);
        const body = JSON.parse(init.body);
        if (body.method === "server_info") {
          return jsonRes({ result: { status: "success", info: { network_id: 1 } } });
        }
        assert.equal(body.method, "amm_info");
        assert.equal(body.params[0].ledger_index, "validated");
        return jsonRes({
          result: {
            status: "success",
            validated: true,
            ledger_index: 21102567,
            amm: {
              account: "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w",
              amount: "500000000",
              amount2: {
                currency: "4145544800000000000000000000000000000000",
                issuer: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
                value: "1000",
              },
            },
          },
        });
      },
    });
    assert.equal(out.paid, false);
    assert.equal(out.network_id, 1);
    assert.equal(out.amm.account, "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w");
    assert.equal(out.amm.spot_xrp_per_aeth, "0.5");
    assert.equal(out.amm.ledger_index, 21102567);
    assert.equal(out.desk_composition.unpaid, true);
    assert.equal(out.desk_composition.paid, false);
    assert.equal(tools.spotXrpPerAeth("1000000", "2.5"), "0.4");
  });
});

describe("stdio", () => {
  it("lists tools and rejects a forbidden argument on the wire", async () => {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "mcp", "server.js")], {
      env: { ...process.env, MCP_SIGN: "off" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "walk_in_buy", arguments: { faucet: true } },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "walk_in_buy", arguments: { seed: SENTINEL } },
    });
    const deadline = Date.now() + 8000;
    while (!stdout.includes('"id":4') && !stdout.includes('"id": 4') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill();
    const messages = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const listed = messages.find((message) => message.id === 2);
    assert.ok(listed.result.tools.some((tool) => tool.name === "walk_in_status"));
    const bought = messages.find((message) => message.id === 3);
    const buyBody = JSON.parse(bought.result.content[0].text);
    assert.equal(buyBody.delegated, true);
    assert.equal(buyBody.command, "npm run buy:walk-in -- --dry-run");
    const refused = messages.find((message) => message.id === 4);
    assert.equal(refused.result.isError, true);
    const combined = `${stdout}\n${stderr}`;
    assert.equal(combined.includes(SENTINEL), false);
    assert.match(stderr, /forbidden argument name/);
  });
});

describe("loopback http", () => {
  it("refuses a public bind and Vercel", () => {
    assert.throws(() => server.assertLoopback("0.0.0.0"), (error) => error.code === "BIND");
    assert.throws(() => server.assertNotVercel({ VERCEL: "1" }), (error) => error.code === "DESK");
    assert.equal(server.assertLoopback("localhost"), "127.0.0.1");
  });
});

describe("production desk", () => {
  it("walk_in_status hits the production desk", async () => {
    const out = await tools.callTool("walk_in_status", {}, { env: { MCP_SIGN: "off" }, fetch: globalThis.fetch });
    assert.equal(out.deskSigns, false);
    assert.equal(out.signing, "none");
    assert.equal(out.networkId, 1);
    assert.ok(["open", "sold_out", "error"].includes(out.status));
    assert.equal(out.httpStatus, 200);
    if (out.status === "open") {
      assert.match(out.offers[0].offerId, /^[0-9A-Fa-f]{64}$/);
    }
    assert.doesNotMatch(JSON.stringify(out), /seed|secret|private_key/i);
  });
});

describe("desk facade source", () => {
  it("stays seedless and does not sign", () => {
    const route = fs.readFileSync(path.join(ROOT, "web", "app", "api", "mcp", "route.ts"), "utf8");
    assert.equal(route.includes("Wallet.sign"), false);
    assert.doesNotMatch(route, /sEd[1-9A-HJ-NP-Za-km-z]{15,}/);
    assert.match(route, /delegated:\s*true/);
    assert.match(route, /VERCEL|deskSigns/);
    assert.match(route, /npm run buy:walk-in -- --dry-run/);
  });
});
