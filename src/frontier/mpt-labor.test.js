"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const metrics = require("../runtime/metrics");
const probe = require("./probe-amendments");
const labor = require("./mpt-labor");
const create = require("./mpt-labor-create");
const authorize = require("./mpt-labor-authorize");

const NOW = new Date("2026-09-28T23:40:00.000Z");
const TX_HASH = "CD".repeat(32);
const SEQUENCE = 2113;

function jsonResponse(result) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result };
    },
  };
}

function featureFromRows(rows) {
  const features = {};
  for (const row of rows) {
    features[row.hash] = {
      name: row.name,
      enabled: row.enabled,
      supported: row.supported,
    };
  }
  return { features };
}

function committedRows() {
  return JSON.parse(fs.readFileSync(path.join(anchors.repoRoot(), probe.OUT_REL), "utf8")).amendments;
}

function mockLedger(opts = {}) {
  const calls = [];
  const rows = (opts.rows || committedRows()).map((row) => {
    if (opts.disable === row.name) return Object.assign({}, row, { enabled: false });
    return row;
  }).filter((row) => row.name !== opts.omit);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: JSON.parse(init.body).method });
    const method = JSON.parse(init.body).method;
    if (method === "server_info") {
      const info = { build_version: "3.4.1" };
      if (opts.omitNetworkId !== true) info.network_id = opts.network_id == null ? 1 : opts.network_id;
      return jsonResponse({ info });
    }
    if (method === "feature") return jsonResponse(featureFromRows(rows));
    if (method === "account_info") {
      return jsonResponse({
        validated: true,
        account_data: {
          Account: anchors.WALLETS.W5.address,
          Sequence: SEQUENCE,
        },
      });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, calls };
}

function freshState(now) {
  return {
    updated_at: anchors.formatChicago(new Date(now.getTime() - 60 * 60 * 1000)),
    networks: { xrpl_testnet: { network_id: 1, validated_ledger_index: 21130000 } },
    wallets: {
      W5: { regular_key: "rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q" },
      W2: { regular_key: "rNNzhkcScozB7Nzv3cWCZAEnu6MMC64rmy" },
    },
    watched: { batch: { atomic_enabled: false } },
  };
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labor-mpt-"));
  fs.mkdirSync(path.join(dir, "market"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "market", "pnl.md"),
    fs.readFileSync(path.join(anchors.repoRoot(), "market", "pnl.md"))
  );
  return dir;
}

