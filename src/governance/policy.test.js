"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const policy = require("./policy");
const keyfile = require("./keyfile");
const live = require("./live");

const ROOT = path.resolve(__dirname, "..", "..");

function failingKeys() {
  return policy
    .coalitions()
    .filter((row) => !row.pass)
    .map((row) => row.ids.join("+"))
    .sort();
}

describe("week-2 quorum", () => {
  it("locks hunch H1 at quorum 3 with weights 2/2/1/1", () => {
    assert.equal(policy.HUNCH, "H1");
    assert.equal(policy.QUORUM, 3);
    assert.deepEqual(
      policy.SIGNERS.map((row) => [row.id, row.weight]),
      [
        ["director", 2],
        ["treasurer", 2],
        ["atelier", 1],
        ["market", 1],
      ]
    );
    assert.equal(policy.sumWeights(policy.SIGNERS), 6);
  });

  it("passes every coalition except singletons and Atelier+Market", () => {
    const all = policy.coalitions();
    assert.equal(all.length, 15);
    assert.equal(all.filter((row) => row.pass).length, 10);
    assert.deepEqual(failingKeys(), [
      "atelier",
      "atelier+market",
      "director",
      "market",
      "treasurer",
    ]);
    const demo = policy.demoSigners();
    assert.equal(policy.sumWeights(demo), policy.QUORUM);
    assert.equal(policy.quorumMet(demo.slice(0, 1)), false);
  });
});

describe("week-2 transaction builders", () => {
  it("sorts SignerEntries by account id and validates", () => {
    const wallets = [0, 1, 2, 3].map(() => xrpl.Wallet.generate("ed25519"));
    const signers = policy.SIGNERS.map((row, i) => ({
      id: row.id,
      persona: row.persona,
      weight: row.weight,
      address: wallets[i].classicAddress,
    }));
    const reversed = signers.slice().reverse();
    const tx = policy.buildSignerListSet(reversed);
    assert.equal(tx.TransactionType, "SignerListSet");
    assert.equal(tx.Account, policy.W0);
    assert.equal(tx.SignerQuorum, 3);
    const addresses = tx.SignerEntries.map((row) => row.SignerEntry.Account);
    const sorted = addresses.slice().sort((a, b) => policy.compareAccounts(a, b));
    assert.deepEqual(addresses, sorted);
    xrpl.validate(tx);
  });

  it("rejects a self-signer, a duplicate, a drifted weight, and a short list", () => {
    const one = xrpl.Wallet.generate("ed25519");
    assert.throws(
      () =>
        policy.buildSignerListSet([
          { id: "director", weight: 2, address: policy.W0 },
        ]),
      /own account/
    );
    assert.throws(
      () =>
        policy.buildSignerListSet([
          { id: "director", weight: 2, address: one.classicAddress },
          { id: "treasurer", weight: 2, address: one.classicAddress },
        ]),
      /duplicate/
    );
    assert.throws(
      () =>
        policy.buildSignerListSet([
          { id: "director", weight: 9, address: one.classicAddress },
        ]),
      /fixed at 2/
    );
    assert.throws(
      () =>
        policy.buildSignerListSet([
          { persona: "solo", weight: 1, address: one.classicAddress },
        ]),
      /quorum/
    );
  });

  it("builds SetRegularKey and refuses AccountSet or asfDisableMaster", () => {
    const regular = xrpl.Wallet.generate("ed25519");
    const tx = policy.buildSetRegularKey(policy.ACCOUNTS[1].address, regular.classicAddress);
    assert.equal(tx.TransactionType, "SetRegularKey");
    assert.equal(tx.SetFlag, undefined);
    xrpl.validate(tx);
    assert.throws(
      () => policy.buildSetRegularKey(policy.ACCOUNTS[1].address, policy.ACCOUNTS[1].address),
      /must not equal/
    );
    assert.throws(
      () => policy.assertNoDisableMaster({ TransactionType: "AccountSet", Account: policy.W0, SetFlag: 4 }),
      /AccountSet|asfDisableMaster/
    );
    assert.equal(policy.masterDisabled(policy.LSF_DISABLE_MASTER), true);
    assert.equal(policy.masterDisabled(0), false);
    assert.throws(() => policy.assertMasterEnabled(policy.LSF_DISABLE_MASTER, "W0"), /lsfDisableMaster/);
  });

  it("keeps the quorum demo under 50 XRP and requires a motion at the line", () => {
    const tx = policy.buildDemoPayment();
    assert.equal(tx.Account, policy.W0);
    assert.equal(tx.Destination, policy.W6);
    assert.equal(tx.Amount, "10000");
    assert.equal(policy.motionRequired(tx.Amount), false);
    assert.equal(policy.motionRequired("49999999"), false);
    assert.equal(policy.motionRequired("50000000"), true);
    assert.doesNotThrow(() => policy.assertMotion("10000", policy.W6, []));
    assert.throws(() => policy.assertMotion("50000000", policy.W6, []), /motion/);
    const motion = {
      name: "send.md",
      text: `destination: ${policy.W6}\namount_xrp: 50\n`,
    };
    assert.equal(policy.motionCovers(motion.text, policy.W6, "50000000"), true);
    assert.doesNotThrow(() => policy.assertMotion("50000000", policy.W6, [motion]));
    assert.throws(
      () => policy.buildDemoPayment({ drops: "50000000" }),
      /without a motion/
    );
    const allowed = policy.buildDemoPayment({ drops: "50000000", motionOk: true });
    assert.equal(allowed.Amount, "50000000");
    assert.equal(policy.isMotionFile("README.md"), false);
    assert.equal(policy.isMotionFile("readme.md"), false);
    assert.equal(policy.isMotionFile("2026-09-27-grant.md"), true);
  });

  it("charges a multisign fee of (signers + 1) times the base and combines a local blob", () => {
    assert.equal(policy.multisignFeeDrops("10", 2), "30");
    assert.equal(policy.signerListOwnerDelta(0), 1);
    assert.equal(policy.signerListOwnerDelta(1), 0);
    const a = xrpl.Wallet.generate("ed25519");
    const b = xrpl.Wallet.generate("ed25519");
    const unsigned = {
      TransactionType: "Payment",
      Account: policy.W0,
      Destination: policy.W6,
      Amount: policy.DEMO_DROPS,
      Fee: "30",
      Sequence: 1,
    };
    const blob = xrpl.multisign([a.sign(unsigned, true).tx_blob, b.sign(unsigned, true).tx_blob]);
    const decoded = xrpl.decode(blob);
    assert.equal(decoded.SigningPubKey, "");
    assert.equal(decoded.Signers.length, 2);
    assert.equal(decoded.Amount, policy.DEMO_DROPS);
    assert.equal(decoded.Destination, policy.W6);
  });

  it("refuses a ledger line without a real hash", () => {
    assert.throws(() => policy.ledgerEvent({ hash: "", result: "tesSUCCESS" }), /hash/);
    assert.throws(
      () => policy.ledgerEvent({ hash: "A".repeat(64), result: "tecUNFUNDED_PAYMENT" }),
      /did not succeed/
    );
    const event = policy.ledgerEvent({
      hash: "ab".repeat(32),
      result: "tesSUCCESS",
      action: "SignerListSet",
    });
    assert.equal(event.hash, "AB".repeat(32));
    assert.equal(policy.isTxHash(event.hash), true);
  });
});

