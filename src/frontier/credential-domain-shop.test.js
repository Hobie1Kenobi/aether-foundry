"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const metrics = require("../runtime/metrics");
const probe = require("./probe-amendments");
const shop = require("./credential-domain");
const run = require("./credential-domain-shop");

const NOW = new Date("2026-09-29T05:40:00.000Z");
const SEQUENCE = 2113;
const TX_HASH = "CD".repeat(32);
const FAIL_HASH = "AB".repeat(32);
const ROOT = anchors.repoRoot();

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
  return JSON.parse(fs.readFileSync(path.join(ROOT, probe.OUT_REL), "utf8")).amendments;
}

function mockLedger(opts = {}) {
  const calls = [];
  const rows = (opts.rows || committedRows()).map((row) => {
    if (opts.disable === row.name) return Object.assign({}, row, { enabled: false });
    if (opts.rehash === row.name) return Object.assign({}, row, { hash: "EF".repeat(32) });
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
        account_data: { Account: anchors.WALLETS.W5.address, Sequence: SEQUENCE },
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
    },
    watched: { batch: { atomic_enabled: false } },
  };
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-domain-"));
  fs.mkdirSync(path.join(dir, "market"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
  fs.writeFileSync(path.join(dir, "market", "pnl.md"), fs.readFileSync(path.join(ROOT, "market", "pnl.md")));
  return dir;
}

function liveAccounts() {
  return {
    issuer: anchors.WALLETS.W5.address,
    agent: shop.SHAPE.agent,
    stranger: shop.SHAPE.stranger,
    mint: shop.SHAPE.mint,
  };
}

test("domain keylet is uint16 m, not the ledger entry type code", () => {
  const owner = anchors.WALLETS.W5.address;
  const ownerHex = Buffer.from(xrpl.decodeAccountID(owner)).toString("hex");
  const seqHex = SEQUENCE.toString(16).padStart(8, "0");
  const manual = crypto.createHash("sha512").update(Buffer.from(`006d${ownerHex}${seqHex}`, "hex")).digest("hex").slice(0, 64).toUpperCase();
  assert.equal(shop.domainIndex(owner, SEQUENCE), manual);
  const wrongSpace = crypto.createHash("sha512").update(Buffer.from(`0082${ownerHex}${seqHex}`, "hex")).digest("hex").slice(0, 64).toUpperCase();
  assert.notEqual(shop.domainIndex(owner, SEQUENCE), wrongSpace);
  assert.notEqual(shop.domainIndex(owner, SEQUENCE), shop.domainIndex(owner, SEQUENCE + 1));
  assert.equal(shop.DOMAIN_SPACE, "006d");
  assert.throws(() => shop.domainIndex(owner, 1.5), (error) => error.code === "SEQUENCE");
});

test("shop credential is aether-agent and the LP door type is not issued", () => {
  assert.equal(shop.typeHex(), "6165746865722D6167656E74");
  assert.notEqual(shop.typeHex(), "6165746865722D6C702D6F6B");
  const accounts = shop.shapeAccounts();
  const create = shop.buildCredentialCreate(accounts.issuer, accounts.agent);
  assert.equal(create.TransactionType, "CredentialCreate");
  assert.equal(create.Account, anchors.WALLETS.W5.address);
  assert.equal(create.Subject, accounts.agent);
  assert.equal(create.CredentialType, shop.typeHex());
  assert.notEqual(create.Account, anchors.WALLETS.W0.address);
  const accept = shop.buildCredentialAccept(accounts.agent, accounts.issuer);
  assert.equal(accept.TransactionType, "CredentialAccept");
  assert.equal(accept.Account, accounts.agent);
  assert.equal(accept.Issuer, anchors.WALLETS.W5.address);
  const domain = shop.buildPermissionedDomainSet(accounts.issuer, accounts.issuer);
  assert.equal(domain.TransactionType, "PermissionedDomainSet");
  assert.equal(domain.DomainID, undefined);
  assert.equal(domain.AcceptedCredentials.length, 1);
  assert.equal(domain.AcceptedCredentials[0].Credential.Issuer, anchors.WALLETS.W5.address);
  assert.equal(domain.AcceptedCredentials[0].Credential.CredentialType, shop.typeHex());
  assert.throws(() => shop.buildCredentialCreate(anchors.WALLETS.W0.address, accounts.agent), (error) => error.code === "W0");
});

test("domain offer is not hybrid and is not the Walk-In NFT", () => {
  const accounts = shop.shapeAccounts();
  const domainId = shop.domainIndex(accounts.issuer, SEQUENCE);
  const offer = shop.buildDomainOffer(accounts.issuer, accounts.mint, domainId);
  const take = shop.buildTakeOffer(accounts.agent, accounts.mint, domainId);
  assert.equal(offer.TransactionType, "OfferCreate");
  assert.equal(offer.DomainID, domainId);
  assert.equal(offer.Flags, undefined);
  assert.equal((0 & shop.TF_HYBRID), 0);
  assert.equal(offer.TakerPays, shop.OFFER_DROPS);
  assert.equal(offer.TakerGets.currency, "AGT");
  assert.equal(offer.TakerGets.issuer, accounts.mint);
  assert.equal(take.TakerGets, shop.OFFER_DROPS);
  assert.equal(take.TakerPays.value, "1");
  assert.equal(take.CredentialIDs, undefined);
  assert.notEqual(offer.Account, anchors.WALLETS.W2.address);
  assert.throws(() => shop.buildStep("Batch", accounts, domainId), (error) => error.code === "TX");
  const hybrid = Object.assign({}, offer, { Flags: shop.TF_HYBRID });
  assert.throws(() => shop.assertNotHybrid(hybrid), (error) => error.code === "HYBRID");
  assert.throws(
    () => shop.assertNotWalkIn({ TransactionType: "NFTokenCreateOffer", Account: anchors.WALLETS.W2.address }),
    (error) => error.code === "TX"
  );
});

test("adversary case documents the uncredentialed refusal; pack archives live hashes", () => {
  const accounts = shop.shapeAccounts();
  const domainId = shop.domainIndex(accounts.issuer, 9);
  const adversary = shop.adversaryCase(accounts, domainId);
  assert.equal(adversary.expected_engine, "tecNO_PERMISSION");
  assert.equal(adversary.live_verified, false);
  assert.equal(adversary.hash, null);
  assert.equal(adversary.tx.Account, accounts.stranger);
  assert.equal(adversary.tx.DomainID, domainId);
  assert.equal(adversary.tx.TransactionType, "OfferCreate");
  assert.equal(adversary.tx.Flags, undefined);
  assert.notEqual(adversary.tx.Account, accounts.issuer);
  const results = fs.readFileSync(path.join(ROOT, "machines", "credential-domain-shop", "RESULTS.md"), "utf8");
  assert.match(results, /tecNO_PERMISSION/);
  assert.match(results, /Live verified/);
  assert.match(results, /\*\*domain_id:\*\* `6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4`/);
  assert.match(results, /A1046BD20845D29E782FB9A83C82434CF87071707F9263DE06D908082E0B4A8E/);
  assert.match(results, /A3A60DF94E038617547764742E130A63347139CD1FBC23E03AD91A2C76054EEE/);
  assert.match(results, /tesSUCCESS/);
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "machines", "credential-domain-shop", "artifact.json"), "utf8"));
  assert.equal(artifact.domain_id, "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4");
  assert.equal(artifact.uncredentialed_hash, "A1046BD20845D29E782FB9A83C82434CF87071707F9263DE06D908082E0B4A8E");
  assert.equal(artifact.credentialed_take_hash, "A3A60DF94E038617547764742E130A63347139CD1FBC23E03AD91A2C76054EEE");
  assert.equal(artifact.live, true);
  assert.equal(artifact.walk_in, "public");
});

