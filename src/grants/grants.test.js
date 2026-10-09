"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const guard = require("../x402-outbound-guard");
const policy = require("./policy");
const discover = require("./discover");
const record = require("./record");
const engine = require("./engine");

const ROOT = path.resolve(__dirname, "..", "..");
const DAY30 = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const STRANGER = "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss";
const LP = "rLDbAi71mciJwCDKyTn6dohD3ypDsMLRwm";
const HASH = "C8044902172E6803154E144815A6B8D19FBD1067B71BF511DF35346DF8BC43C1";

function labeled() {
  return guard.foundryIndex();
}

function walkInLine(buyer) {
  return JSON.stringify({
    action: "walk_in_buy",
    buyer,
    hash: HASH,
    tx_type: "NFTokenAcceptOffer",
  });
}

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grants-"));
  const files = {
    root: dir,
    ledgerPath: path.join(dir, "ledger-log.jsonl"),
    grantsPath: path.join(dir, "grants", "ledger.jsonl"),
    pnlPath: path.join(dir, "pnl.md"),
    resultsPath: path.join(dir, "RESULTS.md"),
    motionsDir: path.join(dir, "motions"),
    activated: path.join(ROOT, "machines", "governance-board", "activated.json"),
  };
  fs.mkdirSync(files.motionsDir, { recursive: true });
  fs.writeFileSync(files.pnlPath, "| grants_paid | 0 | |\n");
  fs.writeFileSync(files.resultsPath, "# RESULTS\n\nNo grant hash yet.\n");
  return files;
}

describe("grant eligibility", () => {
  it("excludes every WALLETS address and keeps the Day-30 buyer", () => {
    const index = labeled();
    assert.equal(index.get(STRANGER), "STRANGER");
    assert.equal(index.get(policy.W6), "W6");
    assert.equal(index.has(DAY30), false);
    const text = fs.readFileSync(path.join(ROOT, "lab", "ledger-log.jsonl"), "utf8");
    const report = discover.combine([discover.fromLedger(text, index)], [], Date.parse("2026-09-27T23:00:00Z"));
    const day = report.selectable.find((row) => row.address === DAY30);
    assert.ok(day);
    assert.equal(day.reason, "walk_in_acceptor");
    assert.equal(report.selectable.some((row) => row.address === STRANGER), false);
    assert.equal(report.selectable.some((row) => index.has(row.address)), false);
    assert.ok(report.excluded.some((row) => row.address === STRANGER && row.why === "labeled" && row.label === "STRANGER"));
    assert.ok(report.selectable.some((row) => row.address === LP && row.reason === "aeth_counterparty"));
  });

  it("drops a labeled walk-in acceptor and a second reason for the same buy", () => {
    const index = labeled();
    const text = [
      walkInLine(STRANGER),
      walkInLine(DAY30),
      JSON.stringify({ action: "NFTokenAcceptOffer_WalkIn", tx_type: "NFTokenAcceptOffer", account: DAY30, hash: HASH }),
    ].join("\n");
    const report = discover.combine([discover.fromLedger(text, index)], [], Date.now());
    assert.deepEqual(
      report.selectable.map((row) => row.address),
      [DAY30]
    );
    assert.equal(report.eligible.filter((row) => row.address === DAY30 && row.reason === "artifact_holder").length, 0);
  });

  it("does not treat an x402 outbound shop as a payer", () => {
    const index = labeled();
    const text = JSON.stringify({
      action: "x402_outbound",
      payer: policy.W3,
      pay_to: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ",
      hash: "D621848B4C66A940CA0DA51507D61A95D7546B4BB46E7925FC1D6FB414090C4C",
    });
    const report = discover.combine([discover.fromLedger(text, index)], [], Date.now());
    assert.equal(report.selectable.length, 0);
  });
});