describe("week-2 guards", () => {
  it("refuses CI, mainnet, Xahau, and a non-testnet network id", () => {
    assert.equal(policy.envIsCi({ GITHUB_ACTIONS: "true" }), true);
    assert.equal(policy.envIsCi({ CI: "1" }), true);
    assert.equal(policy.envIsCi({}), false);
    assert.throws(() => policy.assertNotCi({ CI: "true" }), /CI/);
    assert.throws(() => policy.assertTestnetUrl("wss://xrplcluster.com"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("wss://s1.ripple.com"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("wss://s2.ripple.com"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("wss://xrpl.ws"), /mainnet/);
    assert.throws(() => policy.assertTestnetUrl("wss://xahau-test.net"), /Xahau/);
    assert.throws(() => policy.assertTestnetUrl("wss://backup.testnet.xrpl-labs.com"), /non-testnet/);
    assert.throws(() => policy.assertTestnetUrl("wss://xrpl-labs.com"), /non-testnet/);
    assert.equal(
      policy.assertTestnetUrl("wss://s.altnet.rippletest.net:51233"),
      "wss://s.altnet.rippletest.net:51233"
    );
    assert.equal(policy.assertTestnetUrl("wss://testnet.xrpl-labs.com"), "wss://testnet.xrpl-labs.com");
    assert.throws(() => policy.assertNetworkId(0), /NetworkID 0/);
    assert.throws(() => policy.assertNetworkId(21338), /NetworkID 21338/);
    assert.doesNotThrow(() => policy.assertNetworkId(1));
    assert.doesNotThrow(() => policy.assertNetworkId(undefined));
  });

  it("matches an on-ledger signer list independent of order", () => {
    const a = xrpl.Wallet.generate("ed25519").classicAddress;
    const b = xrpl.Wallet.generate("ed25519").classicAddress;
    const planned = {
      SignerQuorum: 3,
      SignerEntries: [
        { SignerEntry: { Account: a, SignerWeight: 2 } },
        { SignerEntry: { Account: b, SignerWeight: 1 } },
      ],
    };
    const ledger = {
      SignerQuorum: 3,
      SignerEntries: [
        { SignerEntry: { Account: b, SignerWeight: 1 } },
        { SignerEntry: { Account: a, SignerWeight: 2 } },
      ],
    };
    assert.equal(policy.signerListsMatch(ledger, planned), true);
    assert.equal(policy.signerListsMatch({ SignerQuorum: 2, SignerEntries: ledger.SignerEntries }, planned), false);
    const info = { signer_lists: [ledger], account_data: { RegularKey: a } };
    assert.equal(live.decideSigner(info, planned, false), "skip");
    assert.equal(live.decideRegular({ account_data: { RegularKey: a } }, a, false, "W1"), "skip");
    assert.throws(
      () => live.decideRegular({ account_data: { RegularKey: b } }, a, false, "W1"),
      /without --replace/
    );
    assert.equal(live.decideRegular({ account_data: { RegularKey: b } }, a, true, "W1"), "set");
    assert.equal(live.decideSigner({ signer_lists: [] }, planned, false), "set");
  });

  it("does not read seeds from the dry-run script", () => {
    const src = fs.readFileSync(path.join(__dirname, "dry-run.js"), "utf8");
    assert.doesNotMatch(src, /fromSeed|AETHER_SECRETS|\.seed|Wallet\.generate/);
    const liveSrc = fs.readFileSync(path.join(__dirname, "live.js"), "utf8");
    const ciAt = liveSrc.indexOf("assertNotCi");
    const readAt = liveSrc.indexOf("readKeyFile");
    assert.ok(ciAt > 0 && readAt > ciAt);
    assert.doesNotMatch(liveSrc, /EscrowFinish|EscrowCancel/);
    const web = fs.readFileSync(path.join(ROOT, "web", "lib", "xrpl-read.ts"), "utf8");
    assert.doesNotMatch(web, /governance|Wallet\.sign|fromSeed/);
  });

  it("writes new secret names without overwriting or returning the value", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-gov-"));
    const file = path.join(dir, "secrets.env");
    const seed = "not-a-real-seed-value";
    fs.writeFileSync(file, "SIGNER_DIRECTOR_SEED=already-there\n", { mode: 0o600 });
    const result = keyfile.upsertKeyFile(file, {
      SIGNER_DIRECTOR_SEED: "replacement-should-not-land",
      SIGNER_TREASURER_SEED: seed,
    });
    assert.deepEqual(result.wrote, ["SIGNER_TREASURER_SEED"]);
    assert.equal(JSON.stringify(result).includes(seed), false);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /SIGNER_DIRECTOR_SEED=already-there/);
    assert.match(text, new RegExp(`SIGNER_TREASURER_SEED=${seed}`));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(
      () => keyfile.upsertKeyFile(file, { "not safe": "x" }),
      /not uppercase/
    );
    assert.throws(
      () =>
        keyfile.assertIgnoredIfInsideRepo("corp/wallets.md", ROOT, () => {
          throw new Error("not ignored");
        }),
      /does not ignore/
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reloads signer addresses from existing seeds and refuses anchor collisions", () => {
    const made = policy.SIGNERS.map((row) => xrpl.Wallet.generate("ed25519"));
    const regulars = policy.ACCOUNTS.filter((row) => row.regularEnv).map(() =>
      xrpl.Wallet.generate("ed25519")
    );
    const env = {};
    policy.SIGNERS.forEach((row, i) => {
      env[row.env] = made[i].seed;
    });
    policy.ACCOUNTS.filter((row) => row.regularEnv).forEach((row, i) => {
      env[row.regularEnv] = regulars[i].seed;
    });
    const board = live.boardFromEnv(env, { generate: false });
    assert.deepEqual(Object.keys(board.generated), []);
    assert.deepEqual(
      board.signers.map((row) => row.address),
      made.map((row) => row.classicAddress)
    );
    assert.throws(() => live.boardFromEnv({}, { generate: false }), /is not loaded/);
    assert.throws(
      () =>
        policy.disjointBoard([
          { address: policy.W0, label: "Director" },
        ]),
      /Foundry anchor/
    );
    const text = policy.renderDryRun({
      server: { ledgerIndex: 1, reserveBase: "1000000", reserveInc: "200000", networkId: 1 },
      accounts: [
        {
          id: "W0",
          address: policy.W0,
          balanceDrops: "100000000",
          ownerCount: 2,
          regularKey: null,
          signerLists: [],
          disableMaster: false,
          passwordSpent: false,
        },
      ],
    });
    assert.match(text, /no tx hash \(not submitted\)/);
    assert.match(text, /hunch H1/);
    assert.match(text, /owner_delta=1/);
  });
});

describe("tracked governance files", () => {
  it("keeps placeholder seed keys empty and does not store an ed25519 seed", () => {
    const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const row of policy.SIGNERS) {
      assert.match(example, new RegExp(`^${row.env}=$`, "m"));
    }
    for (const row of policy.ACCOUNTS) {
      if (!row.regularEnv) continue;
      assert.match(example, new RegExp(`^${row.regularEnv}=$`, "m"));
    }
    const charter = fs.readFileSync(path.join(ROOT, "corp", "charter.md"), "utf8");
    assert.match(charter, /SignerQuorum: 3/);
    assert.doesNotMatch(charter, /week 2 target/);
    assert.doesNotMatch(charter, /sEd[1-9A-HJ-NP-Za-km-z]{10}/);
    const tracked = [
      "corp/charter.md",
      "corp/wallets.md",
      "src/governance/policy.js",
      "machines/governance-board/README.md",
    ];
    for (const rel of tracked) {
      const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.doesNotMatch(body, /sEd[1-9A-HJ-NP-Za-km-z]{10}/);
    }
  });
});
