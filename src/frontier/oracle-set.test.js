"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const codec = require("ripple-binary-codec");
const anchors = require("../director/anchors");
const schema = require("../director/schema");
const math = require("./oracle-math");
const keeper = require("./oracle-set");
const ticket = require("./oracle-ticket");
const probe = require("./probe-amendments");

const NOW = new Date("2026-09-28T23:30:00.000Z");
const ORACLE_INDEX = "AB".repeat(32);
const TX_HASH = "CD".repeat(32);

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

function book() {
  const iou = { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address };
  return {
    asks: [{ TakerPays: "1050000", TakerGets: Object.assign({ value: "100" }, iou) }],
    bids: [{ TakerGets: "950000", TakerPays: Object.assign({ value: "100" }, iou) }],
  };
}

function mockLedger(opts = {}) {
  const calls = [];
  const rows = (opts.rows || committedRows()).map((row) => {
    if (opts.disable === row.name) return Object.assign({}, row, { enabled: false });
    return row;
  }).filter((row) => row.name !== opts.omit);
  const sides = book();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: JSON.parse(init.body).method, body: JSON.parse(init.body) });
    const method = JSON.parse(init.body).method;
    if (opts.fail === method) {
      return jsonResponse({ status: "error", error: "nope", error_message: `${method} unavailable` });
    }
    if (method === "server_info") {
      const info = { build_version: "3.4.1" };
      if (opts.omitNetworkId !== true) info.network_id = opts.network_id == null ? 1 : opts.network_id;
      return jsonResponse({ info });
    }
    if (method === "feature") return jsonResponse(featureFromRows(rows));
    if (method === "amm_info") {
      return jsonResponse({
        validated: true,
        ledger_index: 21130000,
        amm: {
          account: anchors.AMM,
          amount: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "1000" },
          amount2: "10107546",
        },
      });
    }
    if (method === "book_offers") {
      const params = JSON.parse(init.body).params[0];
      const asks = params.taker_gets && params.taker_gets.currency !== "XRP";
      return jsonResponse({ offers: asks ? sides.asks : sides.bids, validated: true });
    }
    if (method === "ledger_entry") {
      if (opts.missingOracle) {
        return jsonResponse({ status: "error", error: "entryNotFound", error_message: "entryNotFound" });
      }
      return jsonResponse(opts.entry || sampleEntry());
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, calls };
}

function sampleEntry() {
  const encoded = math.encodeQuote("0.01007528");
  return {
    validated: true,
    ledger_index: 21130010,
    index: ORACLE_INDEX,
    node: {
      LedgerEntryType: "Oracle",
      Owner: anchors.WALLETS.W5.address,
      OracleDocumentID: math.ORACLE_DOCUMENT_ID,
      LastUpdateTime: 1759099800,
      Provider: math.providerHex(),
      AssetClass: math.assetClassHex(),
      PriceDataSeries: [
        {
          PriceData: {
            BaseAsset: "AETH",
            QuoteAsset: "XRP",
            AssetPrice: encoded.asset_price_hex,
            Scale: encoded.scale,
          },
        },
      ],
    },
  };
}

