"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const anchors = require("../director/anchors");
const discover = require("../grants/discover");
const grantPolicy = require("../grants/policy");
const engine = require("../grants/engine");
const grantRecord = require("../grants/record");
const guard = require("../x402-outbound-guard");
const outboundRecord = require("../x402-outbound-record");
const payer = require("../x402-outbound");
const rules = require("../../web/lib/x402-rules");
const metrics = require("./metrics");
const runtimePolicy = require("./policy");

const ROOT = path.resolve(__dirname, "..", "..");
const DAY30 = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const STRANGER = "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss";
const FOREIGN = "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ";
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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function spawnNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function challenge(payTo, amount) {
  const required = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        amount,
        payTo,
        extra: { diyCostDrops: amount },
      },
    ],
  };
  const header = rules.encodeHeader(required);
  return http.createServer((req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": header, "content-type": "application/json" });
    res.end("{}");
  });
}

describe("unique inbound", () => {
  it("counts classic buyers and grant destinations outside WALLETS", () => {
    const text = [
      walkInLine(DAY30),
      walkInLine(STRANGER),
      JSON.stringify({
        action: "grant_paid",
        destination: DAY30,
        result: "tesSUCCESS",
        hash: "A".repeat(64),
      }),
      JSON.stringify({
        action: "x402_outbound",
        pay_to: FOREIGN,
        payer: grantPolicy.W3,
        hash: "B".repeat(64),
      }),
      JSON.stringify({
        action: "x402_hit",
        payer: "rHitPayer111111111111111111111",
        hash: "C".repeat(64),
        sku: "machine-spec",
      }),
    ].join("\n");
    const index = labeled();
    const inbound = metrics.uniqueInbound(text, index);
    assert.equal(inbound.includes(DAY30), true);
    assert.equal(inbound.includes(STRANGER), false);
    assert.equal(inbound.includes(FOREIGN), false);
    assert.equal(inbound.includes(grantPolicy.W3), false);
    assert.equal(inbound.includes(grantPolicy.W0), false);
    assert.ok(inbound.every((address) => anchors.ADDRESS_RE.test(address)));
    assert.ok(inbound.every((address) => !index.has(address)));
    const shaped = ["sEd", "V".repeat(24)].join("");
    assert.throws(
      () => metrics.uniqueInbound(JSON.stringify({ action: "walk_in_buy", buyer: shaped })),
      (error) => error.code === "SEED"
    );
  });

  it("reads the public ledger and the archived heartbeat hash", () => {
    const ledger = fs.readFileSync(path.join(ROOT, "lab", "ledger-log.jsonl"), "utf8");
    const extracted = metrics.extract(ledger);
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"));
    const pnl = metrics.parsePnlCounts(fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8"));
    assert.equal(extracted.inbound.includes(DAY30), true);
    assert.equal(extracted.inbound.includes(STRANGER), false);
    assert.equal(extracted.inbound.includes(FOREIGN), false);
    assert.equal(extracted.last_heartbeat_hash, "3BB793FC200C811F1F4E9F535EE4D470C3896852F6D4A35CD157C7E1E6BACE35");
    assert.ok(anchors.HASH_RE.test(extracted.last_grant_hash));
    assert.ok(anchors.HASH_RE.test(extracted.last_outbound_hash));
    assert.equal(committed.last_grant_hash, extracted.last_grant_hash);
    assert.equal(committed.last_outbound_hash, extracted.last_outbound_hash);
    assert.equal(committed.last_heartbeat_hash, extracted.last_heartbeat_hash);
    assert.equal(committed.last_heartbeat.hash, extracted.last_heartbeat_hash);
    assert.equal(committed.grants_paid, extracted.grants_paid);
    assert.equal(committed.x402_hits, extracted.x402_hits);
    assert.equal(committed.x402_outbound_hits, extracted.x402_outbound_hits);
    assert.equal(committed.inbound_counterparties, extracted.inbound.length);
    assert.equal(committed.inbound_counterparties, pnl.counts.inbound_counterparties);
    assert.equal(committed.grants_paid, pnl.counts.grants_paid);
    assert.doesNotMatch(JSON.stringify(committed), /sEd|"seed"|"secret"|"private_key"/);
    const flat = JSON.stringify(committed);
    const classic = flat.match(/r[1-9A-HJ-NP-Za-km-z]{24,34}/g) || [];
    for (const address of classic) assert.match(address, anchors.ADDRESS_RE);
  });
});

describe("grant scan and day cap", () => {
  it("keeps labeled wallets out and the Day-30 buyer behind the 7-day cooldown", async () => {
    const index = labeled();
    const soon = await engine.executeScan(["--no-rpc"], {
      env: {
        CI: "true",
        GITHUB_ACTIONS: "true",
        XRPL_HTTP: grantPolicy.XRPL_HTTP,
        W6_REGULAR_SEED: "present",
      },
      now: Date.parse("2026-09-28T23:00:00.000Z"),
    });
    assert.equal(soon.report.selectable.some((row) => index.has(row.address)), false);
    assert.equal(soon.report.selectable.some((row) => row.address === DAY30), false);
    assert.equal(
      soon.report.excluded.some((row) => row.address === DAY30 && row.why === "cooldown"),
      true
    );
    assert.doesNotMatch(soon.text, /present/);
    const later = await discover.collect({
      ledgerText: fs.readFileSync(path.join(ROOT, "lab", "ledger-log.jsonl"), "utf8"),
      grantsText: "",
      labeled: index,
      rpc: false,
      now: Date.parse("2026-10-05T12:00:00.000Z"),
    });
    const day = later.selectable.find((row) => row.address === DAY30);
    assert.ok(day);
    assert.equal(day.reason, "walk_in_acceptor");
    assert.equal(later.selectable.some((row) => index.has(row.address)), false);
  });

  it("refuses a second live grant on the same UTC day before loading a seed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-grant-"));
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
    fs.writeFileSync(files.pnlPath, "| grants_paid | 0 | |\n| inbound_counterparties | **0** | old |\n");
    fs.writeFileSync(files.resultsPath, "# RESULTS\n");
    const today = "2026-09-28T16:00:00.000Z";
    fs.writeFileSync(
      files.ledgerPath,
      `${walkInLine(DAY30)}\n${JSON.stringify({
        action: "grant_paid",
        destination: "rOtherGrantDestNotDay30xxxxx",
        reason: "x402_payer",
        result: "tesSUCCESS",
        ts: today,
        hash: "A".repeat(64),
      })}\n`
    );
    let loaded = false;
    await assert.rejects(
      () =>
        engine.execute(["--no-rpc"], {
          env: { XRPL_HTTP: grantPolicy.XRPL_HTTP },
          paths: files,
          labeled: labeled(),
          now: Date.parse(today),
          loadSeed() {
            loaded = true;
            return { mode: "regular", name: "W6_REGULAR_SEED", seed: "present" };
          },
        }),
      (error) => error.code === "DAY"
    );
    assert.equal(loaded, false);
    const dry = await engine.execute(["--dry-run", "--no-rpc"], {
      env: { CI: "true", XRPL_HTTP: grantPolicy.XRPL_HTTP },
      paths: files,
      labeled: labeled(),
      now: Date.parse(today),
      loadSeed() {
        throw new Error("seed loaded");
      },
    });
    assert.equal(dry.seedLoaded, false);
    assert.equal(dry.tx.Destination, DAY30);
  });

  it("refuses CI and mainnet on the signing path", async () => {
    let loaded = false;
    await assert.rejects(
      () =>
        engine.execute(["--record"], {
          env: { CI: "true", GITHUB_ACTIONS: "true" },
          loadSeed() {
            loaded = true;
            return null;
          },
        }),
      (error) => error.code === "CI"
    );
    assert.equal(loaded, false);
    await assert.rejects(
      () =>
        engine.execute(["--dry-run", "--no-rpc"], {
          env: { XRPL_HTTP: "https://s1.ripple.com:51234" },
        }),
      /mainnet/
    );
    assert.throws(() => runtimePolicy.assertNotCi({ GITHUB_ACTIONS: "true" }), (error) => error.code === "CI");
    assert.throws(() => runtimePolicy.assertAltnet({ networkId: 0 }), (error) => error.code === "MAINNET");
    assert.throws(() => grantPolicy.assertNetworkId(0), /NetworkID 0/);
  });
});

