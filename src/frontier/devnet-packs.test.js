"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const guard = require("./devnet-guard");
const sponsor = require("./devnet-sponsor");
const vault = require("./devnet-vault");
const confidential = require("./devnet-confidential");

const DEVNET_MAP = path.join(anchors.repoRoot(), "lab", "frontier", "amendments-devnet.json");
const NOW = new Date("2026-09-29T06:11:00.000Z");
const ENGINE_HASH = "AB".repeat(32);
const SEED_SHAPED = "sEdVVVVVVVVVVVVVVVVVVVVV";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devnet-pack-"));
}

function rows(mutate) {
  const doc = JSON.parse(fs.readFileSync(DEVNET_MAP, "utf8"));
  const copy = doc.amendments.map((row) => Object.assign({}, row));
  if (mutate) mutate(copy);
  return copy;
}

function featureMap(list) {
  const features = {};
  for (const row of list) {
    features[row.hash] = { name: row.name, enabled: row.enabled, supported: row.supported !== false };
  }
  return { features };
}

function mockFetch(opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const method = calls[calls.length - 1].body.method;
    if (method === "server_info") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            result: {
              info: {
                build_version: "3.4.1",
                network_id: opts.network_id == null ? 2 : opts.network_id,
              },
            },
          };
        },
      };
    }
    if (method === "feature") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: featureMap(opts.rows || rows()) };
        },
      };
    }
    if (method === "ledger_entry") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { node: { PeriodicPayment: opts.periodic || "1000000.1" } } };
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, calls };
}

function addresses() {
  return {
    d0: xrpl.Wallet.generate().classicAddress,
    d1: xrpl.Wallet.generate().classicAddress,
    d2: xrpl.Wallet.generate().classicAddress,
    d3: xrpl.Wallet.generate().classicAddress,
    sender: xrpl.Wallet.generate().classicAddress,
  };
}

function liveEnv(extra) {
  return Object.assign({ FOUNDRY_DAEMON_LIVE: "yes" }, extra || {});
}

describe("devnet network guards", () => {
  it("accepts network id 2 and refuses mainnet, Testnet, and Xahau", () => {
    assert.equal(guard.assertDevnetId(2), 2);
    assert.equal(guard.assertDevnetId("2"), 2);
    assert.throws(() => guard.assertDevnetId(0), /mainnet network id 0/);
    assert.throws(() => guard.assertDevnetId(1), /Testnet network id 1/);
    assert.throws(() => guard.assertDevnetId(21337), /mainnet network id 21337/);
    assert.throws(() => guard.assertDevnetId(21338), /network id 21338/);
    assert.throws(() => guard.assertDevnetId(null), /missing network id/);
  });

  it("resolves the Devnet HTTP host and refuses mainnet hosts", () => {
    assert.equal(guard.resolveHttp({}, null), guard.XRPL_DEVNET_HTTP);
    assert.equal(
      guard.resolveHttp({ FOUNDRY_XRPL_HTTP: "https://s1.ripple.com:51234", XRPL_HTTP: "https://xrplcluster.com" }, null),
      guard.XRPL_DEVNET_HTTP
    );
    assert.throws(() => guard.resolveHttp({}, "https://s1.ripple.com:51234"), /mainnet/);
    assert.throws(() => guard.resolveHttp({}, "https://xrplcluster.com/"), /mainnet/);
    assert.throws(() => guard.resolveWs({ XRPL_DEVNET_WS: "wss://s1.ripple.com" }, guard.XRPL_DEVNET_HTTP), /mainnet/);
    assert.throws(
      () => guard.resolveWs({}, "https://s.altnet.rippletest.net:51234"),
      /does not match/
    );
  });

  it("refuses Testnet labeled wallets and the AETH-LABOR issuance", () => {
    assert.throws(() => guard.assertNotLabeled(anchors.WALLETS.W2.address, "D2"), /W2/);
    assert.throws(() => guard.assertNotLabeled(guard.LABELED_ROLES.BUYER, "D2"), /BUYER/);
    assert.throws(() => guard.assertNotLabeled(guard.LABELED_ROLES.STRANGER, "D1"), /STRANGER/);
    assert.throws(() => guard.assertNotLabeled(guard.LABELED_ROLES.FOREIGN, "D3"), /FOREIGN/);
    assert.throws(() => guard.assertNotLabeled(guard.LABELED_ROLES.AMM, "D0"), /AMM/);
    assert.throws(() => guard.assertNotLabeled("_blank_", "D0"), /blank/);
    assert.throws(() => guard.assertNotLaborIssuance(guard.AETH_LABOR_ISSUANCE, "vault"), /AETH-LABOR/);
  });

  it("archives only a Devnet tesSUCCESS row outside the Testnet ledger log", () => {
    const root = tempRoot();
    assert.throws(
      () =>
        guard.archiveDevnet(root, {
          network: "XRPL Testnet",
          network_id: 1,
          result: "tesSUCCESS",
          hash: ENGINE_HASH,
        }),
      /non-Devnet/
    );
    assert.throws(
      () =>
        guard.archiveDevnet(root, {
          network: "XRPL Devnet",
          network_id: 2,
          result: "tecFAILED",
          hash: ENGINE_HASH,
        }),
      /tesSUCCESS/
    );
    const row = guard.archiveDevnet(root, {
      network: "XRPL Devnet",
      network_id: 2,
      result: "tesSUCCESS",
      hash: ENGINE_HASH,
      action: "devnet_sponsor",
    });
    const file = path.join(root, guard.LEDGER_REL);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hash, row.hash);
    assert.equal(fs.existsSync(path.join(root, guard.TESTNET_LEDGER_REL)), false);
  });
});

