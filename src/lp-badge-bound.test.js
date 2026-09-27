"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const xrpl = require("xrpl");
const guard = require("./lp-badge-bound-guard");

describe("lp badge threshold math", () => {
  it("treats 1000 and values above it as meeting the door threshold", () => {
    assert.equal(guard.lpMeetsThreshold("1000", "1000"), true);
    assert.equal(guard.lpMeetsThreshold("1000.0", "1000"), true);
    assert.equal(guard.lpMeetsThreshold("1000.0001", "1000"), true);
    assert.equal(guard.lpMeetsThreshold("4021.5", guard.LP_THRESHOLD), true);
    assert.equal(guard.lpMeetsThreshold("0001000.10", "1000.1"), true);
  });

  it("treats a withdrawn balance as below threshold", () => {
    assert.equal(guard.lpBelowThreshold("999.9", "1000"), true);
    assert.equal(guard.lpBelowThreshold("0", "1000"), true);
    assert.equal(guard.lpBelowThreshold("-1", "1000"), true);
    assert.equal(guard.lpMeetsThreshold("999", "1000"), false);
  });

  it("orders negatives by magnitude", () => {
    assert.equal(guard.decimalCmp("-10", "-2"), -1);
    assert.equal(guard.decimalCmp("-2", "-10"), 1);
    assert.equal(guard.decimalCmp("-2.50", "-2.5"), 0);
  });

  it("rejects scientific notation", () => {
    assert.throws(() => guard.decimalCmp("1e3", "1000"), /bad decimal/);
  });

  it("reads the AMM LP line and ignores other currencies", () => {
    const lines = [
      { currency: guard.AETH_HEX, account: guard.W0, balance: "12" },
      { currency: guard.LP_CURRENCY, account: guard.AMM, balance: "4021.5" },
      { currency: guard.LP_CURRENCY, account: "rOTHER", balance: "1" },
    ];
    assert.equal(guard.lpBalanceFromLines(lines, guard.LP_CURRENCY, guard.AMM), "4021.5");
    assert.equal(guard.iouBalanceFromLines(lines, guard.AETH_HEX, guard.W0), "12");
    assert.equal(guard.lpBalanceFromLines([], guard.LP_CURRENCY, guard.AMM), "0");
  });
});

describe("credential index and door transactions", () => {
  it("hashes with the same sha512-half construction as an account root", () => {
    const hex = Buffer.from(xrpl.decodeAccountID(guard.W0)).toString("hex");
    assert.equal(guard.sha512Half(`0061${hex}`), xrpl.hashes.hashAccountRoot(guard.W0));
  });

  it("builds the Credential keylet as space D + subject + issuer + type", () => {
    const type = guard.credentialTypeHex("aether-lp-ok");
    assert.equal(type, "6165746865722D6C702D6F6B");
    const id = guard.credentialIndex(guard.W1, guard.W2, type);
    const manual = guard.sha512Half(
      `0044${Buffer.from(xrpl.decodeAccountID(guard.W1)).toString("hex")}${Buffer.from(
        xrpl.decodeAccountID(guard.W2)
      ).toString("hex")}${type.toLowerCase()}`
    );
    assert.equal(id, manual);
    assert.equal(id.length, 64);
    assert.notEqual(guard.credentialIndex(guard.W0, guard.W2, type), id);
  });

  it("shapes the deposit-auth door around one credential and a presented id", () => {
    const type = guard.credentialTypeHex();
    const uri = guard.credentialUriHex(guard.README_URI);
    const pre = guard.buildDepositPreauth(guard.W2, guard.W0, type);
    assert.equal(pre.Authorize, undefined);
    assert.equal(pre.Unauthorize, undefined);
    assert.equal(pre.AuthorizeCredentials.length, 1);
    assert.equal(pre.AuthorizeCredentials[0].Credential.Issuer, guard.W0);
    assert.equal(pre.AuthorizeCredentials[0].Credential.CredentialType, type);
    assert.equal(guard.buildAccountSetDepositAuth(guard.W2).SetFlag, 9);
    const create = guard.buildCredentialCreate(guard.W0, guard.W1, type, uri);
    assert.equal(create.TransactionType, "CredentialCreate");
    assert.equal(create.Subject, guard.W1);
    const id = guard.credentialIndex(guard.W1, guard.W0, type);
    const pass = guard.buildDoorPayment(guard.W1, guard.W2, guard.DOOR_PAYMENT_DROPS, id);
    const bare = guard.buildDoorPayment(guard.W1, guard.W2, guard.DOOR_PAYMENT_DROPS);
    assert.deepEqual(pass.CredentialIDs, [id]);
    assert.equal(bare.CredentialIDs, undefined);
    assert.equal(pass.Amount, "100000");
    const del = guard.buildCredentialDelete(guard.W0, guard.W1, type);
    assert.equal(del.Account, guard.W0);
    assert.equal(del.Subject, guard.W1);
    assert.equal(del.Issuer, guard.W0);
    assert.equal(guard.buildAmmDeposit(guard.W1).Flags, xrpl.AMMDepositFlags.tfTwoAsset);
    assert.equal(guard.buildAmmWithdrawAll(guard.W1).Flags, xrpl.AMMWithdrawFlags.tfWithdrawAll);
  });

  it("reads a created credential index from metadata", () => {
    const id = "AB".repeat(32);
    const found = guard.createdLedgerIndex(
      {
        AffectedNodes: [
          { ModifiedNode: { LedgerEntryType: "AccountRoot" } },
          { CreatedNode: { LedgerEntryType: "Credential", LedgerIndex: id.toLowerCase() } },
        ],
      },
      "Credential"
    );
    assert.equal(found, id);
    assert.equal(guard.createdLedgerIndex({ AffectedNodes: [] }, "Credential"), null);
  });
});