describe("grant cooldown", () => {
  it("blocks the same destination and reason inside the window and allows it after", () => {
    const index = new Map();
    const text = walkInLine(DAY30);
    const paid = JSON.stringify({
      action: "grant_paid",
      destination: DAY30,
      reason: "walk_in_acceptor",
      result: "tesSUCCESS",
      ts: "2026-09-27T00:00:00.000Z",
      hash: "A".repeat(64),
    });
    const soon = Date.parse("2026-09-28T00:00:00.000Z");
    const later = Date.parse("2026-10-05T00:00:00.000Z");
    const blocked = discover.combine([discover.fromLedger(text, index)], discover.parsePaid(paid), soon);
    assert.equal(blocked.selectable.length, 0);
    assert.equal(blocked.excluded.some((row) => row.why === "cooldown" && row.address === DAY30), true);
    const open = discover.combine([discover.fromLedger(text, index)], discover.parsePaid(paid), later);
    assert.equal(open.selectable.length, 1);
    assert.equal(open.selectable[0].reason, "walk_in_acceptor");
  });

  it("keeps a different reason payable while the first reason is cooling down", () => {
    const index = new Map();
    const text = [
      walkInLine(DAY30),
      JSON.stringify({ action: "TrustSet_AETH", account: DAY30, hash: "B".repeat(64) }),
    ].join("\n");
    const paid = JSON.stringify({
      action: "grant_paid",
      destination: DAY30,
      reason: "walk_in_acceptor",
      result: "tesSUCCESS",
      ts: "2026-09-27T00:00:00.000Z",
      hash: "A".repeat(64),
    });
    const report = discover.combine(
      [discover.fromLedger(text, index)],
      discover.parsePaid(paid),
      Date.parse("2026-09-28T00:00:00.000Z")
    );
    assert.equal(report.selectable.length, 1);
    assert.equal(report.selectable[0].reason, "aeth_counterparty");
  });

  it("caps account_tx entries and ignores payments without an x402 source tag", () => {
    const index = labeled();
    const entries = [];
    for (let i = 0; i < policy.ACCOUNT_TX_LIMIT + 1; i += 1) {
      entries.push({
        hash: (i + 1).toString(16).padStart(64, "ab"),
        validated: true,
        meta: { TransactionResult: "tesSUCCESS" },
        tx_json: {
          TransactionType: "Payment",
          Account: `rDay30Buyer${i}`,
          Destination: policy.W3,
          Amount: "100000",
          SourceTag: 202609272,
        },
      });
    }
    entries[0].tx_json.Account = DAY30;
    entries[policy.ACCOUNT_TX_LIMIT].tx_json.Account = "rExtraShouldNotCount111111111111";
    const faucet = {
      hash: "C".repeat(64),
      validated: true,
      meta: { TransactionResult: "tesSUCCESS" },
      tx_json: {
        TransactionType: "Payment",
        Account: "rFaucetNotAnX402Payerxxxxxxx",
        Destination: policy.W3,
        Amount: "100000000",
      },
    };
    const parsed = discover.fromAccountTx(policy.W3, [faucet].concat(entries), index);
    assert.equal(parsed.bucket.eligible.some((row) => row.address === DAY30), true);
    assert.equal(parsed.bucket.eligible.some((row) => row.address === "rFaucetNotAnX402Payerxxxxxxx"), false);
    assert.equal(parsed.bucket.eligible.length <= policy.ACCOUNT_TX_LIMIT, true);
    assert.equal(
      parsed.bucket.eligible.some((row) => row.address === "rExtraShouldNotCount111111111111"),
      false
    );
  });
});

