"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const anchors = require("../../director/anchors");
const grants = require("../../grants/policy");
const runtimePolicy = require("../../runtime/policy");
const config = require("./config");
const { keccak256 } = require("./keccak");
const abi = require("./abi");
const bridgePolicy = require("./policy");
const planner = require("./plan");
const status = require("./status");
const { memoryStore } = require("./store");
const cli = require("./cli");

const XRPL = "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss";
const EVM = "0x312dba807EAE77f01EF3dd21E885052f8F617c5B";
const NOW = "2026-11-06T16:00:00.000Z";

function book() {
  return {
    schema: "aether.axelar-its.wallets",
    network: "xrpl_testnet",
    evm_chain_id: "1449000",
    accounts: {
      bridge_xrpl_test: XRPL,
      bridge_evm_test: EVM,
    },
  };
}

function forward(extra) {
  return Object.assign(
    {
      direction: "xrpl-to-evm",
      client_id: "round-trip-01",
      asset: "XRP",
      amount_drops: "1000000",
      gas_drops: "100000",
      from: XRPL,
      to: EVM,
      wallets: book(),
    },
    extra || {}
  );
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function memoValue(tx, name) {
  const type = Buffer.from(name, "utf8").toString("hex").toUpperCase();
  const row = tx.Memos.find((item) => item.Memo.MemoType === type);
  assert.ok(row, name);
  return Buffer.from(row.Memo.MemoData, "hex").toString("utf8");
}

describe("axelar its testnet plan", () => {
  it("plans a dry-run XRPL to XRPL EVM native XRP payment", () => {
    const row = planner.plan(forward(), null, NOW);
    assert.equal(row.mode, "dry-run");
    assert.equal(row.signed, false);
    assert.equal(row.submitted, false);
    assert.equal(row.signable, false);
    assert.equal(row.key_loaded, false);
    assert.equal(row.final, false);
    assert.equal(row.status, "planned");
    assert.equal(row.review_ready, true);
    assert.equal(row.destination_amount, null);
    assert.equal(row.network_id, 1);
    assert.equal(row.evm_chain_id, "1449000");
    assert.equal(row.xrpl_http, "https://testnet.xrpl-labs.com");
    assert.equal(row.unsigned_tx.Destination, config.XRPL_GATEWAY);
    assert.equal(row.unsigned_tx.Account, XRPL);
    assert.equal(row.unsigned_tx.Amount, "1000000");
    assert.equal(row.unsigned_tx.NetworkID, 1);
    assert.equal(row.transfer_drops, "900000");
    assert.equal(memoValue(row.unsigned_tx, "type"), "interchain_transfer");
    assert.equal(memoValue(row.unsigned_tx, "destination_chain"), "xrpl-evm");
    assert.equal(memoValue(row.unsigned_tx, "destination_address"), EVM.slice(2).toLowerCase());
    assert.equal(memoValue(row.unsigned_tx, "gas_fee_amount"), "100000");
    assert.equal(row.unsigned_tx.Memos.length, 4);
    assert.equal(JSON.stringify(row).includes(anchors.WALLETS.W0.address), false);
    assert.equal(row.xrpl_http_ignored_published.includes("altnet"), true);
    assert.notEqual(row.xrpl_http, row.xrpl_http_ignored_published);
  });

  it("blocks the return leg instead of guessing native value", () => {
    const row = planner.build(
      {
        direction: "evm-to-xrpl",
        client_id: "return-leg-01",
        amount_wei: "1000000000000000000",
        gas_value_wei: "100000000000000000",
        from: EVM,
        to: XRPL,
        wallets: book(),
      },
      NOW
    );
    assert.equal(row.review_ready, false);
    assert.equal(row.signable, false);
    assert.equal(row.evm_call.value_wei, null);
    assert.equal(row.blocked.code, "NATIVE_VALUE_UNVERIFIED");
    assert.equal(row.evm_call.data.startsWith(`0x${abi.SELECTOR}`), true);
    assert.equal(abi.SELECTOR, "da081c73");
    assert.ok(row.evm_call.data.includes(Buffer.from(XRPL, "ascii").toString("hex")));
    const store = memoryStore();
    store.put(row);
    throwsCode(() => planner.review(store, row.id, config.REVIEW_PHRASE, NOW), "NATIVE_VALUE_UNVERIFIED");
  });

  it("refuses a missing wallet book, a Foundry wallet, and a payload", () => {
    throwsCode(() => planner.build(forward({ wallets: null })), "WALLET");
    throwsCode(() => planner.build(forward({ wallets: { schema: "aether.axelar-its.wallets", network: "xrpl_testnet", evm_chain_id: "1449000", accounts: {} } })), "WALLET");
    throwsCode(() => planner.build(forward({ from: anchors.WALLETS.W0.address })), "WALLET");
    throwsCode(() => planner.build(forward({ payload: "0x01" })), "PAYLOAD");
    throwsCode(() => planner.build(forward({ asset: "AETH" })), "ASSET");
  });

  it("refuses mainnet networks, hosts, and other assets or chains", () => {
    throwsCode(() => planner.build(forward({ network_id: 0 })), "MAINNET");
    throwsCode(() => planner.build(forward({ network_id: "0" })), "MAINNET");
    throwsCode(() => planner.build(forward({ evm_chain_id: "1440000" })), "MAINNET");
    throwsCode(() => planner.build(forward({ network: "xrpl_mainnet" })), "MAINNET");
    throwsCode(() => bridgePolicy.assertXrplEndpoint("https://xrplcluster.com"), "MAINNET");
    throwsCode(() => bridgePolicy.assertXrplEndpoint("https://s1.ripple.com:51234"), "MAINNET");
    throwsCode(() => bridgePolicy.assertUrlPinned("https://api.axelarscan.io", config.GMP_API, "GMP api"), "MAINNET");
    throwsCode(() => bridgePolicy.assertUrlPinned("https://rpc.xrplevm.org", config.EVM_RPC, "XRPL EVM rpc"), "MAINNET");
    throwsCode(() => planner.build(forward({ direction: "ethereum" })), "UNSUPPORTED");
    throwsCode(() => planner.build(forward({ direction: "stellar" })), "UNSUPPORTED");
    const stellar = config.stellarRoute();
    assert.equal(stellar.supported, false);
    assert.equal(stellar.implemented, false);
    assert.equal(stellar.signable, false);
    assert.equal(stellar.chain_id_seen_in_axelar_testnet_config, "stellar-2026-q1-2");
  });

  it("enforces caps, one in-flight plan, and client id replay", () => {
    throwsCode(() => planner.build(forward({ gas_drops: "1000000" })), "GAS");
    throwsCode(() => planner.build(forward({ gas_drops: "0" })), "CAP");
    throwsCode(() => planner.build(forward({ amount_drops: "2000001" })), "CAP");
    const store = memoryStore();
    const first = planner.plan(forward(), store, NOW);
    const again = planner.plan(forward(), store, NOW);
    assert.equal(again.id, first.id);
    assert.equal(store.list().length, 1);
    throwsCode(() => planner.plan(forward({ gas_drops: "100001" }), store, NOW), "REPLAY");
    throwsCode(() => planner.plan(forward({ client_id: "round-trip-02" }), store, NOW), "IN_FLIGHT");
    const day = memoryStore();
    day.put({
      client_id: "day-full-01",
      direction: "xrpl-to-evm",
      source_account: XRPL,
      amount_drops: "4500000",
      status: "final",
      created_at: NOW,
    });
    throwsCode(() => planner.plan(forward({ client_id: "day-next-01" }), day, NOW), "CAP");
  });

  it("records review without unlocking signing", () => {
    const store = memoryStore();
    const row = planner.plan(forward(), store, NOW);
    throwsCode(() => planner.review(store, row.id, "approve", NOW), "APPROVAL");
    const reviewed = planner.review(store, row.id, config.REVIEW_PHRASE, NOW);
    assert.equal(reviewed.plan.status, "approved_unsigned");
    assert.equal(reviewed.plan.signable, false);
    assert.equal(reviewed.review.submitted, false);
    throwsCode(() => planner.refuseSign(), "SIGNING_DISABLED");
    throwsCode(() => cli.main(["node", "cli", "sign"]), "SIGNING_DISABLED");
    throwsCode(() => cli.main(["node", "cli", "submit"]), "SIGNING_DISABLED");
  });
});

describe("axelar settlement status", () => {
  it("keeps source inclusion and unknown GMP states unsettled", () => {
    const included = status.classify({
      direction: "xrpl-to-evm",
      xrpl: { validated: true, result: "tesSUCCESS", network_id: 1 },
    });
    assert.equal(included.status, "uncertain");
    assert.equal(included.final, false);
    assert.equal(included.funds_at_gateway_possible, true);

    const gist = status.classify({ direction: "xrpl-to-evm", gmp: { status: "executed" } });
    assert.equal(gist.status, "uncertain");
    assert.equal(gist.final, false);

    const missing = status.classify({
      direction: "xrpl-to-evm",
      gmp: { status: "cannot_fetch_status" },
    });
    assert.equal(missing.status, "uncertain");
    assert.equal(missing.final, false);

    const empty = status.classify({ direction: "xrpl-to-evm", gmp: { data: [] } });
    assert.equal(empty.status, "uncertain");
    assert.equal(empty.final, false);
  });

  it("reports recovery and error without calling them final", () => {
    const recovery = status.classify({ direction: "xrpl-to-evm", gmp: { status: "insufficient_fee" } });
    assert.equal(recovery.status, "recovery");
    assert.equal(recovery.final, false);
    assert.equal(recovery.recovery_action, "manual_add_gas_not_implemented");

    const failed = status.classify({
      direction: "xrpl-to-evm",
      xrpl: { validated: true, result: "tecUNFUNDED_PAYMENT", network_id: 1 },
    });
    assert.equal(failed.status, "error");
    assert.equal(failed.final, false);
    assert.equal(failed.funds_at_gateway_possible, false);

    const mainnet = status.classify({ network_id: 0 });
    assert.equal(mainnet.code, "MAINNET");
    assert.equal(mainnet.final, false);
  });

  it("finalizes only a known executed status with a matching destination proof", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const unproven = status.classify({
      direction: "xrpl-to-evm",
      gmp: { status: "destination_executed", executed: { transactionHash: hash } },
    });
    assert.equal(unproven.status, "uncertain");
    assert.equal(unproven.final, false);
    const proven = status.classify({
      direction: "xrpl-to-evm",
      gmp: { data: [{ status: "destination_executed", executed: { transactionHash: hash } }] },
      destination_proof: {
        network: "xrpl_evm_testnet",
        chain_id: "1449000",
        status: "success",
        tx_hash: hash,
      },
    });
    assert.equal(proven.status, "final");
    assert.equal(proven.final, true);
    const wrongChain = status.classify({
      direction: "xrpl-to-evm",
      gmp: { status: "destination_executed", executed: { transactionHash: hash } },
      destination_proof: {
        network: "xrpl_evm_testnet",
        chain_id: "1440000",
        status: "success",
        tx_hash: hash,
      },
    });
    assert.equal(wrongChain.final, false);
  });

  it("refuses a live status host outside the testnet pins", async () => {
    throwsCode(() => status.assertFetchUrl("https://xrplcluster.com"), "MAINNET");
    throwsCode(() => status.assertFetchUrl("https://s2.ripple.com:51234"), "MAINNET");
    const calls = [];
    await assert.rejects(
      () =>
        status.fetchStatus(
          { hash: "aa".repeat(32) },
          {
            fetch: async () => {
              calls.push("called");
              return { json: async () => ({ result: "0x1" }) };
            },
          }
        ),
      (error) => error.code === "MAINNET"
    );
    assert.equal(calls.length, 1);
    calls.length = 0;
    const ok = await status.fetchStatus(
      { hash: "aa".repeat(32) },
      {
        fetch: async (url) => {
          calls.push(String(url));
          if (String(url).includes("rpc.testnet.xrplevm.org")) {
            return { json: async () => ({ result: "0x161c28" }) };
          }
          return { json: async () => ({ result: {} }) };
        },
      }
    );
    assert.equal(ok.signed, false);
    assert.equal(ok.submitted, false);
    assert.ok(calls.every((url) =>
      url.startsWith("https://testnet.xrpl-labs.com") ||
      url.startsWith("https://rpc.testnet.xrplevm.org") ||
      url.startsWith("https://testnet.api.axelarscan.io")
    ));
  });
});