describe("amendment gate and signing refusals", () => {
  it("requires Credentials enabled and refuses a Hooks-named amendment on this server", () => {
    const live = guard.featureReport({
      [guard.CREDENTIALS_AMENDMENT]: { name: "Credentials", enabled: true, supported: true },
    });
    assert.equal(live.credentials.enabled, true);
    assert.equal(live.hooks_on_this_server, false);
    assert.doesNotThrow(() => guard.assertCredentialsLive(live));
    const missing = guard.featureReport({});
    assert.throws(() => guard.assertCredentialsLive(missing), /not enabled/);
    const hooked = guard.featureReport({
      [guard.CREDENTIALS_AMENDMENT]: { name: "Credentials", enabled: true, supported: true },
      ABC: { name: "Hooks", enabled: true, supported: true },
    });
    assert.throws(() => guard.assertCredentialsLive(hooked), /Hooks/);
    const disabledHook = guard.featureReport({
      [guard.CREDENTIALS_AMENDMENT]: { name: "Credentials", enabled: true, supported: true },
      DEF: { name: "Hooks", enabled: false, supported: true },
    });
    assert.equal(disabledHook.hooks_on_this_server, false);
    assert.doesNotThrow(() => guard.assertCredentialsLive(disabledHook));
  });

  it("refuses CI, mainnet hosts, Xahau, and network id 0", () => {
    assert.equal(guard.envIsCi({ GITHUB_ACTIONS: "true" }), true);
    assert.equal(guard.envIsCi({ CI: "true" }), true);
    assert.throws(() => guard.assertCanSign({ GITHUB_ACTIONS: "true", CI: "" }), /CI/);
    assert.throws(() => guard.assertXrplTestnetUrl("wss://xrplcluster.com"), /non-XRPL-Testnet/);
    assert.throws(() => guard.assertXrplTestnetUrl("wss://s1.ripple.com"), /non-XRPL-Testnet/);
    assert.throws(() => guard.assertXrplTestnetUrl("wss://xahau-test.net"), /non-XRPL-Testnet/);
    assert.throws(() => guard.assertXrplTestnetUrl("https://xahau.network"), /non-XRPL-Testnet/);
    assert.equal(
      guard.assertXrplTestnetUrl("wss://s.altnet.rippletest.net:51233"),
      "wss://s.altnet.rippletest.net:51233"
    );
    assert.equal(guard.assertXrplTestnetUrl(guard.FAUCET_URL), guard.FAUCET_URL);
    assert.throws(() => guard.assertNetworkId(0), /network id 0/);
    assert.throws(() => guard.assertNetworkId(21337), /21337/);
    assert.equal(guard.assertNetworkId(1), 1);
  });

  it("refuses to archive a seed-shaped string or a seed key", () => {
    assert.throws(
      () => guard.assertPublicRecord({ hash: "sEdTMY4s9ExampSeSeedVaueXXXX" }),
      /secret/
    );
    assert.throws(() => guard.assertPublicRecord({ LPB_ISSUER_SEED: "nope" }), /key/);
    assert.doesNotThrow(() =>
      guard.assertPublicRecord({
        hash: "A".repeat(64),
        address: guard.W1,
        engine: "tecNO_PERMISSION",
      })
    );
  });

  it("reads the altnet faucet body that puts seed beside account", () => {
    const parsed = guard.parseFaucetBody({
      account: {
        xAddress: "X7dnRr1KAaERYd8BjrKBVF3Cs2LR7LbbZrSUZNr57dth5es",
        address: "rsv2i5sHDua4eCxg9nzLxrpZqVqwbDzkh4",
        classicAddress: "rsv2i5sHDua4eCxg9nzLxrpZqVqwbDzkh4",
      },
      amount: 100,
      transactionHash: "9cb96211f81061f27ec688bffb9cf921ff697e90371de133b3234a1983f0dada",
      seed: "faucet-seed-field",
    });
    assert.equal(parsed.address, "rsv2i5sHDua4eCxg9nzLxrpZqVqwbDzkh4");
    assert.equal(parsed.amount, 100);
    assert.equal(parsed.hash, "9CB96211F81061F27EC688BFFB9CF921FF697E90371DE133B3234A1983F0DADA");
    assert.equal(parsed.secret, "faucet-seed-field");
    assert.equal(guard.parseFaucetBody({ account: { classicAddress: "rX" } }), null);
  });

  it("flags deposit auth and accepted credentials by their ledger bits", () => {
    assert.equal(guard.hasDepositAuth(guard.LSF_DEPOSIT_AUTH), true);
    assert.equal(guard.hasDepositAuth(0), false);
    assert.equal(guard.LSF_DEPOSIT_AUTH, 16777216);
    assert.equal(guard.credentialAccepted(guard.LSF_ACCEPTED), true);
    assert.equal(guard.credentialAccepted(0), false);
  });
});