describe("grant payment policy", () => {
  it("refuses mainnet hosts and NetworkID 0", () => {
    assert.throws(() => policy.assertTestnetUrl("https://s1.ripple.com:51234"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("https://s2.ripple.com:51234"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("https://xrplcluster.com"), /mainnet|non-testnet/);
    assert.throws(() => policy.assertWsUrl("wss://xrpl.ws"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("https://backup.testnet.xrpl-labs.com"), /non-testnet/);
    assert.equal(policy.assertTestnetUrl("https://testnet.xrpl-labs.com"), "https://testnet.xrpl-labs.com");
    assert.equal(policy.assertWsUrl("wss://testnet.xrpl-labs.com"), "wss://testnet.xrpl-labs.com");
    assert.throws(() => policy.assertNetworkId(0), /NetworkID 0/);
    assert.throws(() => policy.assertNetworkId(21337), /NetworkID/);
    assert.equal(policy.assertTestnetUrl(policy.XRPL_HTTP), policy.XRPL_HTTP);
    assert.doesNotThrow(() => policy.assertNetworkId(1));
    assert.doesNotThrow(() => policy.assertNetworkId(null));
  });

  it("refuses a grant at or above 50 XRP without a matching motion", () => {
    assert.throws(() => policy.assertGrantDrops("50000000", DAY30, []), /motion/);
    assert.throws(
      () =>
        policy.assertGrantDrops("50000000", DAY30, [
          { text: `destination: ${policy.W6}\namount_xrp: 50\n` },
        ]),
      /motion/
    );
    assert.equal(
      policy.assertGrantDrops("50000000", DAY30, [
        { text: `destination: ${DAY30}\namount_drops: 50000000\n` },
      ]),
      "50000000"
    );
    assert.equal(policy.assertGrantDrops("49999999", DAY30, []), "49999999");
    assert.equal(policy.assertGrantDrops(policy.DEFAULT_DROPS, DAY30, []), policy.DEFAULT_DROPS);
    assert.throws(() => policy.assertGrantDrops("0", DAY30, []), /positive/);
  });

  it("builds a W6 payment whose memo names the purpose, experiment, and reason", () => {
    const tx = policy.buildGrantPayment({
      destination: DAY30,
      drops: policy.DEFAULT_DROPS,
      reason: "walk_in_acceptor",
    });
    assert.equal(tx.Account, policy.W6);
    assert.equal(tx.Destination, DAY30);
    assert.equal(tx.Amount, "1000000");
    assert.equal(tx.NetworkID, undefined);
    const memos = policy.decodeMemos(tx);
    assert.equal(memos.purpose, "aether-grant");
    assert.equal(memos.experiment, "grants-flywheel");
    assert.equal(memos.reason, "walk_in_acceptor");
    assert.equal(policy.reasonFromMemos(tx), "walk_in_acceptor");
    assert.throws(() => policy.buildAethGrantPayment({ destination: DAY30, value: "11" }), /AETH/);
    assert.equal(policy.buildAethGrantPayment({ destination: DAY30 }).Amount.value, "1");
    assert.equal(policy.buildAethGrantPayment({ destination: DAY30 }).SendMax, "2000000");
    const path = policy.chooseAethPath(
      [
        { source_amount: "2000001", paths_computed: [[{ currency: "XRP" }]] },
        { source_amount: "50000", paths_computed: [[{ currency: "XRP" }]] },
      ],
      "2000000"
    );
    assert.equal(path.sendMax, "50000");
    assert.equal(policy.chooseAethPath([{ source_amount: "9000000", paths_computed: [[{}]] }]), null);
  });

  it("keeps a 10 XRP float on W6", () => {
    assert.equal(policy.assertFloat("30000000", 0, "1000000", "200000", "1000000").left, "28000000");
    assert.throws(() => policy.assertFloat("11999999", 0, "1000000", "200000", "1000000"), /float/);
  });

  it("prefers the regular key when both seeds are present", () => {
    assert.equal(policy.signerMode({ W6_REGULAR_SEED: "a", W6_SEED: "b" }), "regular");
    assert.equal(policy.signerMode({ W6_SEED: "b" }), "master");
    assert.equal(policy.signerMode({ GRANTS_SEED: "c" }), "master");
    assert.equal(policy.signerMode({}), "");
  });
});

describe("grant dry-run", () => {
  it("plans a payment without loading a seed, including under CI", async () => {
    const files = tmpPaths();
    fs.writeFileSync(files.ledgerPath, `${walkInLine(DAY30)}\n`);
    let loaded = false;
    const result = await engine.execute(["--dry-run", "--no-rpc"], {
      env: { CI: "true", GITHUB_ACTIONS: "true", W6_SEED: "present", XRPL_HTTP: policy.XRPL_HTTP },
      paths: files,
      labeled: labeled(),
      loadSeed() {
        loaded = true;
        throw new Error("seed loaded");
      },
    });
    assert.equal(loaded, false);
    assert.equal(result.seedLoaded, false);
    assert.equal(result.tx.Account, policy.W6);
    assert.equal(result.tx.Destination, DAY30);
    assert.match(result.text, /seed not loaded/);
    assert.match(result.text, /no tx hash \(not submitted\)/);
    assert.match(result.text, /aether-grant/);
    assert.doesNotMatch(result.text, /present/);
  });

  it("refuses a 50 XRP dry-run without a motion and still does not load a seed", async () => {
    const files = tmpPaths();
    fs.writeFileSync(files.ledgerPath, `${walkInLine(DAY30)}\n`);
    let loaded = false;
    await assert.rejects(
      () =>
        engine.execute(["--dry-run", "--no-rpc", "--drops", "50000000"], {
          env: { XRPL_HTTP: policy.XRPL_HTTP },
          paths: files,
          labeled: labeled(),
          loadSeed() {
            loaded = true;
            return { mode: "master", name: "W6_SEED", seed: "present" };
          },
        }),
      /motion/
    );
    assert.equal(loaded, false);
  });

  it("refuses mainnet, CI signing, labeled destinations, and NetworkID 0", async () => {
    await assert.rejects(
      () => engine.execute(["--dry-run", "--no-rpc"], { env: { XRPL_HTTP: "https://s1.ripple.com:51234" } }),
      /mainnet/
    );
    let loaded = false;
    await assert.rejects(
      () =>
        engine.execute(["--record"], {
          env: { CI: "true" },
          loadSeed() {
            loaded = true;
            return null;
          },
        }),
      /CI/
    );
    assert.equal(loaded, false);
    await assert.rejects(
      () =>
        engine.execute(["--dry-run", "--no-rpc", "--destination", STRANGER], {
          env: { XRPL_HTTP: policy.XRPL_HTTP },
          paths: tmpPaths(),
          labeled: labeled(),
        }),
      /Foundry wallet STRANGER/
    );

    const files = tmpPaths();
    fs.writeFileSync(files.ledgerPath, `${walkInLine(DAY30)}\n`);
    let submitted = false;
    await assert.rejects(
      () =>
        engine.execute(["--no-rpc"], {
          env: { XRPL_HTTP: policy.XRPL_HTTP, XRPL_WS_URL: policy.XRPL_WS },
          paths: files,
          labeled: labeled(),
          loadSeed() {
            return { mode: "master", name: "W6_SEED", seed: "present" };
          },
          walletFromSeed() {
            return { classicAddress: policy.W6 };
          },
          async connect() {
            return { networkID: 0 };
          },
          async submit() {
            submitted = true;
          },
        }),
      /NetworkID 0/
    );
    assert.equal(submitted, false);
  });

  it("stops a mainnet network id before walking account_tx", async () => {
    const calls = [];
    await assert.rejects(
      () =>
        discover.fetchSources({
          http: policy.XRPL_HTTP,
          fetchImpl: async (_url, opts) => {
            calls.push(JSON.parse(opts.body));
            return { json: async () => ({ result: { info: { network_id: 0 } } }) };
          },
        }),
      /NetworkID 0/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "server_info");
  });

  it("asks account_tx for a capped page and does not send a marker", async () => {
    const calls = [];
    await discover.fetchSources({
      http: policy.XRPL_HTTP,
      fetchImpl: async (_url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push(body);
        if (body.method === "server_info") {
          return { json: async () => ({ result: { info: { network_id: 1 } } }) };
        }
        if (body.method === "nfts_by_issuer") {
          return { json: async () => ({ result: { error: "unknownCmd", error_message: "unknown" } }) };
        }
        if (body.method === "account_info") {
          return {
            json: async () => ({
              result: { account_data: { Balance: "100000000", OwnerCount: 0 } },
            }),
          };
        }
        if (body.method === "server_state") {
          return {
            json: async () => ({
              result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } },
            }),
          };
        }
        return { json: async () => ({ result: { transactions: [] } }) };
      },
    });
    const txCalls = calls.filter((row) => row.method === "account_tx");
    assert.equal(txCalls.length, 3);
    for (const call of txCalls) {
      assert.equal(call.params[0].limit, policy.ACCOUNT_TX_LIMIT);
      assert.equal(Object.prototype.hasOwnProperty.call(call.params[0], "marker"), false);
    }
  });
});

describe("grant live shape", () => {
  it("submits the XRP grant from W6 and an optional cheap AETH path", async () => {
    const files = tmpPaths();
    fs.writeFileSync(
      files.ledgerPath,
      `${JSON.stringify({ action: "TrustSet_AETH", account: DAY30, hash: "B".repeat(64) })}\n`
    );
    const regular = JSON.parse(fs.readFileSync(files.activated, "utf8")).regular_keys.find((row) => row.id === "W6")
      .regular_key;
    const calls = [];
    const result = await engine.execute(["--no-rpc", "--aeth"], {
      env: { XRPL_HTTP: policy.XRPL_HTTP, XRPL_WS_URL: policy.XRPL_WS },
      paths: files,
      labeled: labeled(),
      regularKey: regular,
      loadSeed() {
        return { mode: "regular", name: "W6_REGULAR_SEED", seed: "present" };
      },
      walletFromSeed() {
        return { classicAddress: regular };
      },
      async connect() {
        return { networkID: 1 };
      },
      async accountInfo() {
        return {
          result: { account_data: { Balance: "100000000", OwnerCount: 0, RegularKey: regular } },
        };
      },
      async serverState() {
        return { result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } } };
      },
      async pathFind() {
        return [{ source_amount: "50000", paths_computed: [[{ currency: "XRP" }]] }];
      },
      async submit(_client, _wallet, tx) {
        calls.push(tx);
        const hash = calls.length === 1 ? "D".repeat(64) : "E".repeat(64);
        return { result: { hash, ledger_index: 21103000, meta: { TransactionResult: "tesSUCCESS" } } };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].Account, policy.W6);
    assert.equal(calls[0].Amount, "1000000");
    assert.equal(calls[1].Account, policy.W6);
    assert.equal(calls[1].Amount.issuer, policy.W0);
    assert.equal(calls[1].SendMax, "50000");
    assert.equal(result.hash, "D".repeat(64));
    assert.equal(result.aethHash, "E".repeat(64));
    assert.equal(result.seedLoaded, true);
    const logged = fs.readFileSync(files.grantsPath, "utf8");
    assert.match(logged, /"hash":"D{64}"/);
    assert.doesNotMatch(logged, /present/);
  });
});