describe("signer and grant boundary", () => {
  it("does not let the agent signer or grants pay the gateway", () => {
    throwsCode(
      () =>
        runtimePolicy.assertAgentRequest({
          env: { FOUNDRY_AGENT_SIGN: "yes" },
          wallet: "W6",
          intent: "grant_pay",
          tx: {
            TransactionType: "Payment",
            Account: anchors.WALLETS.W6.address,
            Destination: config.XRPL_GATEWAY,
            Amount: "10",
          },
        }),
      "BRIDGE"
    );
    throwsCode(
      () =>
        runtimePolicy.assertNotAxelarPayment(
          { TransactionType: "Payment", Destination: XRPL, Amount: "1" },
          "axelar_its"
        ),
      "BRIDGE"
    );
    throwsCode(
      () => grants.buildGrantPayment({ destination: config.XRPL_GATEWAY, drops: "10", reason: "artifact_holder" }),
      "BRIDGE"
    );
    throwsCode(
      () =>
        grants.buildAethGrantPayment({
          destination: config.XRPL_GATEWAY_MAINNET_REFUSED,
          value: "1",
          reason: "aeth_counterparty",
        }),
      "BRIDGE"
    );
    throwsCode(
      () => runtimePolicy.assertOutbound({ payTo: config.XRPL_GATEWAY, drops: "10", has402: true, network: "xrpl:1" }),
      "BRIDGE"
    );
  });

  it("does not read or name a seed in the bridge pack", () => {
    assert.equal(keccak256(Buffer.alloc(0)).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    const dir = __dirname;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js") || file.endsWith(".test.js")) continue;
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      assert.equal(/W0_SEED|fromSeed|dotenv|aether-foundry-secrets/.test(text), false, file);
    }
    const signer = fs.readFileSync(path.join(__dirname, "..", "..", "runtime", "signer.js"), "utf8");
    assert.equal(signer.includes("W0_SEED"), false);
    assert.equal(signer.includes("axelar"), false);
  });
});
