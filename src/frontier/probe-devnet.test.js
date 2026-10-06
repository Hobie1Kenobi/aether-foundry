"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const anchors = require("../director/anchors");
const testnetProbe = require("./probe-amendments");
const probe = require("./probe-devnet");

const SCRIPT = path.join(__dirname, "probe-devnet.js");
const COMMITTED = path.join(anchors.repoRoot(), probe.OUT_REL);
const TESTNET = path.join(anchors.repoRoot(), testnetProbe.OUT_REL);
const NOW = new Date("2026-09-29T06:11:00.000Z");

function tempOut() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amendments-devnet-"));
  return path.join(dir, "amendments-devnet.json");
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
  return JSON.parse(fs.readFileSync(TESTNET, "utf8")).amendments.map((row) => {
    const copy = Object.assign({}, row);
    if (testnetProbe.BANDS.C.includes(row.name)) copy.enabled = true;
    if (row.name === "BatchV1_1" || row.name === "fixBatchV1_2" || row.name === "PermissionDelegationV1_1") {
      copy.enabled = true;
    }
    return copy;
  });
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
      if (opts.omitNetworkId !== true) info.network_id = opts.network_id == null ? probe.XRPL_DEVNET_NETWORK_ID : opts.network_id;
      return jsonResponse({ info });
    }
    if (body.method === "feature") {
      const rows = opts.rows || committedRows();
      const dropped = new Set(opts.omit || []);
      return jsonResponse(featureMap(rows.filter((row) => !dropped.has(row.name))));
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  return { fetchImpl, calls };
}