describe("grant record", () => {
  it("writes the cooldown ledger only after tesSUCCESS and the public files only with --record", () => {
    const files = tmpPaths();
    assert.throws(
      () =>
        record.recordGrant(
          { result: "tecNO_DST_INSUF_XRP", hash: "D".repeat(64), destination: DAY30, reason: "walk_in_acceptor" },
          { grantsPath: files.grantsPath, public: true, io: fs }
        ),
      /did not succeed/
    );
    assert.equal(fs.existsSync(files.grantsPath), false);
    const row = {
      ts: "2026-09-27T23:00:00.000Z",
      result: "tesSUCCESS",
      hash: "D".repeat(64),
      destination: DAY30,
      reason: "walk_in_acceptor",
      amount_drops: "1000000",
      signer: "regular",
      experiment: "grants-flywheel",
      network: "XRPL Testnet",
    };
    const quiet = record.recordGrant(row, {
      io: fs,
      grantsPath: files.grantsPath,
      ledgerPath: files.ledgerPath,
      pnlPath: files.pnlPath,
      resultsPath: files.resultsPath,
      public: false,
    });
    assert.equal(quiet.public, false);
    assert.match(fs.readFileSync(files.grantsPath, "utf8"), /grant_paid/);
    assert.equal(fs.existsSync(files.ledgerPath), false);
    assert.match(fs.readFileSync(files.pnlPath, "utf8"), /\| grants_paid \| 0 \|/);
    const pub = record.recordGrant(row, {
      io: fs,
      grantsPath: files.grantsPath,
      ledgerPath: files.ledgerPath,
      pnlPath: files.pnlPath,
      resultsPath: files.resultsPath,
      public: true,
    });
    assert.equal(pub.count, 1);
    assert.match(fs.readFileSync(files.pnlPath, "utf8"), /\| grants_paid \| 1 \|/);
    assert.match(fs.readFileSync(files.resultsPath, "utf8"), new RegExp("D".repeat(64)));
    assert.doesNotMatch(fs.readFileSync(files.ledgerPath, "utf8"), /seed/i);
    const again = record.recordGrant(row, {
      io: fs,
      grantsPath: files.grantsPath,
      ledgerPath: files.ledgerPath,
      pnlPath: files.pnlPath,
      resultsPath: files.resultsPath,
      public: true,
    });
    assert.equal(again.count, 1);
    assert.equal(fs.readFileSync(files.ledgerPath, "utf8").trim().split("\n").length, 1);
  });
});