function freshState(now) {
  return {
    updated_at: anchors.formatChicago(new Date(now.getTime() - 60 * 60 * 1000)),
    networks: { xrpl_testnet: { network_id: 1, validated_ledger_index: 21130000 } },
    wallets: {
      W5: { regular_key: "rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q" },
      W2: { regular_key: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" },
    },
    watched: { batch: { atomic_enabled: false } },
  };
}

test("scale-8 oracle price round-trips into ticket drops", () => {
  const encoded = math.encodeQuote("0.01007528");
  assert.equal(encoded.scale, 8);
  assert.equal(encoded.asset_price, "1007528");
  assert.equal(encoded.asset_price_hex, "f5fa8");
  assert.equal(encoded.quote_xrp_per_aeth, "0.01007528");
  const read = math.readOraclePrice(sampleEntry());
  assert.equal(read.quote_xrp_per_aeth, "0.01007528");
  assert.equal(read.oracle_id, ORACLE_INDEX);
  assert.equal(math.dropsFromQuote(read.quote_xrp_per_aeth, 1), "10075");
  const historical = math.encodeQuote(0.010075282035960528);
  assert.equal(historical.quote_xrp_per_aeth, "0.01007528");
  assert.equal(math.dropsFromQuote(historical.quote_xrp_per_aeth, 1), "10075");
});

test("composite mid uses AMM 0.7 and CLOB 0.3, and AMM only when the book is thin", () => {
  const sides = book();
  const blended = math.compositeQuote(10.107546 / 1000, sides.bids, sides.asks);
  assert.equal(blended.clob_thin, false);
  assert.equal(blended.weights.amm, 0.7);
  assert.equal(blended.weights.clob, 0.3);
  assert.equal(blended.best_bid, 0.0095);
  assert.equal(blended.best_ask, 0.0105);
  assert.equal(blended.mid_clob, 0.01);
  const expected = 0.7 * (10.107546 / 1000) + 0.3 * 0.01;
  assert.equal(blended.encoded.quote_xrp_per_aeth, expected.toFixed(8));
  const thin = math.compositeQuote(0.02, [], sides.asks);
  assert.equal(thin.clob_thin, true);
  assert.equal(thin.weights.amm, 1);
  assert.equal(thin.encoded.quote_xrp_per_aeth, "0.02");
});

test("dry-run prints an unsigned OracleSet and does not read a seed", async () => {
  const mock = mockLedger();
  let reads = 0;
  let captured = "";
  const code = await keeper.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
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
  assert.equal(body.intent, "oracle_set");
  assert.equal(body.amendment.name, "PriceOracle");
  assert.equal(body.amendment.enabled, true);
  assert.equal(body.tx.TransactionType, "OracleSet");
  assert.equal(body.tx.Account, anchors.WALLETS.W5.address);
  assert.equal(body.tx.OracleDocumentID, 1);
  assert.equal(body.tx.LastUpdateTime, Math.floor(NOW.getTime() / 1000));
  assert.ok(body.tx.LastUpdateTime > 1_600_000_000);
  assert.equal(body.tx.PriceDataSeries[0].PriceData.BaseAsset, anchors.AETH_HEX);
  assert.equal(body.tx.PriceDataSeries[0].PriceData.QuoteAsset, "XRP");
  assert.equal(body.tx.PriceDataSeries[0].PriceData.Scale, 8);
  const decoded = math.decodeScaled(
    body.tx.PriceDataSeries[0].PriceData.AssetPrice,
    body.tx.PriceDataSeries[0].PriceData.Scale
  );
  assert.equal(decoded.quote_xrp_per_aeth, body.quote.quote_xrp_per_aeth);
  assert.equal(mock.calls.some((call) => call.method === "feature"), true);
  assert.equal(mock.calls.some((call) => call.method === "amm_info"), true);
  assert.equal(mock.calls.filter((call) => call.method === "book_offers").length, 2);
});

test("refuses OracleSet when PriceOracle is disabled or omitted", async () => {
  for (const tweak of [{ disable: "PriceOracle" }, { omit: "PriceOracle" }]) {
    const mock = mockLedger(tweak);
    let reads = 0;
    let captured = "";
    const code = await keeper.run(["--xrpl-http", anchors.XRPL_HTTP], {
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
    assert.match(body.message, /PriceOracle/);
    assert.equal(captured.includes("present-not-used"), false);
  }
});

test("refuses a network id other than 1 before building OracleSet", async () => {
  for (const networkId of [0, 21337, 2]) {
    const mock = mockLedger({ network_id: networkId });
    let reads = 0;
    await assert.rejects(
      () => keeper.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
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
    assert.equal(mock.calls.some((call) => call.method === "amm_info"), false);
  }
  await assert.rejects(
    () => keeper.run(["--dry-run", "--xrpl-http", "https://s1.ripple.com:51234"], {
      env: {},
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
});

test("live refuses CI before a seed read and submits only with the gate open", async () => {
  let reads = 0;
  await assert.rejects(
    () => keeper.run(["--live"], {
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
  let submitted = null;
  let captured = "";
  const code = await keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now: NOW,
    state: freshState(NOW),
    root: fs.mkdtempSync(path.join(os.tmpdir(), "oracle-live-")),
    fetchImpl: mock.fetchImpl,
    recordMetrics: false,
    archive: false,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    submit(tx, keyEnv, regular) {
      submitted = { tx, keyEnv, regular };
      return { hash: TX_HASH, result: "tesSUCCESS", ledger_index: 21130011 };
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.equal(submitted.keyEnv, "W5_REGULAR_SEED");
  assert.equal(submitted.tx.TransactionType, "OracleSet");
  assert.equal(submitted.tx.Account, anchors.WALLETS.W5.address);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "live");
  assert.equal(body.hash, TX_HASH);
  assert.equal(body.oracle_id, ORACLE_INDEX);
  assert.equal(body.signed, true);
  assert.equal(captured.includes("present-not-used"), false);
});

test("ticket price comes from ledger_entry and ignores a local float", async () => {
  const mock = mockLedger();
  let captured = "";
  const code = await ticket.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { CI: "true", W2_REGULAR_SEED: "present-not-used" },
    now: NOW,
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      throw new Error("seed");
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  const body = JSON.parse(captured);
  assert.equal(body.source, "ledger_entry");
  assert.equal(body.oracle_id, ORACLE_INDEX);
  assert.equal(body.oracle.quote_xrp_per_aeth, "0.01007528");
  assert.equal(body.ticket.labor_drops, "10075");
  assert.equal(body.ticket.escrow.Amount, "10075");
  assert.equal(body.ticket.sell.Amount, "10075");
  assert.equal(body.ticket.mint.Account, anchors.WALLETS.W2.address);
  assert.equal(body.ticket.escrow.Destination, anchors.WALLETS.W4.address);
  assert.ok(body.ticket.escrow.FinishAfter < 1_000_000_000);
  assert.ok(body.ticket.escrow.CancelAfter > body.ticket.escrow.FinishAfter);
  assert.equal(mock.calls.some((call) => call.method === "amm_info"), false);
  assert.equal(mock.calls.some((call) => call.method === "book_offers"), false);
  assert.equal(mock.calls.some((call) => call.method === "ledger_entry"), true);
  const params = mock.calls.find((call) => call.method === "ledger_entry").body.params[0];
  assert.equal(params.oracle.account, anchors.WALLETS.W5.address);
  assert.equal(params.oracle.oracle_document_id, 1);
  assert.equal(captured.includes("present-not-used"), false);
});

test("ticket refuses a missing oracle and a wrong network", async () => {
  const missing = mockLedger({ missingOracle: true });
  await assert.rejects(
    () => ticket.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
      env: {},
      now: NOW,
      fetchImpl: missing.fetchImpl,
      stdout() {},
    }),
    (error) => error.code === "ORACLE_MISSING"
  );
  assert.equal(missing.calls.some((call) => call.method === "amm_info"), false);
  const mainnet = mockLedger({ network_id: 0 });
  await assert.rejects(
    () => ticket.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
      env: {},
      now: NOW,
      fetchImpl: mainnet.fetchImpl,
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
  assert.equal(mainnet.calls.some((call) => call.method === "ledger_entry"), false);
  let reads = 0;
  await assert.rejects(
    () => ticket.run(["--live"], {
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

test("OracleSet emits codec-submittable AETH hex and XRP", () => {
  const tx = math.buildOracleSet({ quote_xrp_per_aeth: "0.01022008", now: NOW });
  const pair = tx.PriceDataSeries[0].PriceData;
  assert.equal(pair.BaseAsset, anchors.AETH_HEX);
  assert.equal(pair.QuoteAsset, "XRP");
  assert.equal(pair.BaseAsset.length, 40);
  const blob = codec.encode(tx);
  const back = codec.decode(blob);
  assert.equal(back.PriceDataSeries[0].PriceData.BaseAsset, anchors.AETH_HEX);
  assert.equal(back.PriceDataSeries[0].PriceData.QuoteAsset, "XRP");
  const zeros = structuredClone(tx);
  zeros.PriceDataSeries[0].PriceData.QuoteAsset = math.XRP_HEX;
  assert.equal(codec.encode(zeros), blob);
  const ascii = structuredClone(tx);
  ascii.PriceDataSeries[0].PriceData.BaseAsset = "AETH";
  assert.throws(() => codec.encode(ascii), /Unsupported Currency representation: AETH/);
  const wire = sampleEntry();
  wire.node.PriceDataSeries[0].PriceData.BaseAsset = anchors.AETH_HEX;
  wire.node.PriceDataSeries[0].PriceData.QuoteAsset = "XRP";
  assert.equal(math.readOraclePrice(wire).quote_xrp_per_aeth, "0.01007528");
});

function stateIo(text) {
  return {
    existsSync(file) {
      return String(file).endsWith(path.join("lab", "director-state.json"));
    },
    readFileSync(file, encoding) {
      if (String(file).endsWith(path.join("lab", "director-state.json"))) return text;
      return fs.readFileSync(file, encoding);
    },
  };
}

test("live loads director-state from disk and still refuses the gate", async () => {
  let reads = 0;
  await assert.rejects(
    () => keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: {},
      now: NOW,
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "LIVE_GATE"
  );
  await assert.rejects(
    () => keeper.run(["--live"], {
      env: { GITHUB_ACTIONS: "true", FOUNDRY_DAEMON_LIVE: "yes" },
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

  const missing = mockLedger();
  await assert.rejects(
    () => keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      root: fs.mkdtempSync(path.join(os.tmpdir(), "oracle-missing-")),
      fetchImpl: missing.fetchImpl,
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "STALE" && /without director state/.test(error.message)
  );
  assert.equal(reads, 0);

  const injected = mockLedger();
  await assert.rejects(
    () => keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      state: null,
      io: {
        existsSync() {
          throw new Error("injected state must not read disk");
        },
        readFileSync() {
          throw new Error("injected state must not read disk");
        },
      },
      fetchImpl: injected.fetchImpl,
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "STALE" && /without director state/.test(error.message)
  );

  const stale = schema.fixtureState();
  stale.updated_at = "2026-09-01T12:00:00-05:00";
  await assert.rejects(
    () => keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      root: anchors.repoRoot(),
      io: stateIo(JSON.stringify(stale)),
      fetchImpl: mockLedger().fetchImpl,
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "STALE" && /stale director state/.test(error.message)
  );
  assert.equal(reads, 0);

  const fresh = schema.fixtureState();
  fresh.updated_at = anchors.formatChicago(new Date(NOW.getTime() - 60 * 60 * 1000));
  const mock = mockLedger();
  let submitted = null;
  const code = await keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now: NOW,
    root: anchors.repoRoot(),
    io: stateIo(JSON.stringify(fresh)),
    fetchImpl: mock.fetchImpl,
    recordMetrics: false,
    archive: false,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    submit(tx, keyEnv, regular) {
      submitted = { tx, keyEnv, regular };
      return { hash: TX_HASH, result: "tesSUCCESS", ledger_index: 21130011, oracle_id: ORACLE_INDEX };
    },
    stdout() {},
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.equal(submitted.keyEnv, "W5_REGULAR_SEED");
  assert.equal(submitted.regular, fresh.wallets.W5.regular_key);
  assert.equal(submitted.tx.PriceDataSeries[0].PriceData.BaseAsset, anchors.AETH_HEX);
  assert.equal(submitted.tx.PriceDataSeries[0].PriceData.QuoteAsset, "XRP");
  assert.equal(codec.encode(submitted.tx).length > 0, true);

  const mainnet = mockLedger({ network_id: 0 });
  await assert.rejects(
    () => keeper.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      root: anchors.repoRoot(),
      io: stateIo(JSON.stringify(fresh)),
      fetchImpl: mainnet.fetchImpl,
      loadSeed() {
        reads += 1;
        return "present-not-used";
      },
    }),
    (error) => error.code === "MAINNET"
  );
  assert.equal(reads, 0);
});

test("ticket live loads director-state from disk", async () => {
  const fresh = schema.fixtureState();
  fresh.updated_at = anchors.formatChicago(new Date(NOW.getTime() - 60 * 60 * 1000));
  const mock = mockLedger();
  let submitted = null;
  const code = await ticket.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now: NOW,
    root: anchors.repoRoot(),
    io: stateIo(JSON.stringify(fresh)),
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      throw new Error("seed");
    },
    submit(tx, keyEnv, regular) {
      submitted = { tx, keyEnv, regular };
      return { hash: TX_HASH, result: "tesSUCCESS", ledger_index: 21130012 };
    },
    stdout() {},
  });
  assert.equal(code, 0);
  assert.equal(submitted.keyEnv, "W2_REGULAR_SEED");
  assert.equal(submitted.regular, fresh.wallets.W2.regular_key);
  assert.equal(submitted.tx.TransactionType, "NFTokenMint");
  const missing = mockLedger();
  await assert.rejects(
    () => ticket.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      root: fs.mkdtempSync(path.join(os.tmpdir(), "ticket-missing-")),
      fetchImpl: missing.fetchImpl,
      stdout() {},
    }),
    (error) => error.code === "STALE" && /without director state/.test(error.message)
  );
});

test("keeper and ticket sources do not load a seed or a banned tx", () => {
  for (const file of ["oracle-set.js", "oracle-ticket.js", "oracle-math.js"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.doesNotMatch(src, /fromSeed/);
    assert.doesNotMatch(src, /W0_SEED/);
    assert.doesNotMatch(src, /aether-foundry-secrets/);
    assert.doesNotMatch(src, /TransactionType:\s*"Batch"/);
    assert.doesNotMatch(src, /TransactionType:\s*"TokenEscrow"/);
    assert.doesNotMatch(src, /require\(["']xrpl["']\)/);
  }
  const allow = fs.readFileSync(path.join(anchors.repoRoot(), "src", "runtime", "allowlist.json"), "utf8");
  assert.equal(allow.includes("OracleSet"), false);
  assert.equal(allow.includes("oracle_set"), false);
});