describe("frontier Devnet amendment probe", () => {
  it("writes network id 2 and the watched map from feature keys", async () => {
    const out = tempOut();
    const mock = mockFetch();
    const code = await probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", probe.XRPL_DEVNET_HTTP], {
      fetchImpl: mock.fetchImpl,
      now: NOW,
      silent: true,
      env: {},
    });
    assert.equal(code, 0);
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(doc.probed_at, "2026-09-29T01:11:00-05:00");
    assert.equal(doc.rpc, probe.XRPL_DEVNET_HTTP);
    assert.equal(doc.network, probe.NETWORK_LABEL);
    assert.equal(doc.network_id, 2);
    assert.equal(doc.build_version, "3.4.1");
    assert.deepEqual(doc.amendments.map((row) => row.name), testnetProbe.WATCHED);
    for (const name of testnetProbe.BANDS.C) {
      assert.equal(doc.amendments.find((row) => row.name === name).enabled, true, name);
    }
    assert.deepEqual(mock.calls.map((call) => JSON.parse(call.init.body).method), ["server_info", "feature"]);
    assert.equal(mock.calls[0].url, probe.XRPL_DEVNET_HTTP);
  });

  it("defaults to the documented Devnet host and ignores the Testnet HTTP env", async () => {
    const out = tempOut();
    const mock = mockFetch();
    await probe.run(["node", SCRIPT, "--out", out], {
      fetchImpl: mock.fetchImpl,
      now: NOW,
      silent: true,
      env: {
        FOUNDRY_XRPL_HTTP: "https://s.altnet.rippletest.net:51234",
        XRPL_HTTP: "https://s1.ripple.com:51234",
      },
    });
    assert.equal(mock.calls[0].url, probe.XRPL_DEVNET_HTTP);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).rpc, probe.XRPL_DEVNET_HTTP);
  });

  it("prefers FOUNDRY_XRPL_DEVNET_HTTP when that host is still Devnet-shaped", async () => {
    const out = tempOut();
    const alt = "https://s.devnet.rippletest.net:51234";
    const mock = mockFetch();
    await probe.run(["node", SCRIPT, "--out", out], {
      fetchImpl: mock.fetchImpl,
      now: NOW,
      silent: true,
      env: { FOUNDRY_XRPL_DEVNET_HTTP: alt, XRPL_DEVNET_HTTP: "https://example.rippletest.net:51234" },
    });
    assert.equal(mock.calls[0].url, alt);
  });

  it("refuses userinfo before any RPC write", async () => {
    const out = tempOut();
    const mock = mockFetch();
    await assert.rejects(
      () =>
        probe.run(["node", SCRIPT, "--out", out], {
          fetchImpl: mock.fetchImpl,
          silent: true,
          env: { FOUNDRY_XRPL_DEVNET_HTTP: "https://user:secret@s.devnet.rippletest.net:51234" },
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

  it("refuses mainnet and the wrong network id and does not write", async () => {
    for (const network_id of [0, 1, 3, 21337, 21338]) {
      const out = tempOut();
      const mock = mockFetch({ network_id });
      await assert.rejects(
        () =>
          probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", probe.XRPL_DEVNET_HTTP], {
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
        probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", probe.XRPL_DEVNET_HTTP], {
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
          probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", probe.XRPL_DEVNET_HTTP], {
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

  it("does not invent a disabled row when Devnet omits a Band C name", async () => {
    const out = tempOut();
    const mock = mockFetch({ omit: ["SingleAssetVault", "Sponsor", "ConfidentialTransfer"] });
    await assert.rejects(
      () =>
        probe.run(["node", SCRIPT, "--out", out, "--xrpl-http", probe.XRPL_DEVNET_HTTP], {
          fetchImpl: mock.fetchImpl,
          silent: true,
          env: {},
        }),
      (error) => {
        assert.equal(error.code, "RPC");
        assert.match(error.message, /omitted SingleAssetVault/);
        assert.match(error.message, /refusing to mark it disabled/);
        return true;
      }
    );
    assert.equal(fs.existsSync(out), false);
  });

  it("refuses mainnet hosts before RPC", () => {
    assert.throws(() => probe.resolveHttp({ FOUNDRY_XRPL_DEVNET_HTTP: "https://s1.ripple.com:51234" }, null), (error) => {
      assert.equal(error.code, "MAINNET");
      assert.match(error.message, /mainnet/);
      return true;
    });
    assert.throws(() => probe.resolveHttp({ XRPL_DEVNET_HTTP: "https://xrplcluster.com" }, null), /mainnet/);
    assert.throws(() => probe.resolveHttp({ XRPL_DEVNET_HTTP: "https://s1.xrpl.ws" }, null), /mainnet/);
    assert.throws(() => probe.resolveHttp({ XRPL_DEVNET_HTTP: "wss://xrpl.link" }, null), /mainnet/);
    assert.throws(() => probe.resolveHttp(null, "https://xahau.network"), /mainnet/);
    assert.throws(() => probe.resolveHttp(null, "https://xrpl.org"), /mainnet/);
  });

  it("exits non-zero from the CLI when the host is mainnet", () => {
    const mainnet = tempOut();
    const refusedHost = spawnSync(process.execPath, [SCRIPT, "--out", mainnet, "--xrpl-http", "https://s1.ripple.com:51234"], {
      encoding: "utf8",
    });
    assert.notEqual(refusedHost.status, 0);
    assert.match(refusedHost.stderr, /mainnet/);
    assert.equal(fs.existsSync(mainnet), false);
  });

  it("does not load a signer, a secrets file, or a transaction type", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const banned = [
      /require\(["']xrpl["']\)/,
      /require\(["']dotenv["']\)/,
      /aether-foundry-secrets/,
      /fromSeed/,
      /Wallet/,
      /TransactionType/,
      /submitAndWait/,
      /VaultCreate/,
      /Sponsor/,
      /Confidential/,
      /1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF/,
    ];
    for (const pattern of banned) assert.doesNotMatch(src, pattern);
  });
});

describe("committed amendments-devnet.json", () => {
  it("is Devnet id 2 with Band C enabled and the same amendment hashes as Testnet", () => {
    const doc = JSON.parse(fs.readFileSync(COMMITTED, "utf8"));
    const testnet = JSON.parse(fs.readFileSync(TESTNET, "utf8"));
    assert.equal(doc.rpc, probe.XRPL_DEVNET_HTTP);
    assert.equal(doc.network, "XRPL Devnet");
    assert.equal(doc.network_id, probe.XRPL_DEVNET_NETWORK_ID);
    assert.equal(doc.build_version, "3.4.1");
    assert.equal(doc.probed_at, "2026-09-28T22:07:35-05:00");
    assert.deepEqual(doc.amendments.map((row) => row.name), testnetProbe.WATCHED);
    const enabled = Object.fromEntries(doc.amendments.map((row) => [row.name, row.enabled]));
    for (const name of testnetProbe.BANDS.C) assert.equal(enabled[name], true, name);
    for (const name of ["BatchV1_1", "fixBatchV1_2", "PermissionDelegationV1_1", "TicketBatch"]) {
      assert.equal(enabled[name], true, name);
    }
    const testnetByName = Object.fromEntries(testnet.amendments.map((row) => [row.name, row]));
    for (const row of doc.amendments) {
      assert.equal(row.supported, true);
      assert.equal(row.vetoed, null);
      assert.equal(row.hash, testnetByName[row.name].hash);
      assert.match(row.hash, anchors.HASH_RE);
    }
    for (const name of testnetProbe.BANDS.C) assert.equal(testnetByName[name].enabled, false, name);
    const text = fs.readFileSync(COMMITTED, "utf8");
    assert.doesNotMatch(text, /seed|secret|private/i);
  });
});
