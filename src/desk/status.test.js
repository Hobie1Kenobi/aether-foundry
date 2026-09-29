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
    w5: anchors.WALLETS.W5.address,
    oracleDocumentId: 1,
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
      ledger_entry: { status: "error", error: "entryNotFound" },
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
  assert.equal(body.oracle_id, "7CD1AB908C3A8D2E3C426E0D3083F4DD9A8A3A753AA60EB73682AA11A06DFA4E");
  assert.equal(body.oracle.quote_xrp_per_aeth, "0.01022008");
  assert.equal(body.mpt_issuance_id, "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED");
  assert.equal(body.domain_id, "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4");
  assert.equal(body.facilitator.mode, "self-verify");
  assert.equal(body.facilitator.host, null);
  assert.equal(body.facilitator.network, "xrpl:1");
  assert.equal(body.facilitator.networkId, 1);
  assert.equal(body.facilitator.settles, false);
  assert.equal(body.facilitator.remoteVerify, false);
  assert.equal(body.devnet.network, "XRPL Devnet");
  assert.equal(body.devnet.networkId, 2);
  assert.equal(body.devnet.accounts.D0, null);
  assert.equal(body.devnet.f9.vault_id, null);
  assert.equal(body.devnet.f10.issuance_id, null);
  assert.equal(body.x402_foreign_hits, 0);
  assert.equal(body.error, undefined);
  assert.deepEqual(body.laws, ["altnets-only", "desk-read-only", "seeds-never-in-git"]);
  const pnl = metrics.parsePnlCounts(fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8"));
  const parsed = status.parsePnlCounts(fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8"));
  assert.deepEqual(parsed, pnl);
  assert.equal(body.x402_hits, pnl.counts.x402_hits);
  assert.equal(body.x402_outbound_hits, pnl.counts.x402_outbound_hits);
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

test("status lab files are pinned to the main commit sha", async () => {
  const sha = "a".repeat(40);
  assert.throws(() => status.gitUrlsAtSha("main"), /refusing git ref/);
  const urls = status.gitUrlsAtSha(sha);
  assert.equal(urls.metrics.includes("/main/"), false);
  assert.equal(urls.metrics, `https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/${sha}/lab/metrics.json`);
  assert.equal(urls.ledger, `https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/${sha}/lab/ledger-log.jsonl`);
  const metricsText = fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8");
  const ledgerText = fs.readFileSync(path.join(ROOT, "lab", "ledger-log.jsonl"), "utf8");
  const director = fs.readFileSync(path.join(ROOT, "lab", "director-state.json"), "utf8");
  const pnl = fs.readFileSync(path.join(ROOT, "market", "pnl.md"), "utf8");
  const live = JSON.parse(metricsText).last_heartbeat.hash;
  let apiCalls = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    assert.equal(target.includes("/aether-foundry/main/"), false);
    if (target === "https://api.github.com/repos/Hobie1Kenobi/aether-foundry/commits/main") {
      apiCalls += 1;
      return textResponse(JSON.stringify({ sha }));
    }
    const pages = {
      [urls.metrics]: metricsText,
      [urls.pnl]: pnl,
      [urls.director]: director,
      [urls.ledger]: ledgerText,
    };
    if (pages[target] == null) return textResponse("missing", 404);
    return textResponse(pages[target]);
  };
  const resolved = await status.mainGitFiles(fetchImpl, { cacheMs: 60000, now: 1 });
  assert.equal(apiCalls, 1);
  assert.deepEqual(resolved, urls);
  const cached = await status.mainGitFiles(fetchImpl, { cacheMs: 60000, now: 1000 });
  assert.equal(apiCalls, 1);
  assert.equal(cached.metrics, urls.metrics);
  const body = await status.collectStatus(baseOpts(fetchImpl, resolved));
  assert.equal(body.last_heartbeat.hash, live);
  assert.equal(body.last_heartbeat.hash, "2B298A910CB3966EF6E60AD3C3ABD167D43ED382F34E2D5963292304C0203C01");
  assert.equal(body.director_updated_at, JSON.parse(director).updated_at);
  assert.equal(body.devnet.accounts.D0, null);
  await assert.rejects(
    () => status.mainGitFiles(async () => textResponse("nope", 403), { cacheMs: 0, now: 2 }),
    /git ref HTTP 403/
  );
});

test("desk route and toml link status without a signer", () => {
  const route = fs.readFileSync(path.join(ROOT, "web", "app", "api", "status", "route.ts"), "utf8");
  const loader = fs.readFileSync(path.join(ROOT, "web", "lib", "load-desk-status.ts"), "utf8");
  assert.match(route, /loadDeskStatus/);
  assert.match(loader, /collectStatus/);
  assert.match(loader, /mainGitFiles/);
  assert.match(loader, /ORACLE/);
  assert.match(loader, /oracleDocumentId/);
  assert.match(loader, /XRPL_FACILITATOR_URL/);
  assert.doesNotMatch(loader, /process\.env,/);
  assert.doesNotMatch(route + loader, /OracleSet/);
  assert.doesNotMatch(route + loader, /raw\.githubusercontent\.com\/Hobie1Kenobi\/aether-foundry\/main/);
  assert.doesNotMatch(route + loader, /Wallet|fromSeed|sign\(/);
  assert.doesNotMatch(route + loader, /_SEED/);
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

test("status publishes the ledger oracle and falls back to lab metrics", async () => {
  const pages = happyPages();
  const oracleIndex = "AB".repeat(32);
  pages.xrpl.ledger_entry = {
    status: "success",
    validated: true,
    ledger_index: 21111111,
    index: oracleIndex,
    node: {
      LedgerEntryType: "Oracle",
      Owner: anchors.WALLETS.W5.address,
      OracleDocumentID: 1,
      LastUpdateTime: 1759099800,
      PriceDataSeries: [
        {
          PriceData: {
            BaseAsset: "AETH",
            QuoteAsset: "XRP",
            AssetPrice: "f5fa8",
            Scale: 8,
          },
        },
      ],
    },
  };
  const priced = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(priced.error, undefined);
  assert.equal(priced.oracle_id, oracleIndex);
  assert.equal(priced.oracle.quote_xrp_per_aeth, "0.01007528");
  assert.equal(priced.oracle.asset_price, "1007528");
  assert.equal(priced.oracle.scale, 8);
  assert.equal(priced.oracle.last_update_time, 1759099800);
  assert.equal(priced.oracle.account, anchors.WALLETS.W5.address);
  const filed = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"));
  filed.oracle_id = "EF".repeat(32);
  filed.last_oracle = {
    hash: "EF".repeat(32),
    oracle_id: "EF".repeat(32),
    ledger_index: 21112222,
    last_update_time: 1759099800,
    quote_xrp_per_aeth: "0.02",
    ts: "2026-09-28T23:30:00.000Z",
  };
  const fallbackPages = happyPages();
  fallbackPages.git[GIT.metrics] = { text: JSON.stringify(filed) };
  const fallback = await status.collectStatus(baseOpts(router(fallbackPages)));
  assert.equal(fallback.oracle_id, "EF".repeat(32));
  assert.equal(fallback.oracle.quote_xrp_per_aeth, "0.02");
  const chainFetch = async (url, init) => {
    const target = String(url);
    if (init && init.method === "GET" && target === "https://metrics.example/lab.json") {
      return textResponse(JSON.stringify(filed));
    }
    return router(pages)(url, init);
  };
  const won = await status.collectStatus(baseOpts(chainFetch, {
    metrics: "https://metrics.example/lab.json",
    pnl: GIT.pnl,
    director: GIT.director,
    ledger: GIT.ledger,
  }));
  assert.equal(won.oracle_id, oracleIndex);
  assert.equal(won.oracle.quote_xrp_per_aeth, "0.01007528");
  assert.equal(won.mpt_issuance_id, "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED");
  assert.doesNotMatch(JSON.stringify(priced), /sEd|"seed"|"secret"|"private_key"/);
});

test("status publishes mpt_issuance_id only from lab metrics", async () => {
  const pages = happyPages();
  const published = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(published.mpt_issuance_id, "0141DD60A4C3F993CB1B29762088E9F1DB80AC36119504ED");
  const emptyPages = happyPages();
  const emptyDoc = JSON.parse(emptyPages.git[GIT.metrics].text);
  emptyDoc.mpt_issuance_id = null;
  emptyPages.git[GIT.metrics] = { text: JSON.stringify(emptyDoc) };
  const blank = await status.collectStatus(baseOpts(router(emptyPages)));
  assert.equal(blank.mpt_issuance_id, null);
  const filed = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"));
  const issuance = `00000001${"AB".repeat(20)}`;
  filed.mpt_issuance_id = issuance.toLowerCase();
  pages.git[GIT.metrics] = { text: JSON.stringify(filed) };
  const body = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(body.error, undefined);
  assert.equal(body.mpt_issuance_id, issuance);
  assert.equal(body.desk, "read-only");
  assert.doesNotMatch(JSON.stringify(body), /sEd|"seed"|"secret"|"private_key"/);
  filed.mpt_issuance_id = "EF".repeat(32);
  const badPages = happyPages();
  badPages.git[GIT.metrics] = { text: JSON.stringify(filed) };
  const bad = await status.collectStatus(baseOpts(router(badPages)));
  assert.equal(bad.mpt_issuance_id, null);
  assert.match(bad.error, /mpt_issuance_id is not 48 hex/);
});

test("status publishes domain_id only from lab metrics", async () => {
  const pages = happyPages();
  const published = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(published.domain_id, "6AF56BC1CEC72198156F650C6B425AA52905218CC889BF910BA495470352DCD4");
  const filed = JSON.parse(fs.readFileSync(path.join(ROOT, "lab", "metrics.json"), "utf8"));
  const domainId = "AB".repeat(32);
  filed.domain_id = domainId.toLowerCase();
  pages.git[GIT.metrics] = { text: JSON.stringify(filed) };
  const body = await status.collectStatus(baseOpts(router(pages)));
  assert.equal(body.error, undefined);
  assert.equal(body.domain_id, domainId);
  assert.equal(body.desk, "read-only");
  assert.doesNotMatch(JSON.stringify(body), /sEd|"seed"|"secret"|"private_key"/);
  filed.domain_id = "ABCD";
  const badPages = happyPages();
  badPages.git[GIT.metrics] = { text: JSON.stringify(filed) };
  const bad = await status.collectStatus(baseOpts(router(badPages)));
  assert.equal(bad.domain_id, null);
  assert.match(bad.error, /domain_id is not 64 hex/);
});

test("status facilitator is the testnet host or a refusal, and foreign hits stay outside WALLETS", async () => {
  const pages = happyPages();
  const dual = await status.collectStatus(Object.assign(baseOpts(router(pages)), {
    env: { XRPL_FACILITATOR_URL: "https://xrpl-facilitator-testnet.t54.ai", XRPL_NETWORK: "xrpl:1" },
  }));
  assert.equal(dual.facilitator.mode, "dual");
  assert.equal(dual.facilitator.host, "xrpl-facilitator-testnet.t54.ai");
  assert.equal(dual.facilitator.networkId, 1);
  assert.equal(dual.facilitator.settles, false);
  assert.equal(dual.facilitator.remoteVerify, true);
  assert.equal(dual.facilitator.verifyOnly, true);
  assert.equal(dual.network, "xrpl:1");

  const mainnet = await status.collectStatus(Object.assign(baseOpts(router(happyPages())), {
    env: { XRPL_FACILITATOR_URL: "https://xrpl-facilitator-mainnet.t54.ai" },
  }));
  assert.equal(mainnet.facilitator.mode, "refused");
  assert.equal(mainnet.facilitator.host, null);
  assert.match(mainnet.error, /xrpl-facilitator-testnet\.t54\.ai/);
  assert.equal(mainnet.network, "xrpl:1");

  const zero = await status.collectStatus(Object.assign(baseOpts(router(happyPages())), {
    env: {
      XRPL_FACILITATOR_URL: "https://xrpl-facilitator-testnet.t54.ai",
      XRPL_NETWORK: "xrpl:0",
    },
  }));
  assert.equal(zero.facilitator.mode, "refused");
  assert.match(zero.error, /xrpl:1/);

  const foreign = "rForeignPayer1111111111111111111";
  const logged = happyPages();
  logged.git[GIT.ledger] = {
    text: [
      JSON.stringify({ action: "x402_hit", sku: "reserve-audit", hash: "A".repeat(64), payer: foreign, network: "xrpl:1" }),
      JSON.stringify({ action: "x402_hit", sku: "reserve-audit", hash: "B".repeat(64), payer: anchors.WALLETS.W3.address, network: "xrpl:1" }),
    ].join("\n"),
  };
  const hits = await status.collectStatus(baseOpts(router(logged)));
  assert.equal(hits.x402_foreign_hits, 1);
  assert.equal(hits.facilitator.mode, "self-verify");
});

test("devnet frontier snapshot stays off the testnet counters", async () => {
  const wallets = fs.readFileSync(path.join(ROOT, "corp/wallets.md"), "utf8");
  const ledger = fs.readFileSync(path.join(ROOT, "lab/frontier/devnet-ledger.jsonl"), "utf8");
  const git = Object.assign({}, GIT, {
    wallets: "https://example.test/wallets.md",
    devnetLedger: "https://example.test/devnet-ledger.jsonl",
  });
  const pages = happyPages();
  pages.git[git.wallets] = { text: wallets };
  pages.git[git.devnetLedger] = { text: ledger + "\n" + JSON.stringify({
    network: "xrpl:1",
    network_id: 1,
    action: "devnet_sponsor",
    step: "create",
    hash: "D".repeat(64),
    sponsee: anchors.WALLETS.W0.address,
  }) };
  const plain = await status.collectStatus(baseOpts(router(happyPages())));
  const body = await status.collectStatus(baseOpts(router(pages), git));
  assert.equal(body.network, "xrpl:1");
  assert.equal(body.ledger_index, plain.ledger_index);
  assert.equal(body.x402_hits, plain.x402_hits);
  assert.equal(body.grants_paid, plain.grants_paid);
  assert.equal(body.mpt_issuance_id, plain.mpt_issuance_id);
  assert.equal(body.domain_id, plain.domain_id);
  assert.equal(body.oracle_id, plain.oracle_id);
  assert.equal(body.devnet.network, "XRPL Devnet");
  assert.equal(body.devnet.networkId, 2);
  assert.equal(body.devnet.accounts.D0, "rEizYPsEi1GMqiV5igtYVGzxsvwEENTFS1");
  assert.equal(body.devnet.accounts.D2, "rGK3QfP57LzBzS8KcYHmpBa8NvUHxoxAgV");
  assert.equal(body.devnet.f8.create_hash, "002F5E3D285FADCEED03D8CFA602C73363539BFCB1190D30E56BA4F4E3BB8BE4");
  assert.equal(body.devnet.f9.vault_id, "B5B7DD0567486B7D93CDE961B86B4B4107FE674E7F4EAE7CFF09BA13D8189992");
  assert.equal(body.devnet.f10.issuance_id, "0056E2EDA3062D0A34565850A19B583AE92C7D07C8BECAF6");
  assert.notEqual(body.devnet.f10.issuance_id, body.mpt_issuance_id);
  assert.equal(JSON.stringify(body.devnet).includes("D".repeat(64)), false);
  assert.equal(body.error, undefined);
  assert.doesNotMatch(JSON.stringify(body), /sEd|_SEED|ELGAMAL/);

  const missing = Object.assign({}, GIT, {
    wallets: "https://example.test/missing-wallets",
    devnetLedger: "https://example.test/missing-ledger",
  });
  const empty = await status.collectStatus(baseOpts(router(happyPages()), missing));
  assert.equal(empty.devnet.accounts.D0, null);
  assert.equal(empty.devnet.f8.create_hash, null);
  assert.equal(empty.mpt_issuance_id, plain.mpt_issuance_id);
  assert.equal(empty.error, undefined);
});
