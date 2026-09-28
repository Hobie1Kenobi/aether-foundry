"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const anchors = require("../director/anchors");
const metrics = require("../runtime/metrics");
const status = require("../../web/lib/status-body");

const ROOT = anchors.repoRoot();
const OFFER = "CEAC38D14EBB2B544E59D78084ECAE1D52486BA29C53D248717CD42DB159654F";
const GIT = {
  metrics: "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/lab/metrics.json",
  pnl: "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/market/pnl.md",
  director: "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/lab/director-state.json",
  ledger: "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/lab/ledger-log.jsonl",
};

function jsonResponse(result, statusCode = 200) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json: async () => ({ result }),
    text: async () => JSON.stringify(result),
  };
}

function textResponse(text, statusCode = 200) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function baseOpts(fetchImpl, gitText) {
  return {
    fetch: fetchImpl,
    xrplHttp: "https://s.altnet.rippletest.net:51234",
    xahauHttp: "https://xahau-test.net",
    w2: anchors.WALLETS.W2.address,
    ammAccount: anchors.AMM,
    w7: anchors.WALLETS.W7.address,
    aethCurrency: anchors.AETH_HEX,
    aethIssuer: anchors.WALLETS.W0.address,
    packHookHash: anchors.PACK_HOOK_HASH,
    walkInDrops: "10000000",
    git: gitText || GIT,
  };
}

function router(pages) {
  return async (url, init) => {
    const target = String(url);
    if (init && init.method === "GET") {
      const page = pages.git[target];
      if (!page) return textResponse("missing", 404);
      return textResponse(page.text, page.status || 200);
    }
    const body = JSON.parse(init.body);
    const method = body.method;
    const host = new URL(target).hostname;
    const table = host.includes("xahau") ? pages.xahau : pages.xrpl;
    const result = table[method];
    if (!result) return jsonResponse({ status: "error", error: "unknown" }, 200);
    return jsonResponse(result);
  };
}

function happyPages() {
  const pnl = fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8");
  const metricsText = fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8");
  const director = fs.readFileSync(path.join(ROOT, "lab", "director-state.json"), "utf8");
  return {
    git: {
      [GIT.metrics]: { text: metricsText },
      [GIT.pnl]: { text: pnl },
      [GIT.director]: { text: director },
      [GIT.ledger]: { text: "" },
    },
    xrpl: {
      server_info: { status: "success", info: { network_id: 1 } },
      server_state: { status: "success", state: { validated_ledger: { seq: 21111111 } } },
      account_objects: {
        status: "success",
        validated: true,
        ledger_index: 21111111,
        account_objects: [
          {
            index: OFFER,
            NFTokenID: "B".repeat(64),
            Flags: 1,
            Amount: "10000000",
            Owner: anchors.WALLETS.W2.address,
          },
        ],
      },
      amm_info: {
        status: "success",
        validated: true,
        ledger_index: 21111111,
        amm: {
          account: anchors.AMM,
          amount: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "1000" },
          amount2: "50000000",
        },
      },
      feature: {
        status: "success",
        features: {
          "9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377": {
            name: "BatchV1_1",
            enabled: false,
            supported: true,
          },
          "14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944": {
            name: "fixBatchV1_2",
            enabled: false,
            supported: true,
          },
          "955DF3FA5891195A9DAEFA1DDC6BB244B545DDE1BAA84CBB25D5F12A8DA68A0C": {
            name: "TicketBatch",
            enabled: true,
            supported: true,
          },
        },
      },
    },
    xahau: {
      server_info: { status: "success", info: { network_id: 21338 } },
      account_objects: {
        status: "success",
        account_objects: [
          {
            LedgerEntryType: "Hook",
            index: "C".repeat(64),
            Hooks: [{ Hook: { HookHash: anchors.PACK_HOOK_HASH } }],
          },
        ],
      },
    },
  };
}

test("status JSON is seedless and uses proven ledger data", async () => {
  const body = await status.collectStatus(baseOpts(router(happyPages())));
  assert.equal(body.network, "xrpl:1");
  assert.equal(body.desk, "read-only");
  assert.equal(body.ledger_index, 21111111);
  assert.equal(body.walk_in.status, "open");
  assert.equal(body.walk_in.offer_id, OFFER);
  assert.equal(body.walk_in.amount_drops, "10000000");
  assert.equal(body.amm.account, anchors.AMM);
  assert.equal(body.amm.spot_xrp_per_aeth, "0.05");
  assert.equal(body.batch_atomic_enabled, false);
  assert.equal(body.w7_hook_matches_pack, true);
  assert.equal(body.last_heartbeat.hash, "2B298A910CB3966EF6E60AD3C3ABD167D43ED382F34E2D5963292304C0203C01");
  assert.equal(body.error, undefined);
  assert.deepEqual(body.laws, ["altnets-only", "desk-read-only", "seeds-never-in-git"]);
  const pnl = metrics.parsePnlCounts(fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8"));
  const parsed = status.parsePnlCounts(fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8"));
  assert.deepEqual(parsed, pnl);
  assert.equal(body.x402_hits, pnl.counts.x402_hits);
  assert.equal(body.grants_paid, pnl.counts.grants_paid);
  assert.equal(body.inbound_counterparties, pnl.counts.inbound_counterparties);
  assert.equal(body.director_updated_at, JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "director-state.json"), "utf8")).updated_at);
  assert.doesNotMatch(JSON.stringify(body), /sEd|"seed"|"secret"|"private_key"/);
});