test("XLS-89 metadata names AETH-LABOR, stays under 1024 bytes, and matches xrpl.js", () => {
  const obj = labor.metadataObject();
  assert.equal(obj.t, "LABOR");
  assert.equal(obj.n, "AETH-LABOR");
  assert.equal(obj.ai.symbol, "AETH-LABOR");
  assert.equal(obj.ac, "other");
  assert.equal(obj.t.includes("-"), false);
  assert.ok(obj.t.length <= 6);
  const hex = labor.encodeMetadata(obj);
  assert.equal(hex, xrpl.encodeMPTokenMetadata(obj));
  assert.ok(hex.length / 2 <= 1024);
  const decoded = labor.decodeMetadata(hex);
  assert.equal(decoded.n, "AETH-LABOR");
  assert.equal(decoded.t, "LABOR");
  const tx = labor.buildIssuance();
  assert.equal(tx.TransactionType, "MPTokenIssuanceCreate");
  assert.equal(tx.Account, anchors.WALLETS.W5.address);
  assert.equal(tx.MaximumAmount, "1000000");
  assert.equal(tx.AssetScale, 0);
  assert.equal(tx.TransferFee, 0);
  assert.equal(tx.Flags & labor.TF_MPT_CAN_TRANSFER, labor.TF_MPT_CAN_TRANSFER);
  assert.equal(tx.Flags & labor.TF_MPT_REQUIRE_AUTH, labor.TF_MPT_REQUIRE_AUTH);
  assert.equal(tx.Flags & labor.TF_MPT_CAN_ESCROW, labor.TF_MPT_CAN_ESCROW);
  assert.equal(tx.Flags & labor.TF_MPT_CAN_CLAWBACK, labor.TF_MPT_CAN_CLAWBACK);
  assert.equal(tx.Flags & labor.TF_MPT_CAN_TRADE, 0);
  assert.equal(tx.Flags & labor.TF_MPT_CAN_HOLD_CONFIDENTIAL, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(tx, "ImmutableFlags"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(tx, "DomainID"), false);
  assert.equal(tx.MPTokenMetadata, hex);
});

test("issuance id is the uint32 sequence plus the 20-byte account id", () => {
  for (const id of ["W0", "W2", "W5"]) {
    const address = anchors.WALLETS[id].address;
    assert.equal(
      labor.accountId(address).toString("hex"),
      Buffer.from(xrpl.decodeAccountID(address)).toString("hex")
    );
  }
  const sample = "000004C463C52827307480341125DA0577AFFC21D4B2D083";
  const address = xrpl.encodeAccountID(Buffer.from(sample.slice(8), "hex"));
  assert.equal(labor.issuanceId(0x4c4, address), sample);
  const predicted = labor.issuanceId(SEQUENCE, anchors.WALLETS.W5.address);
  assert.equal(predicted.length, 48);
  assert.equal(labor.isIssuanceId(predicted), true);
  assert.equal(anchors.HASH_RE.test(predicted), false);
});

test("dry-run prints an unsigned capped issuance and does not read a seed", async () => {
  const mock = mockLedger();
  let reads = 0;
  let captured = "";
  const code = await create.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { CI: "true", W5_REGULAR_SEED: "present-not-used" },
    now: NOW,
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.equal(captured.includes("present-not-used"), false);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "dry-run");
  assert.equal(body.signed, false);
  assert.equal(body.submitted, false);
  assert.equal(body.key_loaded, false);
  assert.equal(body.network_id, 1);
  assert.equal(body.intent, "mpt_labor_create");
  assert.equal(body.symbol, "AETH-LABOR");
  assert.equal(body.ticker, "LABOR");
  assert.equal(body.mpt_issuance_id, null);
  assert.equal(body.predicted_mpt_issuance_id, labor.issuanceId(SEQUENCE, anchors.WALLETS.W5.address));
  assert.equal(body.amendment.name, "MPTokensV1");
  assert.equal(body.amendment.enabled, true);
  assert.equal(body.tx.TransactionType, "MPTokenIssuanceCreate");
  assert.equal(body.tx.Account, anchors.WALLETS.W5.address);
  assert.equal(body.tx.MaximumAmount, "1000000");
  assert.equal(body.metadata.name, "AETH-LABOR");
  assert.equal(body.metadata.flags & labor.TF_MPT_CAN_TRANSFER, labor.TF_MPT_CAN_TRANSFER);
  assert.equal(captured.includes("NFTokenMint"), false);
  assert.equal(captured.includes("TokenEscrow"), false);
  assert.equal(captured.includes("CredentialCreate"), false);
  assert.equal(mock.calls.some((call) => call.method === "feature"), true);
  assert.equal(mock.calls.some((call) => call.method === "account_info"), true);
  const receipt = labor.receiptSketch(body.predicted_mpt_issuance_id);
  assert.equal(receipt.submitted, false);
  assert.equal(receipt.mint.TransactionType, "NFTokenMint");
  assert.equal(receipt.mint.Account, anchors.WALLETS.W2.address);
  assert.match(Buffer.from(receipt.mint.URI, "hex").toString("utf8"), /AETH-LABOR/);
});

test("refuses issuance when MPTokensV1 is disabled or omitted", async () => {
  for (const tweak of [{ disable: "MPTokensV1" }, { omit: "MPTokensV1" }]) {
    const mock = mockLedger(tweak);
    let reads = 0;
    let captured = "";
    const code = await create.run(["--xrpl-http", anchors.XRPL_HTTP], {
      env: { W5_REGULAR_SEED: "present-not-used" },
      now: NOW,
      fetchImpl: mock.fetchImpl,
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
      stdout(text) {
        captured = text;
      },
    });
    assert.equal(code, 2);
    assert.equal(reads, 0);
    const body = JSON.parse(captured);
    assert.equal(body.allow, false);
    assert.equal(body.code, "AMENDMENT");
    assert.equal(body.tx, null);
    assert.equal(body.mpt_issuance_id, null);
    assert.equal(body.predicted_mpt_issuance_id, null);
    assert.match(body.message, /MPTokensV1/);
    assert.equal(captured.includes('"TransactionType"'), false);
    assert.equal(captured.includes("Payment"), false);
    assert.equal(captured.includes("TrustSet"), false);
    assert.equal(mock.calls.some((call) => call.method === "account_info"), false);
    assert.equal(captured.includes("present-not-used"), false);
  }
});