describe("F8 sponsor builders", () => {
  it("builds a 1-drop sponsored create and a co-signed object reserve", () => {
    const addr = addresses();
    const create = sponsor.buildCreate(addr.d0, addr.d2);
    assert.equal(create.TransactionType, "Payment");
    assert.equal(create.Amount, "1");
    assert.equal(create.Flags, sponsor.TF_SPONSOR_CREATED_ACCOUNT);
    assert.equal(create.Destination, addr.d2);
    const object = sponsor.buildObject(addr.d0, addr.d2);
    assert.equal(object.TransactionType, "DepositPreauth");
    assert.equal(object.Account, addr.d2);
    assert.equal(object.Sponsor, addr.d0);
    assert.equal(object.SponsorFlags, sponsor.SPF_SPONSOR_FEE | sponsor.SPF_SPONSOR_RESERVE);
    assert.throws(() => guard.addressFrom({ D2_ADDRESS: anchors.WALLETS.W5.address }, "D2"), /W5/);
  });

  it("dry-run probes Devnet and does not read seeds", async () => {
    const addr = addresses();
    const mock = mockFetch();
    const root = tempRoot();
    let reads = 0;
    const code = await sponsor.run(
      ["--d0", addr.d0, "--d2", addr.d2, "--xrpl-http", guard.XRPL_DEVNET_HTTP],
      {
        env: { D0_SEED: SEED_SHAPED, D2_SEED: SEED_SHAPED, FOUNDRY_XRPL_HTTP: "https://s1.ripple.com:51234" },
        fetchImpl: mock.fetchImpl,
        root,
        loadSeed: () => {
          reads += 1;
          return SEED_SHAPED;
        },
        stdout: (text) => {
          assert.equal(text.includes(SEED_SHAPED), false);
          const body = JSON.parse(text);
          assert.equal(body.mode, "dry-run");
          assert.equal(body.signed, false);
          assert.equal(body.key_loaded, false);
          assert.equal(body.network, "XRPL Devnet");
          assert.equal(body.network_id, 2);
          assert.equal(body.steps[0].tx.TransactionType, "Payment");
          assert.equal(body.steps[1].tx.TransactionType, "DepositPreauth");
        },
      }
    );
    assert.equal(code, 0);
    assert.equal(reads, 0);
    assert.deepEqual(mock.calls.map((call) => call.body.method), ["server_info", "feature"]);
    assert.equal(mock.calls[0].url, guard.XRPL_DEVNET_HTTP);
    assert.equal(fs.existsSync(path.join(root, guard.LEDGER_REL)), false);
  });

  it("refuses a disabled Sponsor amendment and a non-Devnet id before any tx", async () => {
    const addr = addresses();
    const disabled = mockFetch({
      rows: rows((list) => {
        const row = list.find((item) => item.name === "Sponsor");
        row.enabled = false;
      }),
    });
    const code = await sponsor.run(["--d0", addr.d0, "--d2", addr.d2], {
      env: {},
      fetchImpl: disabled.fetchImpl,
      root: tempRoot(),
      stdout: (text) => {
        const body = JSON.parse(text);
        assert.equal(body.allow, false);
        assert.equal(body.code, "AMENDMENT");
        assert.equal(body.steps.length, 0);
      },
    });
    assert.equal(code, 2);
    const wrong = mockFetch({ network_id: 1 });
    await assert.rejects(
      () => sponsor.run(["--d0", addr.d0, "--d2", addr.d2], { env: {}, fetchImpl: wrong.fetchImpl, root: tempRoot() }),
      /network id 1/
    );
  });

  it("live archives the engine hash and refuses the Testnet gate", async () => {
    const addr = addresses();
    const root = tempRoot();
    const wallet = xrpl.Wallet.generate();
    const mock = mockFetch();
    await assert.rejects(
      () =>
        sponsor.run(["--live", "--step", "create", "--d0", wallet.classicAddress, "--d2", addr.d2], {
          env: { D0_SEED: wallet.seed },
          fetchImpl: mock.fetchImpl,
          root,
        }),
      /FOUNDRY_DAEMON_LIVE/
    );
    let submitted = 0;
    const code = await sponsor.run(["--live", "--step", "create", "--d0", wallet.classicAddress, "--d2", addr.d2], {
      env: liveEnv({ D0_SEED: wallet.seed }),
      fetchImpl: mock.fetchImpl,
      root,
      submit: async () => {
        submitted += 1;
        return {
          hash: ENGINE_HASH,
          result: "tesSUCCESS",
          ledger_index: 4,
          meta: { TransactionResult: "tesSUCCESS" },
        };
      },
      stdout: (text) => {
        const body = JSON.parse(text);
        assert.equal(body.hash, ENGINE_HASH);
        assert.equal(body.network, "XRPL Devnet");
        assert.equal(body.result, "tesSUCCESS");
        assert.equal(text.includes(wallet.seed), false);
      },
    });
    assert.equal(code, 0);
    assert.equal(submitted, 1);
    const archived = JSON.parse(fs.readFileSync(path.join(root, guard.LEDGER_REL), "utf8"));
    assert.equal(archived.hash, ENGINE_HASH);
    assert.equal(archived.network_id, 2);
    assert.equal(fs.existsSync(path.join(root, "lab", "ledger-log.jsonl")), false);
  });
});