test("unproven or mainnet RPC does not invent a ledger index", async () => {
  const pages = happyPages();
  pages.xrpl.server_info = { status: "success", info: { network_id: 0 } };
  const mainnet = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(mainnet.network, null);
  assert.equal(mainnet.ledger_index, null);
  assert.match(mainnet.error, /network id 0/);
  assert.equal(mainnet.walk_in.status, "error");

  const missing = happyPages();
  delete missing.xrpl.server_info.info.network_id;
  const unproven = await status.collectStatus(baseOpts(router(missing)));
  assert.equal(unproven.ledger_index, null);
  assert.match(unproven.error, /did not prove/);

  const banned = await status.collectStatus(Object.assign(baseOpts(async () => {
    throw new Error("should not fetch");
  }), { xrplHttp: "https://s1.ripple.com:51234" }));
  assert.equal(banned.ledger_index, null);
  assert.match(banned.error, /ripple\.com/);

  const xahauMain = happyPages();
  xahauMain.xahau.server_info = { status: "success", info: { network_id: 21337 } };
  const hook = await status.collectStatus(baseOpts(router(xahauMain)));
  assert.equal(hook.network, "xrpl:1");
  assert.equal(hook.w7_hook_matches_pack, null);
  assert.match(hook.error, /21337/);
});

test("a failed count parse is null and a bad hash is not published", async () => {
  const pages = happyPages();
  pages.git[GIT.metrics] = { text: "{", status: 200 };
  pages.git[GIT.pnl] = { text: "# no table\n", status: 200 };
  const broken = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(broken.x402_hits, null);
  assert.equal(broken.grants_paid, null);
  assert.equal(broken.inbound_counterparties, null);
  assert.match(broken.error, /metrics\.json is not JSON/);

  const logged = happyPages();
  logged.git[GIT.ledger] = {
    text: `${JSON.stringify({ action: "heartbeat", hash: "not-a-hash", ledger_index: 1 })}\n${JSON.stringify({
      action: "heartbeat",
      event: "heartbeat",
      hash: "CD".repeat(32),
      ledger_index: 21112222,
      ts: "2026-09-28T21:00:00.000Z",
    })}\n`,
  };
  const beat = await status.collectStatus(baseOpts(router(logged)));
  assert.equal(beat.last_heartbeat.hash, "CD".repeat(32));
  assert.equal(beat.last_heartbeat.ledger_index, 21112222);
  assert.doesNotMatch(JSON.stringify(beat), /not-a-hash/);

  const probe = ["sEd", "V".repeat(24)].join("");
  const dirty = happyPages();
  dirty.git[GIT.metrics] = {
    text: JSON.stringify({
      x402_hits: 0,
      grants_paid: 0,
      inbound_counterparties: 0,
      note: probe,
    }),
  };
  const refused = await status.collectStatus(baseOpts(router(dirty)));
  assert.equal(refused.x402_hits, null);
  assert.equal(refused.grants_paid, null);
  assert.equal(refused.ledger_index, 21111111);
  assert.match(refused.error, /metrics\.json refused/);
  assert.doesNotMatch(JSON.stringify(refused), new RegExp(probe));
});

test("desk route and toml link status without a signer", () => {
  const route = fs.readFileSync(path.join(ROOT, "web", "app", "api", "status", "route.ts"), "utf8");
  assert.match(route, /collectStatus/);
  assert.doesNotMatch(route, /Wallet|fromSeed|sign\(/);
  assert.doesNotMatch(route, /_SEED/);
  const home = fs.readFileSync(path.join(ROOT, "web", "components", "DeskCards.tsx"), "utf8");
  assert.match(home, /href="\/api\/status"/);
  for (const file of ["public/xrp-ledger.toml", "web/public/.well-known/xrp-ledger.toml"]) {
    const toml = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(toml, /https:\/\/aether-foundry-desk\.vercel\.app\/api\/status/);
  }
  const sold = status.readBatch({ features: {} });
  assert.equal(sold.ok, false);
  assert.equal(status.spotXrpPerAeth("50000000", "1000"), "0.05");
});
