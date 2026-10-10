"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const hosts = require("./xrpl-hosts");

describe("XRPL Testnet host allowlist", () => {
  it("approves rippletest.net and the exact XRPL Labs testnet host", () => {
    assert.equal(hosts.isApprovedXrplTestnetHost("s.altnet.rippletest.net"), true);
    assert.equal(hosts.isApprovedXrplTestnetHost("faucet.altnet.rippletest.net"), true);
    assert.equal(hosts.isApprovedXrplTestnetHost("rippletest.net"), true);
    assert.equal(hosts.isApprovedXrplTestnetHost("testnet.xrpl-labs.com"), true);
    assert.equal(hosts.isLabsTestnetHost("TESTNET.XRPL-LABS.COM"), true);
    assert.equal(hosts.isPrimaryHost("testnet.xrpl-labs.com"), true);
    assert.equal(hosts.isAltnetHost("s.altnet.rippletest.net"), true);
    assert.equal(hosts.isAltnetHost("faucet.altnet.rippletest.net"), false);
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

  it("uses XRPL Labs as primary and falls back once to Ripple altnet", () => {
    assert.equal(hosts.PRIMARY_HTTP, hosts.LABS_HTTP);
    assert.equal(hosts.PRIMARY_WS, hosts.LABS_WS);
    assert.equal(hosts.FALLBACK_HTTP, hosts.ALTNET_HTTP);
    assert.equal(hosts.FALLBACK_WS, hosts.ALTNET_WS);
    assert.equal(hosts.FAUCET_URL, "https://faucet.altnet.rippletest.net/accounts");
    assert.equal(hosts.fallbackUrl(hosts.PRIMARY_HTTP), hosts.FALLBACK_HTTP);
    assert.equal(hosts.fallbackUrl(hosts.PRIMARY_WS), hosts.FALLBACK_WS);
    assert.deepEqual(hosts.candidates(hosts.PRIMARY_HTTP), [hosts.PRIMARY_HTTP, hosts.FALLBACK_HTTP]);
    assert.equal(hosts.fallbackUrl(hosts.FALLBACK_HTTP), null);
    assert.equal(hosts.fallbackUrl(hosts.ALTNET_WS), null);
    assert.equal(hosts.fallbackUrl("https://s1.ripple.com:51234"), null);
    assert.equal(hosts.fallbackUrl("https://s.devnet.rippletest.net:51234"), null);
    assert.equal(hosts.fallbackUrl("wss://xrpl.ws"), null);
    assert.equal(hosts.matchingWs(hosts.PRIMARY_HTTP, hosts.PRIMARY_WS), hosts.LABS_WS);
    assert.equal(hosts.matchingWs(hosts.FALLBACK_HTTP, hosts.PRIMARY_WS), hosts.ALTNET_WS);
    assert.equal(
      hosts.matchingWs("https://example.rippletest.net:51234", "wss://example.rippletest.net:51233"),
      "wss://example.rippletest.net:51233"
    );
    assert.deepEqual(hosts.endpointPair(hosts.PRIMARY_HTTP), { http: hosts.LABS_HTTP, ws: hosts.LABS_WS });
    assert.deepEqual(hosts.endpointPair(hosts.FALLBACK_HTTP), { http: hosts.ALTNET_HTTP, ws: hosts.ALTNET_WS });
    assert.equal(hosts.endpointPair("https://s.devnet.rippletest.net:51234"), null);
  });

  it("lets FOUNDRY_XRPL_HTTP, XRPL_HTTP, and XRPL_WS_URL override the labs default", () => {
    assert.equal(hosts.resolveHttp({}), hosts.PRIMARY_HTTP);
    assert.equal(hosts.resolveWs({}), hosts.PRIMARY_WS);
    assert.equal(hosts.resolveHttp({ XRPL_HTTP: hosts.ALTNET_HTTP }), hosts.ALTNET_HTTP);
    assert.equal(
      hosts.resolveHttp({ FOUNDRY_XRPL_HTTP: hosts.ALTNET_HTTP, XRPL_HTTP: "https://example.rippletest.net:51234" }),
      hosts.ALTNET_HTTP
    );
    assert.equal(hosts.resolveHttp({ XRPL_RPC_URL: hosts.ALTNET_HTTP }), hosts.ALTNET_HTTP);
    assert.equal(hosts.resolveWs({ XRPL_WS_URL: hosts.ALTNET_WS }), hosts.ALTNET_WS);
    assert.equal(hosts.resolveHttp({}, "https://example.rippletest.net:51234"), "https://example.rippletest.net:51234");
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

  it("tries the altnet fallback once and does not continue after a network-id refusal", async () => {
    const seen = [];
    const value = await hosts.withFailover(hosts.PRIMARY_HTTP, async (url) => {
      seen.push(url);
      if (url === hosts.PRIMARY_HTTP) throw new Error("fetch failed");
      return "ok";
    });
    assert.equal(value, "ok");
    assert.deepEqual(seen, [hosts.PRIMARY_HTTP, hosts.FALLBACK_HTTP]);

    const refused = [];
    await assert.rejects(
      () => hosts.withFailover(hosts.PRIMARY_HTTP, async (url) => {
        refused.push(url);
        throw Object.assign(new Error("refusing network id 0"), { code: "MAINNET" });
      }),
      (error) => error.code === "MAINNET"
    );
    assert.deepEqual(refused, [hosts.PRIMARY_HTTP]);
  });

  it("keeps the desk defaults locked to the same labs primary and altnet fallback", () => {
    const pub = fs.readFileSync(path.join(__dirname, "../web/lib/xrpl-public.ts"), "utf8");
    const wall = fs.readFileSync(path.join(__dirname, "../web/lib/wall.ts"), "utf8");
    const rules = fs.readFileSync(path.join(__dirname, "../web/lib/x402-rules.js"), "utf8");
    assert.match(pub, /const DEFAULT_XRPL_HTTP = "https:\/\/testnet\.xrpl-labs\.com"/);
    assert.match(pub, /const DEFAULT_XRPL_WS = "wss:\/\/testnet\.xrpl-labs\.com"/);
    assert.match(pub, /const FALLBACK_XRPL_HTTP = "https:\/\/s\.altnet\.rippletest\.net:51234"/);
    assert.match(wall, /const TESTNET_HTTP = "https:\/\/testnet\.xrpl-labs\.com"/);
    assert.match(wall, /const TESTNET_HTTP_FALLBACK = "https:\/\/s\.altnet\.rippletest\.net:51234"/);
    assert.match(rules, /rpc: "https:\/\/testnet\.xrpl-labs\.com"/);
  });
});
