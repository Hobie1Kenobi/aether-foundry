"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const codec = require("ripple-binary-codec");
const anchors = require("../director/anchors");
const policy = require("../runtime/policy");
const probe = require("./probe-amendments");
const labor = require("./mpt-labor");
const math = require("./oracle-math");
const escrow = require("./token-escrow-labor");
const create = require("./token-escrow-create");
const finish = require("./token-escrow-finish");
const cancel = require("./token-escrow-cancel");
const { rippleNow } = require("../time/rippleEpoch");

const NOW = new Date("2026-09-29T00:10:00.000Z");
const UNIX_NOW = Math.floor(NOW.getTime() / 1000);
const SEQUENCE = 21134010;
const OFFER = 21134011;
const TX_HASH = "AB".repeat(32);
const ISSUANCE = labor.issuanceId(SEQUENCE, anchors.WALLETS.W5.address);
const F2_ISSUANCE = "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED";

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

function oracleEntry(quote) {
  const encoded = math.encodeQuote(quote);
  return {
    index: "CD".repeat(32),
    ledger_index: 21130010,
    node: {
      LedgerEntryType: "Oracle",
      Owner: anchors.WALLETS.W5.address,
      OracleDocumentID: 1,
      LastUpdateTime: UNIX_NOW,
      PriceDataSeries: [
        {
          PriceData: {
            BaseAsset: anchors.AETH_HEX,
            QuoteAsset: "XRP",
            AssetPrice: encoded.asset_price_hex,
            Scale: encoded.scale,
          },
        },
      ],
    },
  };
}