test("refuses the shop when any required amendment is disabled, omitted, or rehashed", async () => {
  for (const tweak of [
    { disable: "Credentials" },
    { disable: "PermissionedDomains" },
    { disable: "PermissionedDEX" },
    { omit: "Credentials" },
    { rehash: "PermissionedDEX" },
  ]) {
    const mock = mockLedger(tweak);
    let reads = 0;
    let captured = "";
    const code = await run.run(["--xrpl-http", anchors.XRPL_HTTP], {
      env: { W5_REGULAR_SEED: "present-not-used", W0_SEED: "present-not-used" },
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
    assert.equal(body.steps, null);
    assert.equal(body.domain_id, null);
    assert.equal(body.predicted_domain_id, null);
    assert.equal(body.adversary.tx, null);
    assert.equal(body.adversary.hash, null);
    assert.equal(body.adversary.live_verified, false);
    assert.match(body.message, /Credentials|PermissionedDomains|PermissionedDEX/);
    assert.equal(captured.includes('"TransactionType"'), false);
    assert.equal(mock.calls.some((call) => call.method === "account_info"), false);
    assert.equal(captured.includes("present-not-used"), false);
  }
});

test("refuses a network id other than 1 before building a domain transaction", async () => {
  for (const networkId of [0, 21337, 21338, 2]) {
    const mock = mockLedger({ network_id: networkId });
    let reads = 0;
    await assert.rejects(
      () => run.run(["--dry-run", "--xrpl-http", anchors.XRPL_HTTP], {
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
    () => run.run(["--dry-run", "--xrpl-http", "https://s1.ripple.com:51234"], {
      env: {},
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
  await assert.rejects(
    () => run.run(["--dry-run", "--xrpl-http", "https://xahau.network"], {
      env: {},
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
      stdout() {},
    }),
    (error) => error.code === "MAINNET"
  );
});

test("dry-run prints the composition and leaves domain_id null", async () => {
  const mock = mockLedger();
  let reads = 0;
  let captured = "";
  const code = await run.run(["--xrpl-http", anchors.XRPL_HTTP], {
    env: { CI: "true", W5_REGULAR_SEED: "present-not-used", W0_SEED: "present-not-used" },
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
  assert.equal(body.domain_id, null);
  assert.equal(body.walk_in, "public");
  assert.equal(body.credential_type, "aether-agent");
  assert.equal(body.issuer, anchors.WALLETS.W5.address);
  assert.equal(body.predicted_domain_id, shop.domainIndex(anchors.WALLETS.W5.address, SEQUENCE));
  assert.equal(body.amendments.Credentials.enabled, true);
  assert.equal(body.amendments.PermissionedDomains.enabled, true);
  assert.equal(body.amendments.PermissionedDEX.enabled, true);
  const byId = Object.fromEntries(body.steps.map((step) => [step.id, step]));
  assert.equal(byId.credential_create.tx.TransactionType, "CredentialCreate");
  assert.equal(byId.credential_accept.tx.TransactionType, "CredentialAccept");
  assert.equal(byId.permissioned_domain_set.tx.TransactionType, "PermissionedDomainSet");
  assert.equal(byId.domain_offer.tx.TransactionType, "OfferCreate");
  assert.equal(byId.domain_offer.tx.DomainID, body.predicted_domain_id);
  assert.equal(byId.uncredentialed_offer.expect, "tecNO_PERMISSION");
  assert.equal(byId.uncredentialed_offer.tx.Account, shop.SHAPE.stranger);
  assert.equal(byId.credentialed_take.tx.Account, shop.SHAPE.agent);
  assert.equal(body.adversary.live_verified, false);
  assert.equal(body.adversary.hash, null);
  assert.equal(body.adversary.expected_engine, "tecNO_PERMISSION");
  assert.equal(captured.includes("present-not-used"), false);
  assert.equal(captured.includes("NFTokenCreateOffer"), false);
  assert.equal(captured.includes("W0_SEED"), false);
  const filed = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"));
  // Dry-run must not paste predicted_domain_id into lab metrics; archived live id may already be present.
  assert.equal(body.domain_id, null);
  assert.notEqual(filed.domain_id, body.predicted_domain_id);
  assert.equal(filed.domain_id, "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4");
});

test("live archives the domain keylet and the uncredentialed refusal", async () => {
  let reads = 0;
  await assert.rejects(
    () => run.run(["--live"], {
      env: { CI: "true", FOUNDRY_DAEMON_LIVE: "yes", W0_SEED: "present-not-used" },
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
  const domainId = shop.domainIndex(anchors.WALLETS.W5.address, SEQUENCE);
  const calls = [];
  let captured = "";
  const code = await run.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
    env: { FOUNDRY_DAEMON_LIVE: "yes" },
    now: NOW,
    state: freshState(NOW),
    root,
    accounts: liveAccounts(),
    archive: false,
    fetchImpl: mock.fetchImpl,
    loadSeed() {
      reads += 1;
      return "present-not-used";
    },
    submit(step) {
      calls.push(step.id);
      if (step.key_env === "W0_SEED" || step.tx.Account === anchors.WALLETS.W0.address) {
        throw new Error("W0 signer");
      }
      if (step.id === "permissioned_domain_set") {
        return {
          hash: TX_HASH,
          result: "tesSUCCESS",
          ledger_index: 21130011,
          sequence: SEQUENCE,
          meta: {
            AffectedNodes: [
              { CreatedNode: { LedgerEntryType: "PermissionedDomain", LedgerIndex: domainId.toLowerCase() } },
            ],
          },
        };
      }
      if (step.id === "uncredentialed_offer") {
        assert.equal(step.tx.DomainID, domainId);
        assert.equal(step.tx.Account, shop.SHAPE.stranger);
        assert.equal(step.expect, "tecNO_PERMISSION");
        return { hash: FAIL_HASH, result: "tecNO_PERMISSION", ledger_index: 21130012, sequence: 4, meta: {} };
      }
      if (step.id === "credentialed_take") {
        assert.equal(step.tx.DomainID, domainId);
        assert.equal(step.tx.Account, shop.SHAPE.agent);
      }
      if (step.id === "domain_offer") assert.equal(step.tx.DomainID, domainId);
      return { hash: TX_HASH, result: "tesSUCCESS", ledger_index: 21130013, sequence: 8, meta: {} };
    },
    stdout(text) {
      captured = text;
    },
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.deepEqual(calls, shop.STEP_IDS);
  const body = JSON.parse(captured);
  assert.equal(body.mode, "live");
  assert.equal(body.domain_id, domainId);
  assert.equal(body.adversary.live_verified, true);
  assert.equal(body.adversary.hash, FAIL_HASH);
  assert.equal(body.adversary.result, "tecNO_PERMISSION");
  assert.equal(body.credentialed_take, TX_HASH);
  assert.equal(body.walk_in, "public");
  assert.equal(captured.includes("present-not-used"), false);
  const filed = metrics.readMetrics(root);
  assert.equal(filed.domain_id, domainId);
  const refreshed = metrics.refresh(root, { now: NOW });
  assert.equal(refreshed.domain_id, domainId);
  assert.throws(
    () => metrics.recordDomain(root, { hash: TX_HASH, domain_id: "abcd" }),
    (error) => error.code === "METRICS"
  );
});

test("a domain index that does not match the keylet is not archived", async () => {
  const mock = mockLedger();
  const root = tempRoot();
  await assert.rejects(
    () => run.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      state: freshState(NOW),
      root,
      accounts: liveAccounts(),
      archive: false,
      fetchImpl: mock.fetchImpl,
      submit(step) {
        if (step.id === "permissioned_domain_set") {
          return {
            hash: TX_HASH,
            result: "tesSUCCESS",
            ledger_index: 21130011,
            sequence: SEQUENCE,
            meta: {
              AffectedNodes: [
                { CreatedNode: { LedgerEntryType: "PermissionedDomain", LedgerIndex: "EF".repeat(32) } },
              ],
            },
          };
        }
        return { hash: TX_HASH, result: "tesSUCCESS", ledger_index: 1, sequence: 1, meta: {} };
      },
      stdout() {},
    }),
    (error) => error.code === "DOMAIN"
  );
  assert.equal(metrics.readMetrics(root), null);
});

test("an accepted uncredentialed offer fails the run and does not set domain_id", async () => {
  const mock = mockLedger();
  const root = tempRoot();
  const domainId = shop.domainIndex(anchors.WALLETS.W5.address, SEQUENCE);
  await assert.rejects(
    () => run.run(["--live", "--xrpl-http", anchors.XRPL_HTTP], {
      env: { FOUNDRY_DAEMON_LIVE: "yes" },
      now: NOW,
      state: freshState(NOW),
      root,
      accounts: liveAccounts(),
      archive: false,
      recordMetrics: false,
      fetchImpl: mock.fetchImpl,
      submit(step) {
        if (step.id === "permissioned_domain_set") {
          return {
            hash: TX_HASH,
            result: "tesSUCCESS",
            ledger_index: 21130011,
            sequence: SEQUENCE,
            meta: {
              AffectedNodes: [
                { CreatedNode: { LedgerEntryType: "PermissionedDomain", LedgerIndex: domainId } },
              ],
            },
          };
        }
        if (step.id === "uncredentialed_offer") {
          return { hash: FAIL_HASH, result: "tesSUCCESS", ledger_index: 21130012, sequence: 4, meta: {} };
        }
        return { hash: TX_HASH, result: "tesSUCCESS", ledger_index: 1, sequence: 1, meta: {} };
      },
      stdout() {},
    }),
    (error) => error.code === "ADVERSARY"
  );
  assert.equal(metrics.readMetrics(root), null);
});

test("signer source does not load W0 or retarget Walk-In", () => {
  const src = [
    fs.readFileSync(path.join(ROOT, "src", "frontier", "credential-domain.js"), "utf8"),
    fs.readFileSync(path.join(ROOT, "src", "frontier", "credential-domain-shop.js"), "utf8"),
  ].join("\n");
  assert.match(src, /refusing W0 master seed/);
  assert.match(src, /NFTokenCreateOffer/);
  assert.doesNotMatch(src, /readSeed\(\s*["']W0_SEED/);
  assert.doesNotMatch(src, /fromSeed\(\s*env\.W0_SEED/);
  assert.doesNotMatch(src, /TransactionType:\s*"NFTokenCreateOffer"|TransactionType:\s*"NFTokenMint"|TransactionType:\s*"NFTokenAcceptOffer"/);
  assert.doesNotMatch(src, /TransactionType:\s*"Batch"|TransactionType:\s*"Sponsor"|VaultCreate|SingleAssetVault/);
  assert.doesNotMatch(src, /xrpl-facilitator|t54\.ai/i);
  const desk = fs.readFileSync(path.join(ROOT, "web", "lib", "status-body.js"), "utf8");
  assert.match(desk, /domain_id/);
  assert.doesNotMatch(desk, /Wallet|fromSeed/);
});