describe("record paths write metrics from the ledger hash", () => {
  it("copies a grant hash into metrics and the pnl count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-metrics-"));
    const ledgerPath = path.join(dir, "lab", "ledger-log.jsonl");
    const grantsPath = path.join(dir, "lab", "grants", "ledger.jsonl");
    const pnlPath = path.join(dir, "market", "pnl.md");
    const resultsPath = path.join(dir, "RESULTS.md");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.mkdirSync(path.dirname(pnlPath), { recursive: true });
    fs.writeFileSync(
      pnlPath,
      "| x402_hits | 0 | |\n| x402_outbound_hits | 0 | |\n| grants_paid | 0 | |\n| inbound_counterparties | **0** | old |\n"
    );
    fs.writeFileSync(resultsPath, "# RESULTS\n");
    const hash = "D".repeat(64);
    grantRecord.recordGrant(
      {
        ts: "2026-09-28T18:00:00.000Z",
        result: "tesSUCCESS",
        hash,
        destination: DAY30,
        reason: "walk_in_acceptor",
        amount_drops: "1000000",
        signer: "regular",
        experiment: "grants-flywheel",
        network: "XRPL Testnet",
      },
      {
        io: fs,
        root: dir,
        grantsPath,
        ledgerPath,
        pnlPath,
        resultsPath,
        public: true,
      }
    );
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "lab", "metrics.json"), "utf8"));
    assert.equal(doc.last_grant_hash, hash);
    assert.equal(doc.grants_paid, 1);
    assert.equal(doc.inbound_counterparties, 1);
    assert.equal(doc.last_outbound_hash, null);
    assert.equal(doc.last_heartbeat.hash, null);
    assert.match(fs.readFileSync(pnlPath, "utf8"), /\| grants_paid \| 1 \|/);
    assert.match(fs.readFileSync(resultsPath, "utf8"), new RegExp(hash));
    assert.doesNotMatch(JSON.stringify(doc), /sEd/);
  });

  it("copies an outbound hash and refuses a second same-day live pay in the helper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-out-"));
    const logPath = path.join(dir, "lab", "ledger-log.jsonl");
    const pnlPath = path.join(dir, "market", "pnl.md");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.mkdirSync(path.dirname(pnlPath), { recursive: true });
    fs.writeFileSync(
      pnlPath,
      "| x402_hits | 0 | |\n| x402_outbound_hits | 0 | |\n| grants_paid | 0 | |\n| inbound_counterparties | **0** | old |\n"
    );
    const hash = "E".repeat(64);
    const ts = "2026-09-28T18:00:00.000Z";
    outboundRecord.recordOutbound(
      {
        hash,
        pay_to: FOREIGN,
        payer: grantPolicy.W3,
        amount_drops: "5000",
        network: "xrpl:1",
        ts,
      },
      { root: dir, logPath, pnlPath }
    );
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "lab", "metrics.json"), "utf8"));
    assert.equal(doc.last_outbound_hash, hash);
    assert.equal(doc.x402_outbound_hits, 1);
    assert.equal(doc.inbound_counterparties, 0);
    assert.equal(payer.outboundPaidToday(fs.readFileSync(logPath, "utf8"), new Date(ts)), true);
    assert.equal(payer.outboundPaidToday(fs.readFileSync(logPath, "utf8"), new Date("2026-09-29T00:00:00.000Z")), false);
    assert.throws(() => payer.assertOutboundDrops("500001"), (error) => error.code === "CAP");
    assert.equal(payer.assertOutboundDrops("500000"), "500000");
    assert.throws(() => guard.assertForeignPayTo(grantPolicy.W3, labeled()), /W3/);
    assert.throws(() => runtimePolicy.assertOutbound({ payTo: grantPolicy.W3, drops: "5000", has402: true }), (error) => error.code === "CIRCULAR");
  });
});