describe("F9 vault and loan builders", () => {
  it("builds a closed-ended XRP vault and calls the loan cash-basis", () => {
    const addr = addresses();
    const built = vault.buildCreate(addr.d0, NOW);
    assert.equal(built.tx.TransactionType, "VaultCreate");
    assert.deepEqual(built.tx.Asset, { currency: "XRP" });
    assert.equal(Object.prototype.hasOwnProperty.call(built.tx, "Scale"), false);
    assert.equal(built.tx.VaultKind, vault.VAULT_KIND_CLOSED);
    assert.equal(built.window.accounting, "cash-basis");
    assert.ok(built.window.subscription_date < 1e9);
    assert.equal(built.window.redemption_date - built.window.subscription_date, 3600);
    assert.equal(JSON.stringify(built.tx).includes(guard.AETH_LABOR_ISSUANCE), false);
    const broker = "CD".repeat(32);
    const loan = vault.buildLoan(addr.d0, addr.d1, broker);
    assert.equal(loan.TransactionType, "LoanSet");
    assert.equal(loan.Counterparty, addr.d1);
    assert.equal(loan.PrincipalRequested, vault.PRINCIPAL_DROPS);
    const cover = vault.buildCover(addr.d0, broker);
    assert.equal(cover.TransactionType, "LoanBrokerCoverDeposit");
    assert.equal(cover.Amount, vault.COVER_DROPS);
    assert.equal(cover.Account, addr.d0);
    assert.equal(vault.buildDefault(addr.d0, "EF".repeat(32)).Flags, vault.TF_LOAN_DEFAULT);
    assert.equal(vault.ceilDrops("1000000.1"), "1000001");
    assert.equal(vault.ceilDrops("1000000"), "1000000");
  });

  it("dry-run holds later steps until a real id exists", async () => {
    const addr = addresses();
    const mock = mockFetch();
    const code = await vault.run(["--d0", addr.d0, "--d1", addr.d1], {
      env: { D0_SEED: SEED_SHAPED },
      fetchImpl: mock.fetchImpl,
      now: NOW,
      root: tempRoot(),
      stdout: (text) => {
        assert.equal(text.includes(SEED_SHAPED), false);
        const body = JSON.parse(text);
        assert.equal(body.network_id, 2);
        assert.equal(body.accounting, "cash-basis");
        assert.match(body.cover_source, /Not Testnet W6/);
        assert.equal(body.steps.find((row) => row.step === "create").ready, true);
        assert.equal(body.steps.find((row) => row.step === "deposit").tx, null);
        assert.equal(body.steps.find((row) => row.step === "loan").ready, false);
        assert.equal(body.key_loaded, false);
      },
    });
    assert.equal(code, 0);
    const held = await vault.run(["--step", "deposit", "--d0", addr.d0, "--d1", addr.d1], {
      env: {},
      fetchImpl: mock.fetchImpl,
      now: NOW,
      root: tempRoot(),
      stdout: (text) => {
        const body = JSON.parse(text);
        assert.equal(body.steps[0].ready, false);
      },
    });
    assert.equal(held, 2);
  });

  it("refuses the pack unless all three lending amendments are enabled", async () => {
    const addr = addresses();
    const mock = mockFetch({
      rows: rows((list) => {
        list.find((item) => item.name === "LendingProtocolV1_1").enabled = false;
      }),
    });
    const code = await vault.run(["--d0", addr.d0, "--d1", addr.d1], {
      env: {},
      fetchImpl: mock.fetchImpl,
      now: NOW,
      root: tempRoot(),
      stdout: (text) => {
        const body = JSON.parse(text);
        assert.equal(body.allow, false);
        assert.match(body.message, /LendingProtocolV1_1/);
      },
    });
    assert.equal(code, 2);
    await assert.rejects(
      () =>
        vault.run(["--d0", addr.d0, "--d1", addr.d1], {
          env: {},
          fetchImpl: mockFetch({ network_id: 0 }).fetchImpl,
          root: tempRoot(),
        }),
      /mainnet network id 0/
    );
  });

  it("repay amount comes from PeriodicPayment and rounds up", async () => {
    const addr = addresses();
    const loanId = "12".repeat(32);
    const mock = mockFetch({ periodic: "250000.25" });
    const code = await vault.run(
      ["--step", "repay", "--d0", addr.d0, "--d1", addr.d1, "--loan-id", loanId],
      {
        env: {},
        fetchImpl: mock.fetchImpl,
        now: NOW,
        root: tempRoot(),
        stdout: (text) => {
          const body = JSON.parse(text);
          assert.equal(body.steps[0].tx.TransactionType, "LoanPay");
          assert.equal(body.steps[0].tx.Amount, "250001");
          assert.equal(body.steps[0].tx.Account, addr.d1);
        },
      }
    );
    assert.equal(code, 0);
  });
});