test("refuses a network id other than 1 before building an issuance", async () => {
  for (const networkId of [0, 21337, 2]) {
    const mock = mockLedger({ network_id: networkId });
    let reads = 0;
    await assert.rejects(
      () => create.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
        env: {},
        now: NOW,
        fetchImpl: mock.fetchImpl,
        loadSeed() {
          reads += 1;
          return "nope";
        },
        stdout() {},
      }),
      (error) => error.code === "MAINNET" && new RegExp(String(networkId)).test(error.message)
    );
    assert.equal(reads, 0);
    assert.equal(mock.calls.some((call) => call.method === "feature"), false);
    assert.equal(mock.calls.some((call) => call.method === "account_info"), false);
  }
  await assert.rejects(
    () => create.run(["--dry-run", "--xrpl-http", "https://s1.ripple.com:51234"], {
      env: {},
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
});

test("live create refuses CI and archives only the issuance id the ledger returned", async () => {
  let reads = 0;
  await assert.rejects(
    () => create.run(["--live"], {
      env: { CI: "true", FOUNDRY_DAEMON_LIVE: "yes", W5_REGULAR_SEED: "present-not-used" },
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "CI"
  );
  assert.equal(reads, 0);
  const mock = mockLedger();
  const root = tempRoot();
  const issuance = labor.issuanceId(SEQUENCE, anchors.WALLETS.W5.address);
  let submitted = null;
  let captured = "";
  const code = await create.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now: NOW,
    state: freshState(NOW),
    root,
    fetchImpl: mock.fetchImpl,
    archive: false,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    submit(tx, keyEnv, regular) {
      submitted = { tx, keyEnv, regular };
      return {
        hash: TX_HASH,
        result: "tesSUCCESS",
        ledger_index: 21130011,
        meta: { mpt_issuance_id: issuance.toLowerCase() },
      };
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.equal(submitted.keyEnv, "W5_REGULAR_SEED");
  assert.equal(submitted.tx.TransactionType, "MPTokenIssuanceCreate");
  assert.equal(submitted.tx.Account, anchors.WALLETS.W5.address);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "live");
  assert.equal(body.hash, TX_HASH);
  assert.equal(body.mpt_issuance_id, issuance);
  assert.equal(body.signed, true);
  assert.equal(captured.includes("present-not-used"), false);
  const filed = metrics.readMetrics(root);
  assert.equal(filed.mpt_issuance_id, issuance);
  const refreshed = metrics.refresh(root, { now: NOW });
  assert.equal(refreshed.mpt_issuance_id, issuance);
  assert.throws(
    () => metrics.recordMpt(root, { hash: TX_HASH, mpt_issuance_id: "AB".repeat(32) }),
    (error) => error.code === "METRICS"
  );
});

test("authorize dry-run is an issuer MPTokenAuthorize for one holder", async () => {
  const mock = mockLedger();
  const issuance = labor.issuanceId(9, anchors.WALLETS.W5.address);
  let reads = 0;
  let captured = "";
  const code = await authorize.run([
    "--dry-run",
    "--xrpl-http",
    anchors.XRPL_HTTP,
    "--issuance-id",
    issuance.toLowerCase(),
  ], {
    env: { CI: "true", W5_REGULAR_SEED: "present-not-used" },
    now: NOW,
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "dry-run");
  assert.equal(body.signed, false);
  assert.equal(body.key_loaded, false);
  assert.equal(body.network_id, 1);
  assert.equal(body.intent, "mpt_labor_authorize");
  assert.equal(body.auth, "issuer");
  assert.equal(body.holder, anchors.WALLETS.W2.address);
  assert.equal(body.mpt_issuance_id, issuance);
  assert.equal(body.key_env, "W5_REGULAR_SEED");
  assert.equal(body.tx.TransactionType, "MPTokenAuthorize");
  assert.equal(body.tx.Account, anchors.WALLETS.W5.address);
  assert.equal(body.tx.Holder, anchors.WALLETS.W2.address);
  assert.equal(body.tx.MPTokenIssuanceID, issuance);
  assert.equal(body.tx.Flags, undefined);
  assert.equal(body.amendment.name, "MPTokensV1");
  assert.equal(captured.includes("present-not-used"), false);
  assert.equal(captured.includes("TokenEscrow"), false);

  let missing = "";
  const refused = await authorize.run(["--xrpl-http", anchors.XRPL_HTTP], {
    env: {},
    now: NOW,
    root: tempRoot(),
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      missing = text;
    },
  });
  assert.equal(refused, 2);
  const blank = JSON.parse(missing);
  assert.equal(blank.code, "MISSING_ISSUANCE");
  assert.equal(blank.tx, null);
  assert.equal(blank.mpt_issuance_id, null);

  let opted = "";
  const opt = await authorize.run([
    "--opt-in",
    "--issuance-id",
    issuance,
    "--xrpl-http",
    anchors.XRPL_HTTP,
  ], {
    env: {},
    now: NOW,
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      opted = text;
    },
  });
  assert.equal(opt, 0);
  const holderTx = JSON.parse(opted);
  assert.equal(holderTx.auth, "opt-in");
  assert.equal(holderTx.tx.Account, anchors.WALLETS.W2.address);
  assert.equal(Object.prototype.hasOwnProperty.call(holderTx.tx, "Holder"), false);
  assert.equal(holderTx.key_env, "W2_REGULAR_SEED");
});

test("authorize refuses a disabled amendment, the wrong network, and W0", async () => {
  const issuance = labor.issuanceId(9, anchors.WALLETS.W5.address);
  const disabled = mockLedger({ disable: "MPTokensV1" });
  let captured = "";
  const code = await authorize.run([
    "--issuance-id",
    issuance,
    "--xrpl-http",
    anchors.XRPL_HTTP,
  ], {
    env: {},
    now: NOW,
    fetchImpl: disabled.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 2);
  const body = JSON.parse(captured);
  assert.equal(body.code, "AMENDMENT");
  assert.equal(body.tx, null);
  assert.equal(disabled.calls.some((call) => call.method === "feature"), true);

  const mainnet = mockLedger({ network_id: 0 });
  await assert.rejects(
    () => authorize.run(["--issuance-id", issuance, "--xrpl-http", anchors.XRPL_HTTP], {
      env: {},
      now: NOW,
      fetchImpl: mainnet.fetchImpl,
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
  assert.equal(mainnet.calls.some((call) => call.method === "feature"), false);

  let w0 = "";
  const refused = await authorize.run([
    "--holder",
    anchors.WALLETS.W0.address,
    "--issuance-id",
    issuance,
    "--xrpl-http",
    anchors.XRPL_HTTP,
  ], {
    env: {},
    now: NOW,
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      w0 = text;
    },
  });
  assert.equal(refused, 2);
  assert.equal(JSON.parse(w0).code, "W0");
  assert.equal(JSON.parse(w0).tx, null);

  let reads = 0;
  await assert.rejects(
    () => authorize.run(["--live", "--opt-in", "--holder", "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth", "--issuance-id", issuance], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      fetchImpl: mockLedger().fetchImpl,
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
      stdout() {},
    }),
    (error) => error.code === "HOLDER"
  );
  assert.equal(reads, 0);
  await assert.rejects(
    () => authorize.run(["--live"], {
      env: { CI: "true", FOUNDRY_DAEMON_LIVE: "yes" },
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "CI"
  );
  assert.equal(reads, 0);
});

test("labor sources do not load a seed, a banned tx, or xrpl", () => {
  for (const file of ["mpt-labor.js", "mpt-labor-create.js", "mpt-labor-authorize.js"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.doesNotMatch(src, /fromSeed/);
    assert.doesNotMatch(src, /W0_SEED/);
    assert.doesNotMatch(src, /aether-foundry-secrets/);
    assert.doesNotMatch(src, /require\(["']xrpl["']\)/);
    assert.doesNotMatch(src, /TransactionType:\s*"Batch"/);
    assert.doesNotMatch(src, /TransactionType:\s*"TokenEscrow"/);
    assert.doesNotMatch(src, /TransactionType:\s*"CredentialCreate"/);
    assert.doesNotMatch(src, /ImmutableFlags\s*:/);
  }
  const allow = fs.readFileSync(path.join(anchors.repoRoot(), "src", "runtime", "allowlist.json"), "utf8");
  assert.equal(allow.includes("MPTokenIssuanceCreate"), false);
  assert.equal(allow.includes("MPTokenAuthorize"), false);
  assert.equal(allow.includes("mpt_labor_create"), false);
  assert.equal(probe.BANDS.A.includes("MPTokensV1"), true);
});