describe("outbound dry-run and workflow clock", () => {
  it("dry-run without a URL exits 0 and does not read a seed", async () => {
    const result = await spawnNode(path.join(ROOT, "src", "x402-outbound.js"), ["--dry-run"], {
      PATH: process.env.PATH,
      CI: "true",
      GITHUB_ACTIONS: "true",
      W3_SEED: "not-a-real-seed",
      AETHER_SECRETS: path.join(os.tmpdir(), "missing-flywheel.env"),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run/);
    assert.match(result.stdout, /seed not loaded/);
    assert.match(result.stdout, /cap_drops 500000/);
    assert.match(result.stdout, /no tx hash \(not submitted\)/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not-a-real-seed/);
  });

  it("refuses CI, mainnet, W3, and an amount above 0.5 XRP", async () => {
    const ci = await spawnNode(
      path.join(ROOT, "src", "x402-outbound.js"),
      ["--url", "http://127.0.0.1/unused"],
      { PATH: process.env.PATH, CI: "true", GITHUB_ACTIONS: "true" }
    );
    assert.equal(ci.status, 1);
    assert.match(ci.stderr, /refusing to sign under CI/);
    assert.throws(() => guard.assertTestnetUrl("https://s1.ripple.com:51234"), (error) => error.code === "MAINNET");
    assert.throws(() => guard.selectAccept({ x402Version: 2, accepts: [{ network: "xrpl:0", amount: "1", payTo: FOREIGN, scheme: "exact" }] }), (error) => error.code === "MAINNET");
    const server = challenge(FOREIGN, "600000");
    const port = await listen(server);
    try {
      const over = await spawnNode(
        path.join(ROOT, "src", "x402-outbound.js"),
        ["--url", `http://127.0.0.1:${port}/sku`, "--max-drops", "600000", "--dry-run"],
        { PATH: process.env.PATH, CI: "", GITHUB_ACTIONS: "", AETHER_SECRETS: path.join(os.tmpdir(), "missing-flywheel.env") }
      );
      assert.equal(over.status, 2);
      assert.match(over.stderr, /500000/);
      assert.doesNotMatch(over.stdout, /paid /);
    } finally {
      await close(server);
    }
  });

  it("keeps signing commands out of GitHub Actions workflows", () => {
    const dir = path.join(ROOT, ".github", "workflows");
    const names = fs.readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    assert.ok(names.length > 0);
    for (const name of names) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      assert.doesNotMatch(text, /runtime:live/);
      assert.doesNotMatch(text, /runtime:watch/);
      assert.doesNotMatch(text, /FOUNDRY_DAEMON_LIVE/);
      assert.doesNotMatch(text, /grants:pay/);
      assert.doesNotMatch(text, /x402:outbound/);
      assert.doesNotMatch(text, /_SEED/);
    }
  });
});