describe("F10 confidential builders", () => {
  it("issues a confidential MPT and withholds proofs", () => {
    const addr = addresses();
    const tx = confidential.buildIssue(addr.d0);
    assert.equal(tx.TransactionType, "MPTokenIssuanceCreate");
    assert.equal(tx.TransferFee, 0);
    assert.equal(tx.Flags & confidential.TF_MPT_CAN_HOLD_CONFIDENTIAL, confidential.TF_MPT_CAN_HOLD_CONFIDENTIAL);
    assert.equal(tx.ImmutableFlags & confidential.TIF_MPT_CAN_HOLD_CONFIDENTIAL, confidential.TIF_MPT_CAN_HOLD_CONFIDENTIAL);
    assert.equal(JSON.stringify(tx).includes("AETH-LABOR"), false);
    assert.equal(JSON.stringify(tx).includes("ZKProof"), false);
    const issuance = "22".repeat(24);
    assert.notEqual(issuance, guard.AETH_LABOR_ISSUANCE);
    const key = `02${"AB".repeat(32)}`;
    const keys = confidential.buildKeys(addr.d0, issuance, key);
    assert.equal(keys.IssuerEncryptionKey, key);
    assert.equal(Object.prototype.hasOwnProperty.call(keys, "AuditorEncryptionKey"), false);
    assert.throws(() => confidential.buildKeys(addr.d0, guard.AETH_LABOR_ISSUANCE, key), /AETH-LABOR/);
    assert.equal(confidential.buildLock(addr.d0, addr.d3, issuance).Flags, confidential.TF_MPT_LOCK);
    assert.match(confidential.PUBLIC_LEDGER.hides.join(" "), /ConfidentialMPTSend amount/);
    assert.match(confidential.PUBLIC_LEDGER.shows.join(" "), /plaintext MPTAmount/);
    assert.match(confidential.PUBLIC_LEDGER.proof, /D0_ELGAMAL_SEED/);
  });

  it("dry-run states what the public ledger hides and does not load seeds", async () => {
    const addr = addresses();
    const mock = mockFetch();
    const code = await confidential.run(
      ["--d0", addr.d0, "--d3", addr.d3, "--sender", addr.sender],
      {
        env: { D0_SEED: SEED_SHAPED, D0_ELGAMAL_SEED: SEED_SHAPED },
        fetchImpl: mock.fetchImpl,
        root: tempRoot(),
        stdout: (text) => {
          assert.equal(text.includes(SEED_SHAPED), false);
          const body = JSON.parse(text);
          assert.equal(body.steps.every((row) => !row.tx || row.tx.ZKProof == null), true);
          assert.equal(body.network, "XRPL Devnet");
          assert.equal(body.network_id, 2);
          assert.equal(body.key_loaded, false);
          assert.equal(body.steps.find((row) => row.step === "issue").tx.Flags, confidential.ISSUANCE_FLAGS);
          assert.equal(body.steps.find((row) => row.step === "pay").tx, null);
          assert.equal(body.steps.find((row) => row.step === "clawback").tx, null);
          assert.match(body.public_ledger.hides[0], /ConfidentialMPTSend/);
        },
      }
    );
    assert.equal(code, 0);
  });

  it("refuses a labeled sender, a self-deal, and a missing confidential amendment", async () => {
    const addr = addresses();
    const labeled = await confidential.run(
      ["--d0", addr.d0, "--d3", addr.d3, "--sender", guard.LABELED_ROLES.W6],
      {
        env: {},
        fetchImpl: mockFetch().fetchImpl,
        root: tempRoot(),
        stdout: (text) => assert.match(JSON.parse(text).message, /W6/),
      }
    );
    assert.equal(labeled, 2);
    const self = await confidential.run(["--d0", addr.d0, "--d3", addr.d3, "--sender", addr.d3], {
      env: {},
      fetchImpl: mockFetch().fetchImpl,
      root: tempRoot(),
      stdout: (text) => assert.match(JSON.parse(text).message, /same account/),
    });
    assert.equal(self, 2);
    const off = await confidential.run(["--d0", addr.d0, "--d3", addr.d3, "--sender", addr.sender], {
      env: {},
      fetchImpl: mockFetch({
        rows: rows((list) => {
          list.find((item) => item.name === "ConfidentialTransfer").enabled = false;
        }),
      }).fetchImpl,
      root: tempRoot(),
      stdout: (text) => assert.match(JSON.parse(text).message, /ConfidentialTransfer/),
    });
    assert.equal(off, 2);
  });

  it("refuses a proof step that did not return a ZKProof and does not submit", async () => {
    const addr = addresses();
    const root = tempRoot();
    const issuance = "11".repeat(24);
    let waited = 0;
    const client = {
      networkID: 2,
      async autofill(tx) {
        return tx;
      },
      async submitAndWait() {
        waited += 1;
        throw new Error("submitted without a proof");
      },
    };
    await assert.rejects(
      () =>
        confidential.run(
          ["--live", "--step", "pay", "--d0", addr.d0, "--d3", addr.d3, "--sender", addr.sender, "--issuance-id", issuance],
          {
            env: liveEnv(),
            fetchImpl: mockFetch().fetchImpl,
            root,
            client,
            prepareProof: async () => ({ TransactionType: "ConfidentialMPTSend", Sequence: 1 }),
          }
        ),
      /ZKProof/
    );
    assert.equal(waited, 0);
    assert.equal(fs.existsSync(path.join(root, guard.LEDGER_REL)), false);
    const wrongNet = { networkID: 1, async autofill(tx) { return tx; }, async submitAndWait() { waited += 1; } };
    await assert.rejects(
      () =>
        guard.submitAutofill(
          { TransactionType: "Payment", Account: addr.d0, Destination: addr.d1, Amount: "1" },
          xrpl.Wallet.fromSeed(xrpl.Wallet.generate().seed).seed,
          addr.d0,
          { networkId: 2, http: guard.XRPL_DEVNET_HTTP, client: wrongNet, env: {} }
        ),
      /Testnet network id 1|seed does not match/
    );
  });
});
