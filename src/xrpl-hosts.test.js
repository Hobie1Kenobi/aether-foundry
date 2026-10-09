"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const hosts = require("./xrpl-hosts");

describe("XRPL Testnet host allowlist", () => {
  it("approves rippletest.net and the exact XRPL Labs testnet host", () => {
    assert.equal(hosts.isApprovedXrplTestnetHost("s.altnet.rippletest.net"), true);
    assert.equal(hosts.isApprovedXrplTestnetHost("faucet.altnet.rippletest.net"), true);
    assert.equal(hosts.isApprovedXrplTestnetHost("rippletest.net"), true);
    assert.equal(hosts.isApprovedXrplTestnetHost("testnet.xrpl-labs.com"), true);
    assert.equal(hosts.isLabsTestnetHost("TESTNET.XRPL-LABS.COM"), true);
  });

  it("refuses mainnet hosts and any broader xrpl-labs name", () => {
    for (const host of [
      "s1.ripple.com",
      "s2.ripple.com",
      "xrplcluster.com",
      "xrpl.ws",
      "s1.xrpl.ws",
      "xrpl-labs.com",
      "xrplcluster.xrpl-labs.com",
      "backup.testnet.xrpl-labs.com",
      "testnet.xrpl-labs.com.evil.example",
      "s.altnet.rippletest.net.evil.com",
    ]) {
      assert.equal(hosts.isApprovedXrplTestnetHost(host), false, host);
    }
  });

  it("falls back only from the primary rippletest host", () => {
    assert.equal(hosts.fallbackUrl(hosts.PRIMARY_HTTP), hosts.LABS_HTTP);
    assert.equal(hosts.fallbackUrl(hosts.PRIMARY_WS), hosts.LABS_WS);
    assert.deepEqual(hosts.candidates(hosts.PRIMARY_HTTP), [hosts.PRIMARY_HTTP, hosts.LABS_HTTP]);
    assert.equal(hosts.fallbackUrl(hosts.LABS_HTTP), null);
    assert.equal(hosts.fallbackUrl("https://s1.ripple.com:51234"), null);
    assert.equal(hosts.fallbackUrl("https://s.devnet.rippletest.net:51234"), null);
    assert.equal(hosts.fallbackUrl("wss://xrpl.ws"), null);
    assert.equal(hosts.matchingWs(hosts.LABS_HTTP, hosts.PRIMARY_WS), hosts.LABS_WS);
    assert.equal(hosts.matchingWs(hosts.PRIMARY_HTTP, "wss://testnet.xrpl-labs.com"), "wss://testnet.xrpl-labs.com");
  });

  it("treats timeouts as transport failures and network-id refusals as final", () => {
    assert.equal(hosts.isTransportFailure(new Error("fetch failed")), true);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), true);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("server_info failed: socket hang up"), { code: "RPC" })), true);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("server_info failed: HTTP 503"), { code: "RPC" })), true);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("refusing mainnet network id 0"), { code: "MAINNET" })), false);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("refusing network id 21337"), { code: "MAINNET" })), false);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("account_objects failed: actNotFound"), { code: "RPC" })), false);
    assert.equal(hosts.isTransportFailure(Object.assign(new Error("refusing mainnet host s1.ripple.com"), { code: "MAINNET" })), false);
  });
});