function mockLedger(opts = {}) {
  const calls = [];
  const rows = (opts.rows || committedRows()).map((row) => {
    if (opts.disable === row.name) return Object.assign({}, row, { enabled: false });
    return row;
  }).filter((row) => row.name !== opts.omit);
  const fetchImpl = async (url, init) => {
    const method = JSON.parse(init.body).method;
    calls.push({ url: String(url), method });
    if (method === "server_info") {
      const info = { build_version: "3.4.1" };
      if (opts.omitNetworkId !== true) info.network_id = opts.network_id == null ? 1 : opts.network_id;
      return jsonResponse({ info });
    }
    if (method === "feature") return jsonResponse(featureFromRows(rows));
    if (method === "account_info") {
      return jsonResponse({
        validated: true,
        account_data: { Account: anchors.WALLETS.W2.address, Sequence: SEQUENCE },
      });
    }
    if (method === "ledger_entry") {
      if (opts.oracle === false) {
        return {
          ok: false,
          status: 200,
          async json() {
            return { result: { status: "error", error: "entryNotFound" } };
          },
        };
      }
      return jsonResponse(oracleEntry(opts.oracle || "0.01022008"));
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
      W2: { regular_key: "rNNzhkcScozB7Nzv3cWCZAEnu6MMC64rmy" },
      W4: { regular_key: "rfXBxqPjprj1J5Ekq5v82D3BDqRm7ms7p2" },
      W6: { regular_key: "rGjdFjMz577GF4uvb4N9ayCqP74kwVq5" },
    },
    watched: { batch: { atomic_enabled: false } },
  };
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-escrow-"));
  fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
  const doc = JSON.parse(fs.readFileSync(path.join(anchors.repoRoot(), "lab", "metrics.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "lab", "metrics.json"), `${JSON.stringify(doc, null, 2)}\n`);
  return dir;
}

function wire(tx) {
  return Object.assign({
    Fee: "12",
    Sequence: 1,
    SigningPubKey: "ED".padEnd(66, "0"),
  }, tx);
}

test("Ripple Epoch passes and Unix-looking times are refused", () => {
  assert.ok(UNIX_NOW > escrow.UNIX_LINE);
  assert.ok(rippleNow(NOW) < escrow.UNIX_LINE);
  assert.equal(escrow.assertRippleTime(rippleNow(NOW) + 120, "FinishAfter"), rippleNow(NOW) + 120);
  assert.equal(escrow.assertRippleTime(String(rippleNow(NOW) + 3600), "CancelAfter"), rippleNow(NOW) + 3600);
  assert.equal(escrow.assertRippleTime(escrow.UNIX_LINE, "FinishAfter"), escrow.UNIX_LINE);
  for (const sample of [UNIX_NOW, UNIX_NOW * 1000, escrow.UNIX_LINE + 1, 1790639158]) {
    assert.throws(() => escrow.assertRippleTime(sample, "FinishAfter"), (error) => error.code === "EPOCH");
    assert.throws(() => escrow.assertRippleTime(String(sample), "CancelAfter"), (error) => error.code === "EPOCH");
  }
  assert.throws(() => escrow.assertRippleTime(0, "FinishAfter"), (error) => error.code === "EPOCH");
  assert.throws(() => escrow.assertRippleTime(-1, "CancelAfter"), (error) => error.code === "EPOCH");
  assert.throws(() => escrow.assertRippleTime(1.5, "FinishAfter"), (error) => error.code === "EPOCH");
});

test("create locks AETH until an issuance id exists, and MPT when it does", () => {
  const aeth = escrow.buildCreate({ now: NOW, asset: escrow.resolveAsset({}) });
  assert.equal(aeth.tx.TransactionType, "EscrowCreate");
  assert.equal(aeth.tx.Account, anchors.WALLETS.W2.address);
  assert.equal(aeth.tx.Destination, anchors.WALLETS.W4.address);
  assert.equal(aeth.tx.Amount.currency, anchors.AETH_HEX);
  assert.equal(aeth.tx.Amount.issuer, anchors.WALLETS.W0.address);
  assert.equal(aeth.tx.Amount.value, "1");
  assert.equal(typeof aeth.tx.Amount, "object");
  assert.equal(aeth.asset.kind, "aeth");
  assert.ok(aeth.tx.FinishAfter < escrow.UNIX_LINE);
  assert.ok(aeth.tx.CancelAfter > aeth.tx.FinishAfter);
  assert.equal(aeth.tx.FinishAfter, rippleNow(NOW) + escrow.FINISH_DELAY);
  assert.equal(aeth.tx.CancelAfter, rippleNow(NOW) + escrow.CANCEL_DELAY);
  assert.equal(Object.hasOwn(aeth.tx, "Condition"), false);
  const mpt = escrow.buildCreate({ now: NOW, asset: escrow.resolveAsset({ issuanceId: ISSUANCE }) });
  assert.equal(mpt.tx.Amount.mpt_issuance_id, ISSUANCE);
  assert.equal(mpt.tx.Amount.value, "1");
  assert.equal(Object.hasOwn(mpt.tx.Amount, "currency"), false);
  const backAeth = codec.decode(codec.encode(wire(aeth.tx)));
  const backMpt = codec.decode(codec.encode(wire(mpt.tx)));
  assert.equal(backAeth.Amount.currency, anchors.AETH_HEX);
  assert.equal(backMpt.Amount.mpt_issuance_id, ISSUANCE);
  assert.equal(backMpt.Amount.value, "1");
  assert.throws(
    () => escrow.buildCreate({ now: NOW, asset: aeth.asset, finishAfter: UNIX_NOW, cancelAfter: rippleNow(NOW) + 3600 }),
    (error) => error.code === "EPOCH"
  );
  assert.throws(
    () => escrow.buildCreate({ now: NOW, asset: aeth.asset, finishAfter: rippleNow(NOW) + 10, cancelAfter: UNIX_NOW }),
    (error) => error.code === "EPOCH"
  );
});

test("XRP amount, crypto-condition, credentials, and Batch are refused", () => {
  const tx = escrow.buildCreate({ now: NOW }).tx;
  const xrp = Object.assign({}, tx, { Amount: "1000000" });
  assert.throws(() => escrow.assertBoxTx(xrp), (error) => error.code === "ASSET");
  const condition = Object.assign({}, tx, { Condition: "A0".repeat(16) });
  assert.throws(() => escrow.assertBoxTx(condition), (error) => error.code === "TX");
  assert.throws(
    () => escrow.assertBoxTx({ TransactionType: "Payment", Account: anchors.WALLETS.W2.address, Amount: "1" }),
    (error) => error.code === "TX"
  );
  assert.throws(
    () => escrow.assertBoxTx({ TransactionType: "Batch", Account: anchors.WALLETS.W2.address }),
    (error) => error.code === "TX"
  );
  assert.throws(
    () => escrow.assertBoxTx(Object.assign({}, tx, { CredentialIDs: ["AA"] })),
    (error) => error.code === "TX"
  );
  assert.throws(
    () => escrow.assertBoxTx({ TransactionType: "EscrowCreate", Account: anchors.WALLETS.W0.address, Amount: tx.Amount }),
    (error) => error.code === "W0"
  );
});

test("daemon still bans finish and cancel; this pack still builds them and refuses the scar", () => {
  const created = escrow.buildCreate({ now: NOW });
  policy.assertSigningTx(created.tx);
  const done = escrow.buildFinish({ offerSequence: OFFER });
  const stopped = escrow.buildCancel({ offerSequence: OFFER });
  assert.throws(() => policy.assertSigningTx(done.tx), (error) => error.code === "BANNED");
  assert.throws(() => policy.assertSigningTx(stopped.tx), (error) => error.code === "BANNED");
  escrow.assertBoxTx(done.tx);
  escrow.assertBoxTx(stopped.tx);
  assert.equal(done.tx.Account, anchors.WALLETS.W4.address);
  assert.equal(done.tx.Owner, anchors.WALLETS.W2.address);
  assert.equal(stopped.tx.Account, anchors.WALLETS.W2.address);
  assert.equal(Object.hasOwn(done.tx, "FinishAfter"), false);
  assert.equal(Object.hasOwn(stopped.tx, "CancelAfter"), false);
  assert.throws(
    () => escrow.buildFinish({ owner: policy.EPOCH_SCAR.owner, offerSequence: policy.EPOCH_SCAR.offerSequence }),
    (error) => error.code === "EPOCH_SCAR"
  );
  assert.throws(
    () => escrow.buildCancel({ owner: policy.EPOCH_SCAR.owner, offerSequence: 2113 }),
    (error) => error.code === "EPOCH_SCAR"
  );
  const scarred = escrow.buildFinish({ offerSequence: OFFER });
  scarred.tx.Memos.push({
    Memo: { MemoType: "6E6F7465", MemoData: policy.EPOCH_SCAR.hash },
  });
  assert.throws(() => escrow.assertBoxTx(scarred.tx), (error) => error.code === "EPOCH_SCAR");
  assert.throws(
    () => policy.assertEpochScar({
      TransactionType: "EscrowFinish",
      Account: anchors.WALLETS.W4.address,
      Owner: policy.EPOCH_SCAR.owner,
      OfferSequence: policy.EPOCH_SCAR.offerSequence,
    }),
    (error) => error.code === "EPOCH_SCAR"
  );
});

test("rebate pays the XRP drift, capped at 1 XRP, and refuses a Unix expiration", () => {
  const flat = escrow.rebateDrops("0.01022008", "0.01022008");
  assert.equal(flat.drops, null);
  assert.equal(flat.code, "NO_DRIFT");
  const fell = escrow.rebateDrops("0.02", "0.01");
  assert.equal(fell.code, "QUOTE_FELL");
  const rose = escrow.buildRebate({ quoted: "0.01", current: "0.02", now: NOW });
  assert.equal(rose.drops, "10000");
  assert.equal(rose.tx.TransactionType, "CheckCreate");
  assert.equal(rose.tx.Account, anchors.WALLETS.W6.address);
  assert.equal(rose.tx.Destination, anchors.WALLETS.W2.address);
  assert.equal(rose.tx.SendMax, "10000");
  assert.ok(rose.tx.Expiration < escrow.UNIX_LINE);
  assert.notEqual(rose.tx.Expiration, UNIX_NOW);
  assert.equal(rose.tx.Expiration, rippleNow(NOW) + escrow.REBATE_DELAY);
  const capped = escrow.buildRebate({ quoted: "0.01", current: "100", now: NOW });
  assert.equal(capped.drops, "1000000");
  assert.equal(capped.capped, true);
  assert.throws(
    () => escrow.buildRebate({ quoted: "0.01", current: "0.02", now: NOW, expiration: UNIX_NOW }),
    (error) => error.code === "EPOCH"
  );
  const dust = escrow.rebateDrops("0.01022008", "0.01022009");
  assert.equal(dust.code, "DUST");
});

test("dry-run create locks the issued AETH-LABOR id and does not read a seed", async () => {
  const mock = mockLedger();
  let reads = 0;
  let captured = "";
  const code = await create.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { CI: "true", W2_REGULAR_SEED: "present-not-used", W0_SEED: "present-not-used" },
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
  assert.equal(body.intent, "token_escrow_labor_create");
  assert.equal(body.amendment.name, "TokenEscrow");
  assert.equal(body.amendment.enabled, true);
  assert.equal(body.asset.kind, "mpt");
  assert.equal(body.mpt_issuance_id, F2_ISSUANCE);
  assert.equal(body.quote.quote_xrp_per_aeth, "0.01022008");
  assert.equal(body.quote.code, "LEDGER");
  assert.equal(body.predicted_sequence, SEQUENCE);
  assert.equal(body.tx.Amount.mpt_issuance_id, F2_ISSUANCE);
  assert.equal(body.tx.Amount.value, "1");
  assert.equal(Object.hasOwn(body.tx.Amount, "currency"), false);
  assert.equal(body.tx.Account, anchors.WALLETS.W2.address);
  assert.notEqual(body.tx.Account, anchors.WALLETS.W0.address);
  assert.ok(body.tx.FinishAfter < escrow.UNIX_LINE);
  assert.notEqual(body.tx.FinishAfter, UNIX_NOW);
  assert.equal(body.deliverable.submitted, false);
  assert.equal(body.deliverable.mint.TransactionType, "NFTokenMint");
  assert.equal(body.deliverable.mint.Account, anchors.WALLETS.W2.address);
  const uri = Buffer.from(body.deliverable.mint.URI, "hex").toString("utf8");
  assert.match(uri, new RegExp(F2_ISSUANCE));
  assert.match(uri, /AETH-LABOR/);
  assert.equal(uri.includes("Credential"), false);
  assert.equal(captured.includes("CredentialCreate"), false);
  assert.equal(captured.includes("PermissionedDomain"), false);
  assert.equal(captured.includes("\"Batch\""), false);
  assert.equal(mock.calls.some((call) => call.method === "feature"), true);
});

test("dry-run create uses AETH when metrics has no issuance id", async () => {
  const root = tempRoot();
  const doc = JSON.parse(fs.readFileSync(path.join(root, "lab", "metrics.json"), "utf8"));
  doc.mpt_issuance_id = null;
  fs.writeFileSync(path.join(root, "lab", "metrics.json"), `${JSON.stringify(doc, null, 2)}\n`);
  const mock = mockLedger();
  let captured = "";
  const code = await create.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
    env: {},
    now: NOW,
    root,
    fetchImpl: mock.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  const body = JSON.parse(captured);
  assert.equal(body.asset.kind, "aeth");
  assert.equal(body.mpt_issuance_id, null);
  assert.equal(body.tx.Amount.currency, anchors.AETH_HEX);
  assert.equal(body.tx.Amount.issuer, anchors.WALLETS.W0.address);
  assert.equal(body.tx.Amount.value, "1");
  const uri = Buffer.from(body.deliverable.mint.URI, "hex").toString("utf8");
  assert.match(uri, /asset=AETH/);
});

test("dry-run create locks an issuance id from lab metrics", async () => {
  const root = tempRoot();
  const doc = JSON.parse(fs.readFileSync(path.join(root, "lab", "metrics.json"), "utf8"));
  doc.mpt_issuance_id = ISSUANCE.toLowerCase();
  fs.writeFileSync(path.join(root, "lab", "metrics.json"), `${JSON.stringify(doc, null, 2)}\n`);
  const mock = mockLedger();
  let captured = "";
  const code = await create.run(["--xrpl-http", anchors.XRPL_HTTP], {
    env: {},
    now: NOW,
    root,
    fetchImpl: mock.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  const body = JSON.parse(captured);
  assert.equal(body.asset.kind, "mpt");
  assert.equal(body.mpt_issuance_id, ISSUANCE);
  assert.equal(body.tx.Amount.mpt_issuance_id, ISSUANCE);
  assert.equal(body.tx.Amount.value, "1");
  assert.equal(Object.hasOwn(body.tx.Amount, "currency"), false);
  const uri = Buffer.from(body.deliverable.mint.URI, "hex").toString("utf8");
  assert.match(uri, new RegExp(ISSUANCE));
  assert.match(uri, /AETH-LABOR/);
});

test("refuses TokenEscrow when it is disabled or omitted and does not substitute a payment", async () => {
  for (const tweak of [{ disable: "TokenEscrow" }, { omit: "TokenEscrow" }]) {
    const mock = mockLedger(tweak);
    let reads = 0;
    let captured = "";
    const code = await create.run(["--xrpl-http", anchors.XRPL_HTTP], {
      env: { W2_REGULAR_SEED: "present-not-used" },
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
    assert.equal(body.deliverable, null);
    assert.match(body.message, /TokenEscrow/);
    assert.equal(captured.includes('"TransactionType"'), false);
    assert.equal(captured.includes("Payment"), false);
    assert.equal(captured.includes("CheckCreate"), false);
    assert.equal(captured.includes("NFTokenMint"), false);
    assert.equal(mock.calls.some((call) => call.method === "account_info"), false);
    assert.equal(mock.calls.some((call) => call.method === "ledger_entry"), false);
    if (tweak.disable) assert.equal(body.amendment.enabled, false);
  }
});

test("refuses an MPT lock when MPTokensV1 is disabled instead of falling back to AETH", async () => {
  const root = tempRoot();
  const doc = JSON.parse(fs.readFileSync(path.join(root, "lab", "metrics.json"), "utf8"));
  doc.mpt_issuance_id = ISSUANCE;
  fs.writeFileSync(path.join(root, "lab", "metrics.json"), `${JSON.stringify(doc, null, 2)}\n`);
  const mock = mockLedger({ disable: "MPTokensV1" });
  let captured = "";
  const code = await create.run(["--xrpl-http", anchors.XRPL_HTTP], {
    env: {},
    now: NOW,
    root,
    fetchImpl: mock.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 2);
  const body = JSON.parse(captured);
  assert.equal(body.code, "AMENDMENT");
  assert.match(body.message, /MPTokensV1/);
  assert.equal(body.tx, null);
  assert.equal(captured.includes(anchors.AETH_HEX), false);
  assert.equal(captured.includes(ISSUANCE), false);
  assert.equal(mock.calls.some((call) => call.method === "account_info"), false);
});

test("refuses a network id other than 1 before feature", async () => {
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
  }
  await assert.rejects(
    () => finish.run(["--offer-sequence", String(OFFER), "--xrpl-http", "https://s1.ripple.com:51234"], {
      env: {},
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
});

test("create CLI refuses a Unix FinishAfter and a Unix CancelAfter", async () => {
  for (const args of [
    ["--finish-after", String(UNIX_NOW), "--cancel-after", String(rippleNow(NOW) + 4000)],
    ["--finish-after", String(rippleNow(NOW) + 30), "--cancel-after", String(UNIX_NOW)],
  ]) {
    const mock = mockLedger();
    let captured = "";
    const code = await create.run(["--xrpl-http", anchors.XRPL_HTTP].concat(args), {
      env: {},
      now: NOW,
      fetchImpl: mock.fetchImpl,
      stdout(text) {
        captured = text;
      },
    });
    assert.equal(code, 2);
    const body = JSON.parse(captured);
    assert.equal(body.code, "EPOCH");
    assert.equal(body.tx, null);
    assert.equal(body.deliverable, null);
    assert.equal(captured.includes(`"FinishAfter": ${UNIX_NOW}`), false);
    assert.equal(captured.includes("Payment"), false);
  }
});

test("finish and cancel dry-runs print both paths and refuse the scar owner", async () => {
  const mock = mockLedger({ oracle: "0.02000000" });
  let finishText = "";
  const finishCode = await finish.run([
    "--xrpl-http",
    anchors.XRPL_HTTP,
    "--offer-sequence",
    String(OFFER),
    "--quoted",
    "0.01000000",
  ], {
    env: { W4_REGULAR_SEED: "present-not-used" },
    now: NOW,
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      return "present-not-used";
    },
    stdout(text) {
      finishText = text;
    },
  });
  assert.equal(finishCode, 0);
  const finished = JSON.parse(finishText);
  assert.equal(finished.tx.TransactionType, "EscrowFinish");
  assert.equal(finished.tx.OfferSequence, OFFER);
  assert.equal(finished.tx.Owner, anchors.WALLETS.W2.address);
  assert.equal(Object.hasOwn(finished.tx, "FinishAfter"), false);
  assert.equal(finished.rebate.tx.TransactionType, "CheckCreate");
  assert.equal(finished.rebate.drops, "10000");
  assert.ok(finished.rebate.tx.Expiration < escrow.UNIX_LINE);
  assert.notEqual(finished.rebate.tx.Expiration, UNIX_NOW);
  assert.equal(finished.key_loaded, false);
  assert.equal(finishText.includes("present-not-used"), false);
  assert.equal(finishText.includes("CredentialCreate"), false);

  let cancelText = "";
  const cancelCode = await cancel.run([
    "--xrpl-http",
    anchors.XRPL_HTTP,
    "--offer-sequence",
    String(OFFER),
  ], {
    env: {},
    now: NOW,
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      cancelText = text;
    },
  });
  assert.equal(cancelCode, 0);
  const cancelled = JSON.parse(cancelText);
  assert.equal(cancelled.tx.TransactionType, "EscrowCancel");
  assert.equal(cancelled.tx.OfferSequence, OFFER);
  assert.equal(cancelled.tx.Account, anchors.WALLETS.W2.address);
  assert.equal(Object.hasOwn(cancelled.tx, "CancelAfter"), false);

  let scarText = "";
  const scarCode = await finish.run([
    "--xrpl-http",
    anchors.XRPL_HTTP,
    "--owner",
    policy.EPOCH_SCAR.owner,
    "--offer-sequence",
    String(policy.EPOCH_SCAR.offerSequence),
  ], {
    env: {},
    now: NOW,
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      scarText = text;
    },
  });
  assert.equal(scarCode, 2);
  const scar = JSON.parse(scarText);
  assert.equal(scar.code, "EPOCH_SCAR");
  assert.equal(scar.tx, null);
  assert.equal(scarText.includes("EscrowFinish"), false);

  let missing = "";
  const missingCode = await cancel.run(["--xrpl-http", anchors.XRPL_HTTP], {
    env: {},
    now: NOW,
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      missing = text;
    },
  });
  assert.equal(missingCode, 2);
  assert.equal(JSON.parse(missing).code, "MISSING_SEQUENCE");
  assert.equal(JSON.parse(missing).tx, null);
});

test("finish refuses when TokenEscrow is disabled", async () => {
  const mock = mockLedger({ disable: "TokenEscrow" });
  let captured = "";
  const code = await finish.run(["--xrpl-http", anchors.XRPL_HTTP, "--offer-sequence", String(OFFER)], {
    env: {},
    now: NOW,
    fetchImpl: mock.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 2);
  const body = JSON.parse(captured);
  assert.equal(body.tx, null);
  assert.equal(body.rebate, null);
  assert.equal(body.code, "AMENDMENT");
  assert.equal(captured.includes('"TransactionType"'), false);
  assert.equal(captured.includes("CheckCreate"), false);
  assert.equal(captured.includes("Payment"), false);
});

test("a flat quote produces no check", async () => {
  const mock = mockLedger({ oracle: "0.01022008" });
  let captured = "";
  const code = await finish.run([
    "--xrpl-http",
    anchors.XRPL_HTTP,
    "--offer-sequence",
    String(OFFER),
    "--quoted",
    "0.01022008",
  ], {
    env: {},
    now: NOW,
    fetchImpl: mock.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  const body = JSON.parse(captured);
  assert.equal(body.tx.TransactionType, "EscrowFinish");
  assert.equal(body.rebate.tx, null);
  assert.equal(body.rebate.code, "NO_DRIFT");
});

test("live create refuses CI and archives only a submitted hash", async () => {
  let reads = 0;
  await assert.rejects(
    () => create.run(["--live"], {
      env: { CI: "true", FOUNDRY_DAEMON_LIVE: "yes", W2_REGULAR_SEED: "present-not-used" },
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
  const archived = [];
  let captured = "";
  const code = await create.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now: NOW,
    state: freshState(NOW),
    root,
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    archive(row) {
      archived.push(row);
    },
    submit(tx) {
      assert.equal(tx.TransactionType, "EscrowCreate");
      assert.equal(tx.Amount.mpt_issuance_id, F2_ISSUANCE);
      assert.equal(tx.Amount.value, "1");
      assert.ok(tx.FinishAfter < escrow.UNIX_LINE);
      return {
        hash: TX_HASH,
        result: "tesSUCCESS",
        ledger_index: 21130020,
        sequence: OFFER,
        meta: {
          AffectedNodes: [
            { CreatedNode: { LedgerEntryType: "Escrow", LedgerIndex: "EF".repeat(32) } },
          ],
        },
      };
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 1);
  const body = JSON.parse(captured);
  assert.equal(body.signed, true);
  assert.equal(body.hash, TX_HASH);
  assert.equal(body.offer_sequence, OFFER);
  assert.equal(body.escrow_index, "EF".repeat(32));
  assert.equal(body.deliverable.submitted, false);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].hash, TX_HASH);
  assert.equal(archived[0].mpt_issuance_id, F2_ISSUANCE);
  assert.equal(archived[0].asset, "mpt");
  assert.equal(body.mpt_issuance_id, F2_ISSUANCE);
  assert.equal(captured.includes("present-not-used"), false);
  const filed = JSON.parse(fs.readFileSync(path.join(root, "lab", "metrics.json"), "utf8"));
  assert.equal(filed.mpt_issuance_id, F2_ISSUANCE);
});

test("a 64-hex id and a metrics mismatch are refused", async () => {
  const mock = mockLedger();
  let captured = "";
  const bad = await create.run(["--xrpl-http", anchors.XRPL_HTTP, "--issuance-id", "AB".repeat(32)], {
    env: {},
    now: NOW,
    fetchImpl: mock.fetchImpl,
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(bad, 2);
  assert.equal(JSON.parse(captured).code, "ISSUANCE");
  assert.equal(JSON.parse(captured).tx, null);
  const root = tempRoot();
  const doc = JSON.parse(fs.readFileSync(path.join(root, "lab", "metrics.json"), "utf8"));
  doc.mpt_issuance_id = ISSUANCE;
  fs.writeFileSync(path.join(root, "lab", "metrics.json"), `${JSON.stringify(doc, null, 2)}\n`);
  const other = labor.issuanceId(9, anchors.WALLETS.W5.address);
  let mismatch = "";
  const code = await create.run(["--xrpl-http", anchors.XRPL_HTTP, "--issuance-id", other], {
    env: {},
    now: NOW,
    root,
    fetchImpl: mockLedger().fetchImpl,
    stdout(text) {
      mismatch = text;
    },
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(mismatch).code, "MISMATCH");
  assert.equal(JSON.parse(mismatch).tx, null);
});
