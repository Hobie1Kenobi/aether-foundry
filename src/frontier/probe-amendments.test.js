"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const anchors = require("../director/anchors");
const probe = require("./probe-amendments");

const SCRIPT = path.join(__dirname, "probe-amendments.js");
const COMMITTED = path.join(anchors.repoRoot(), probe.OUT_REL);
const NOW = new Date("2026-09-28T23:23:00.000Z");

function tempOut() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amendments-probe-"));
  return path.join(dir, "amendments.json");
}

function jsonResponse(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { result };
    },
  };
}

function featureMap(rows) {
  const features = {};
  for (const row of rows) {
    features[row.hash] = {
      name: row.name,
      enabled: row.enabled,
      supported: row.supported,
    };
    if (row.vetoed != null) features[row.hash].vetoed = row.vetoed;
  }
  return { features };
}

function committedRows() {
  return JSON.parse(fs.readFileSync(COMMITTED, "utf8")).amendments;
}

function mockFetch(opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (opts.fail === "throw") throw new Error("socket down");
    const body = JSON.parse(init.body);
    if (opts.fail === body.method) {
      return jsonResponse({ status: "error", error: "nope", error_message: `${body.method} unavailable` });
    }
    if (body.method === "server_info") {
      const info = { build_version: opts.build_version == null ? "3.4.1" : opts.build_version };
      if (opts.omitNetworkId !== true) info.network_id = opts.network_id == null ? 1 : opts.network_id;
      return jsonResponse({ info });
    }
    if (body.method === "feature") {
      const rows = opts.rows || committedRows();
      const dropped = new Set(opts.omit || []);
      return jsonResponse(featureMap(rows.filter((row) => !dropped.has(row.name)).map((row) => {
        if (opts.blankFlag === row.name) return Object.assign({}, row, { enabled: undefined });
        return row;
      })));
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  return { fetchImpl, calls };
}

describe("frontier amendment probe", () => {
  it("writes the watched map from feature keys and server_info", async () => {
    const out = tempOut();
    const mock = mockFetch();
    const code = await probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", anchors.XRPL_HTTP], {
      fetchImpl: mock.fetchImpl,
      now: NOW,
      silent: true,
      env: {},
    });
    assert.equal(code, 0);
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(doc.probed_at, "2026-09-28T18:23:00-05:00");
    assert.equal(doc.rpc, anchors.XRPL_HTTP);
    assert.equal(doc.network_id, 1);
    assert.equal(doc.build_version, "3.4.1");
    assert.deepEqual(doc.amendments.map((row) => row.name), probe.WATCHED);
    assert.deepEqual(
      doc.amendments.map((row) => ({ name: row.name, enabled: row.enabled, hash: row.hash })),
      committedRows().map((row) => ({ name: row.name, enabled: row.enabled, hash: row.hash }))
    );
    assert.deepEqual(mock.calls.map((call) => JSON.parse(call.init.body).method), ["server_info", "feature"]);
  });

  it("prefers FOUNDRY_XRPL_HTTP and strips nothing it did not refuse", async () => {
    const out = tempOut();
    const alt = "https://s.altnet.rippletest.net:51234";
    const mock = mockFetch();
    await probe.run(["node", SCRIPT, "--out", out], {
      fetchImpl: mock.fetchImpl,
      now: NOW,
      silent: true,
      env: { FOUNDRY_XRPL_HTTP: alt, XRPL_HTTP: "https://example.rippletest.net:51234" },
    });
    assert.equal(mock.calls[0].url, alt);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).rpc, alt);
  });

  it("refuses userinfo before any RPC write", async () => {
    const out = tempOut();
    const mock = mockFetch();
    await assert.rejects(
      () =>
        probe.run(["node", SCRIPT, "--out", out], {
          fetchImpl: mock.fetchImpl,
          silent: true,
          env: { FOUNDRY_XRPL_HTTP: "https://user:secret@s.altnet.rippletest.net:51234" },
        }),
      (error) => {
        assert.equal(error.code, "SCHEMA");
        assert.match(error.message, /userinfo/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      }
    );
    assert.equal(mock.calls.length, 0);
    assert.equal(fs.existsSync(out), false);
  });

  it("refuses a network id other than 1 and does not write", async () => {
    for (const network_id of [0, 2, 21337, 21338]) {
      const out = tempOut();
      const mock = mockFetch({ network_id });
      await assert.rejects(
        () =>
          probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", anchors.XRPL_HTTP], {
            fetchImpl: mock.fetchImpl,
            silent: true,
            env: {},
          }),
        (error) => {
          assert.equal(error.code, "MAINNET");
          return true;
        }
      );
      assert.equal(fs.existsSync(out), false);
      assert.deepEqual(mock.calls.map((call) => JSON.parse(call.init.body).method), ["server_info"]);
    }
  });

  it("halts when server_info omits network_id", async () => {
    const out = tempOut();
    const mock = mockFetch({ omitNetworkId: true });
    await assert.rejects(
      () =>
        probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", anchors.XRPL_HTTP], {
          fetchImpl: mock.fetchImpl,
          silent: true,
          env: {},
        }),
      /network_id/
    );
    assert.equal(fs.existsSync(out), false);
  });

  it("does not write a file when RPC fails", async () => {
    for (const fail of ["throw", "server_info", "feature"]) {
      const out = tempOut();
      fs.writeFileSync(out, '{"fake":true}\n');
      const mock = mockFetch({ fail });
      await assert.rejects(
        () =>
          probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", anchors.XRPL_HTTP], {
            fetchImpl: mock.fetchImpl,
            silent: true,
            env: {},
          }),
        (error) => {
          assert.equal(error.code, "RPC");
          return true;
        }
      );
      assert.equal(fs.readFileSync(out, "utf8"), '{"fake":true}\n');
    }
  });

  it("does not invent a disabled row when the server omits the name", async () => {
    const out = tempOut();
    const mock = mockFetch({ omit: ["BatchV1_1", "SingleAssetVault", "TokenEscrow"] });
    await assert.rejects(
      () =>
        probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", anchors.XRPL_HTTP], {
          fetchImpl: mock.fetchImpl,
          silent: true,
          env: {},
        }),
      (error) => {
        assert.equal(error.code, "RPC");
        assert.match(error.message, /omitted TokenEscrow/);
        assert.match(error.message, /refusing to mark it disabled/);
        return true;
      }
    );
    assert.equal(fs.existsSync(out), false);
  });

  it("does not coerce a missing enabled flag to false", async () => {
    const out = tempOut();
    const mock = mockFetch({ blankFlag: "PermissionDelegationV1_1" });
    await assert.rejects(
      () =>
        probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", anchors.XRPL_HTTP], {
          fetchImpl: mock.fetchImpl,
          silent: true,
          env: {},
        }),
      /boolean flags/
    );
    assert.equal(fs.existsSync(out), false);
  });

  it("refuses mainnet hosts", () => {
    assert.throws(() => probe.resolveHttp({ FOUNDRY_XRPL_HTTP: "https://s1.ripple.com:51234" }, null), /mainnet/);
    assert.throws(() => probe.resolveHttp({ XRPL_HTTP: "https://xrplcluster.com" }, null), /mainnet|non-testnet|unparseable/);
  });

  it("exits non-zero from the CLI when the host is refused", () => {
    const out = tempOut();
    const result = spawnSync(process.execPath, [SCRIPT, "--out", out, "--xrpl-http", "https://s1.ripple.com:51234"], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mainnet/);
    assert.equal(fs.existsSync(out), false);
  });

  it("does not load a signer, a secrets file, or a hardcoded amendment hash", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const banned = [
      /require\(["']xrpl["']\)/,
      /require\(["']xahau["']\)/,
      /require\(["']dotenv["']\)/,
      /aether-foundry-secrets/,
      /fromSeed/,
      /Wallet/,
      /TransactionType/,
      /submitAndWait/,
      /OracleSet/,
      /1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF/,
    ];
    for (const pattern of banned) assert.doesNotMatch(src, pattern);
  });
});

describe("committed amendments.json", () => {
  it("matches the 2026-09-28 Testnet probe", () => {
    const doc = JSON.parse(fs.readFileSync(COMMITTED, "utf8"));
    assert.equal(doc.probed_at, "2026-09-28T19:05:29-05:00");
    assert.equal(doc.rpc, "https://s.altnet.rippletest.net:51234");
    assert.equal(doc.network_id, 1);
    assert.equal(doc.build_version, "3.4.1");
    assert.deepEqual(doc.amendments.map((row) => row.name), probe.WATCHED);
    const enabled = Object.fromEntries(doc.amendments.map((row) => [row.name, row.enabled]));
    for (const name of probe.BANDS.A) assert.equal(enabled[name], true, name);
    for (const name of ["BatchV1_1", "fixBatchV1_2", "PermissionDelegationV1_1"]) {
      assert.equal(enabled[name], false, name);
    }
    assert.equal(enabled.TicketBatch, true);
    for (const name of probe.BANDS.C) assert.equal(enabled[name], false, name);
    for (const row of doc.amendments) {
      assert.equal(row.supported, true);
      assert.equal(row.vetoed, null);
      assert.match(row.hash, anchors.HASH_RE);
    }
    const text = fs.readFileSync(COMMITTED, "utf8");
    assert.doesNotMatch(text, /seed|secret|private/i);
  });
});
