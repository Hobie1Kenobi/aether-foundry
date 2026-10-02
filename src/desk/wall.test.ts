import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import programsJson from "../../lab/wall/programs.json" with { type: "json" };
import sourcesJson from "../../lab/wall/sources.json" with { type: "json" };
import {
  HEADLINE_CAP,
  HEADLINE_TIMEOUT_MS,
  RIPPLE_HEADLINE_FEED,
  fetchRippleHeadlines,
  parseRippleHeadlines,
} from "../../web/lib/ripple-headlines.ts";
import {
  MERGED_HEADLINE_CAP,
  X_ACCOUNT_ALLOWLIST,
  X_HEADLINE_CACHE_MS,
  X_HEADLINE_MAX,
  X_HEADLINE_QUERY,
  X_HEADLINE_TIMEOUT_MS,
  X_SEARCH_ENDPOINT,
  fetchXHeadlines,
  mergePressHeadlines,
  parseXHeadlines,
  readXBearerToken,
  xRecentSearchUrl,
} from "../../web/lib/x-headlines.ts";
import { X_POST_LABEL } from "../../web/lib/wall-schema.ts";
import {
  CLOCK,
  WALL_TICKER_LOOP_S,
  filterPrograms,
  validateProgram,
  validateSources,
  type Program,
} from "../../web/lib/wall-schema.ts";
import {
  applyFoundryTwins,
  buildWall,
  dropsToXrp,
  mainnetAccountTargets,
  renderRss,
  resolveAmendmentDots,
} from "../../web/lib/wall.ts";

const sources = validateSources(sourcesJson);

function program(over: Partial<Program> & Pick<Program, "id" | "stage">): Program {
  return {
    ts: "2026-09-30T00:00:00Z",
    actor: "Fixture",
    claim: "A cited row with a named rail.",
    networks: ["other"],
    class: "protocol",
    depends_on: [],
    onchain: { kind: "none" },
    sources: ["desk-status"],
    last_verified: "2026-09-30",
    ...over,
  };
}

test("schema rejects mainnet-live without an explorer url", () => {
  for (const row of programsJson as unknown[]) validateProgram(row, sources);
  assert.ok((programsJson as unknown[]).length >= 21);
  assert.ok((programsJson as unknown[]).length <= 24);
  const byId = Object.fromEntries(
    (programsJson as { id: string; onchain: { kind: string; id?: string; url?: string } }[]).map((row) => [
      row.id,
      row,
    ])
  );
  assert.equal(byId["sg-forge-eur"].onchain.id, "rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL");
  assert.equal(byId["rlusd-issuer"].onchain.id, "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De");
  assert.equal(byId["circle-usdc"].onchain.id, "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE");
  assert.equal(byId["ondo-ousg"].onchain.id, "rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p");
  assert.equal(byId["quantoz-eurq-usdq"].onchain.id, "rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs");
  assert.equal(byId["schuman-europ"].onchain.id, "rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK");
  for (const id of ["sg-forge-eur", "rlusd-issuer", "circle-usdc", "ondo-ousg", "quantoz-eurq-usdq", "schuman-europ"]) {
    assert.equal(byId[id].onchain.kind, "account");
    assert.match(byId[id].onchain.url || "", /^https:\/\/livenet\.xrpl\.org\/accounts\/r/);
  }
  for (const id of ["guggenheim-dcp", "archax-abrdn-mmf", "ctrl-alt-dld", "openeden-tbill"]) {
    assert.equal(byId[id].onchain.kind, "none");
    assert.equal(byId[id].onchain.id, undefined);
  }
  const liveRows = (programsJson as { stage: string; onchain: { kind: string; url?: string } }[]).filter(
    (row) => row.stage === "mainnet-live"
  );
  assert.ok(liveRows.length >= 1);
  for (const row of liveRows) {
    assert.notEqual(row.onchain.kind, "none");
    assert.match(row.onchain.url || "", /^https:\/\//);
  }
  const wire = JSON.stringify(programsJson);
  assert.doesNotMatch(wire, /xrpacademy|tokensonar|300 banks/i);
  const live = program({
    id: "bad-live",
    stage: "mainnet-live",
    networks: ["xrpl:0"],
    onchain: { kind: "none" },
  });
  assert.throws(() => validateProgram(live, sources), /mainnet-live|onchain\.url/);
  assert.throws(
    () =>
      validateProgram(
        {
          ...live,
          onchain: { kind: "account", id: "rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL" },
        },
        sources
      ),
    /mainnet-live|onchain\.url/
  );
});

test("rss is well-formed and has one item per non-rumor program", () => {
  const rows = [
    program({ id: "kept-press", stage: "press" }),
    program({ id: "dropped-rumor", stage: "rumor" }),
    program({ id: "kept-devnet", stage: "devnet", networks: ["xrpl:devnet"] }),
  ];
  const xml = renderRss(rows, "2026-09-30T02:00:00Z");
  assert.match(xml, /<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<rss version="2.0">/);
  assert.equal((xml.match(/<channel>/g) || []).length, 1);
  assert.equal((xml.match(/<\/channel>/g) || []).length, 1);
  assert.equal((xml.match(/<item>/g) || []).length, 2);
  assert.equal((xml.match(/<\/item>/g) || []).length, 2);
  assert.match(xml, /<guid isPermaLink="false">kept-press<\/guid>/);
  assert.doesNotMatch(xml, /dropped-rumor/);
  assert.match(xml, /<title>Aether Foundry — Wall of Change<\/title>/);
  assert.match(xml, /<link>https:\/\/aether-foundry-desk\.vercel\.app\/wall<\/link>/);
});

test("serialized wall JSON does not match seed, secret, or sEd", async () => {
  const payload = await buildWall({
    xBearerToken: null,
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    fetch: async () => {
      throw new Error("rpc down");
    },
  });
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /seed|secret|sEd/);
  const xml = renderRss(payload.programs, payload.generated_at);
  const rumors = payload.programs.filter((row) => row.stage === "rumor").length;
  assert.equal((xml.match(/<item>/g) || []).length, payload.programs.length - rumors);
  assert.equal(payload.amendments.BatchV1_1.mainnet, "unknown");
});

test("amendment merge on RPC failure stays unknown or last file", () => {
  const dots = resolveAmendmentDots({
    names: ["BatchV1_1", "TokenEscrow"],
    testnetMode: "failed",
    testnetFile: {
      amendments: [{ name: "BatchV1_1", enabled: false, majority: null }],
    },
    testnetProbe: {
      amendments: [
        { name: "BatchV1_1", enabled: true, majority: null },
        { name: "TokenEscrow", enabled: true, majority: null },
      ],
    },
    devnetMode: "failed",
    devnetFile: null,
    devnetProbe: {
      amendments: [{ name: "BatchV1_1", enabled: true, majority: null }],
    },
  });
  assert.equal(dots.BatchV1_1.testnet, "off");
  assert.equal(dots.TokenEscrow.testnet, "unknown");
  assert.equal(dots.BatchV1_1.devnet, "unknown");
  assert.equal(dots.BatchV1_1.mainnet, "unknown");
  assert.notEqual(dots.TokenEscrow.testnet, "on");
  assert.notEqual(dots.BatchV1_1.devnet, "on");
});

test("foundry twin rows take live ids and drop a stale file hash", () => {
  const stale = program({
    id: "foundry-heartbeat",
    stage: "testnet",
    networks: ["xrpl:1"],
    class: "foundry-twin",
    foundry_twin: "heartbeat",
    onchain: {
      kind: "tx",
      id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      url: "https://testnet.xrpl.org/transactions/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  const blocked = applyFoundryTwins([stale], {
    last_heartbeat: { hash: "not-a-hash", ts: "2026-09-30T00:00:00Z" },
  });
  assert.equal(blocked[0].onchain.kind, "none");
  assert.equal(blocked[0].onchain.id, undefined);
  const live = "CE97193B6EA982225DD7EDDF09C8A36C5EA7DE35E20F8344B04BC972093BC451";
  const attached = applyFoundryTwins([stale], {
    last_heartbeat: { hash: live, ts: "2026-09-30T03:00:00Z" },
  });
  assert.equal(attached[0].onchain.id, live);
  assert.equal(attached[0].onchain.url, `https://testnet.xrpl.org/transactions/${live}`);
  assert.equal(attached[0].ts, "2026-09-30T03:00:00Z");
});

test("FOUNDRY TWIN filter returns only rows with foundry_twin", async () => {
  const payload = await buildWall({
    xBearerToken: null,
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    fetch: async () => {
      throw new Error("rpc down");
    },
  });
  const rows = filterPrograms(payload.programs, "foundry-twin");
  assert.ok(rows.length > 0);
  assert.ok(rows.length < payload.programs.length);
  assert.ok(rows.every((row) => Boolean(row.foundry_twin)));
  assert.equal(rows.some((row) => row.id === "odl-sbi-tranglo"), false);
});

test("mainnet merge paints on, off, and voting, and a failed probe stays unknown", () => {
  const painted = resolveAmendmentDots({
    names: ["BatchV1_1", "TokenEscrow", "SingleAssetVault", "Credentials"],
    testnetMode: "failed",
    testnetFile: null,
    testnetProbe: null,
    devnetMode: "failed",
    devnetFile: null,
    devnetProbe: null,
    mainnetMode: "probe",
    mainnetProbe: {
      amendments: [
        { name: "BatchV1_1", enabled: false, majority: 843662762 },
        { name: "TokenEscrow", enabled: true, majority: null },
        { name: "SingleAssetVault", enabled: false, majority: null },
      ],
    },
  });
  assert.equal(painted.BatchV1_1.mainnet, "voting");
  assert.equal(painted.TokenEscrow.mainnet, "on");
  assert.equal(painted.SingleAssetVault.mainnet, "off");
  assert.equal(painted.Credentials.mainnet, "unknown");
  assert.notEqual(painted.BatchV1_1.mainnet, "on");
  assert.notEqual(painted.SingleAssetVault.mainnet, "on");

  const ignored = resolveAmendmentDots({
    names: ["TokenEscrow"],
    testnetMode: "failed",
    testnetFile: null,
    testnetProbe: null,
    devnetMode: "failed",
    devnetFile: null,
    devnetProbe: null,
    mainnetMode: "failed",
    mainnetProbe: {
      amendments: [{ name: "TokenEscrow", enabled: true, majority: null }],
    },
  });
  assert.equal(ignored.TokenEscrow.mainnet, "unknown");
  assert.notEqual(ignored.TokenEscrow.mainnet, "on");
});

function rpcResponse(result: unknown): Response {
  return {
    ok: true,
    json: async () => ({ result }),
  } as Response;
}

test("wall merge reads mainnet feature flags and refuses a bad network id", async () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");
  const fresh = {
    probed_at: "2026-09-30T10:00:00.000Z",
    build_version: "3.4.1",
    amendments: [] as { name: string; enabled: boolean; majority: null }[],
  };
  const calls: { host: string; method: string }[] = [];
  const payload = await buildWall({
    xBearerToken: null,
    now,
    status: {},
    programs: [],
    sources: {},
    testnetFile: fresh,
    devnetFile: fresh,
    lastSeen: { amendments: {} },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as { method?: string };
      const method = String(body.method);
      calls.push({ host: url.hostname, method });
      assert.ok(method === "server_info" || method === "feature");
      if (url.hostname === "xrplcluster.com" && method === "server_info") {
        return rpcResponse({
          info: { network_id: 0, build_version: "3.4.1", validated_ledger: { seq: 107328861 } },
        });
      }
      if (url.hostname === "xrplcluster.com" && method === "feature") {
        return rpcResponse({
          features: {
            AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA: {
              name: "BatchV1_1",
              enabled: false,
              majority: 843662762,
            },
            BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB: {
              name: "TokenEscrow",
              enabled: true,
              majority: null,
            },
            CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC: {
              name: "SingleAssetVault",
              enabled: false,
              majority: null,
            },
            DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD: {
              name: "DID",
              enabled: "true",
            },
          },
        });
      }
      if (url.hostname === "s.altnet.rippletest.net") {
        return rpcResponse({
          info: { network_id: 1, build_version: "3.4.1", validated_ledger: { seq: 9 } },
        });
      }
      throw new Error(`unexpected ${method} ${url.hostname}`);
    },
  });
  assert.equal(payload.amendments.BatchV1_1.mainnet, "voting");
  assert.equal(payload.amendments.TokenEscrow.mainnet, "on");
  assert.equal(payload.amendments.SingleAssetVault.mainnet, "off");
  assert.equal(payload.amendments.DID.mainnet, "unknown");
  assert.equal(payload.amendments.Credentials.mainnet, "unknown");
  assert.equal(payload.wire_status, "ok");
  assert.ok(calls.some((call) => call.host === "xrplcluster.com" && call.method === "feature"));
  assert.ok(calls.every((call) => call.method === "server_info" || call.method === "feature"));
  assert.equal(calls.some((call) => call.host === "s1.ripple.com"), false);

  const refused = await buildWall({
    xBearerToken: null,
    now,
    status: {},
    programs: [],
    sources: {},
    testnetFile: fresh,
    devnetFile: fresh,
    lastSeen: { amendments: {} },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (url.hostname === "xrplcluster.com" && body.method === "server_info") {
        return rpcResponse({
          info: { network_id: 1, build_version: "3.4.1", validated_ledger: { seq: 1 } },
        });
      }
      if (url.hostname === "xrplcluster.com" && body.method === "feature") {
        return rpcResponse({
          features: {
            EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE: {
              name: "TokenEscrow",
              enabled: true,
            },
          },
        });
      }
      return rpcResponse({
        info: { network_id: 1, build_version: "3.4.1", validated_ledger: { seq: 9 } },
      });
    },
  });
  for (const row of CLOCK) {
    assert.equal(refused.amendments[row.name].mainnet, "unknown");
    assert.notEqual(refused.amendments[row.name].mainnet, "on");
  }
  assert.match(refused.probe_notes.join(" "), /Mainnet feature probe failed/);
  assert.equal(refused.wire_status, "degraded");
});

test("signer allowlist still refuses the wall mainnet host", () => {
  const allowlist = JSON.parse(readFileSync(new URL("../../src/runtime/allowlist.json", import.meta.url), "utf8")) as {
    refused_hosts: string[];
    refused_network_ids: number[];
  };
  assert.ok(allowlist.refused_hosts.includes("xrplcluster.com"));
  assert.ok(allowlist.refused_network_ids.includes(0));
});

function itemXml(title: string, path: string, when: string, host = "https://cointelegraph.com"): string {
  const url = `${host}${path}`;
  return [
    "<item>",
    `  <title>${title}</title>`,
    `  <pubDate>${when}</pubDate>`,
    `  <guid isPermaLink="true">${url}</guid>`,
    `  <link><![CDATA[${url}?utm_source=rss_feed&utm_medium=rss_tag_ripple]]></link>`,
    "</item>",
  ].join("\n");
}

function feedXml(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;
}

test("ripple rss parse keeps newest cointelegraph headlines and drops noise", () => {
  const items = [
    itemXml("Ripple seed round is not kept", "/news/ripple-seed-round", "Wed, 30 Sep 2026 18:00:00 +0000"),
    itemXml("A secret ledger headline", "/news/secret-ledger", "Wed, 30 Sep 2026 17:00:00 +0000"),
    itemXml("sEdABCDEF shown in a headline", "/news/sed-wallet", "Wed, 30 Sep 2026 16:00:00 +0000"),
    itemXml("Ripple custody desk expands", "/news/ripple-custody-desk", "Wed, 30 Sep 2026 15:00:00 +0000"),
    itemXml(
      "Older custody title",
      "/news/ripple-custody-desk",
      "Tue, 01 Sep 2026 15:00:00 +0000"
    ),
    itemXml("Ripple &amp; XRP payments rail", "/news/ripple-xrp-payments-rail", "Wed, 30 Sep 2026 14:00:00 +0000"),
    itemXml("Ripple &amp; XRP payments rail", "/news/ripple-xrp-payments-rail-reprint", "Wed, 30 Sep 2026 13:30:00 +0000"),
    itemXml("Off host story", "/news/off-host", "Wed, 30 Sep 2026 13:00:00 +0000", "https://example.com"),
  ];
  for (let i = 0; i < 12; i += 1) {
    const when = new Date(Date.UTC(2026, 7, 20 - i, 12, 0, 0)).toUTCString();
    items.push(itemXml(`Ripple bulletin ${i}`, `/news/ripple-bulletin-${i}`, when));
  }
  const headlines = parseRippleHeadlines(feedXml(items));
  assert.equal(HEADLINE_CAP, 10);
  assert.equal(headlines.length, HEADLINE_CAP);
  assert.equal(headlines[0].title, "Ripple custody desk expands");
  assert.equal(headlines[0].url, "https://cointelegraph.com/news/ripple-custody-desk");
  assert.equal(headlines[0].stage, "press");
  assert.equal(headlines[0].onchain.kind, "none");
  assert.equal(headlines[0].actor, "Cointelegraph");
  assert.equal(headlines[0].label, "Press headline. Not on-chain.");
  assert.equal(headlines[1].title, "Ripple & XRP payments rail");
  assert.ok(headlines.every((row) => row.url.startsWith("https://cointelegraph.com/news/")));
  assert.equal(new Set(headlines.map((row) => row.url)).size, headlines.length);
  const blob = JSON.stringify(headlines);
  assert.doesNotMatch(blob, /seed|secret|sEd/);
  assert.doesNotMatch(blob, /example\.com|utm_source|Older custody|Same payments/);
  assert.ok(Date.parse(headlines[0].ts) > Date.parse(headlines[1].ts));
});

test("headline fetch times out and fails soft", async () => {
  assert.equal(HEADLINE_TIMEOUT_MS, 5000);
  assert.equal(RIPPLE_HEADLINE_FEED, "https://cointelegraph.com/rss/tag/ripple");
  let sawSignal = false;
  const failed = await fetchRippleHeadlines(async (input, init) => {
    assert.equal(input, RIPPLE_HEADLINE_FEED);
    sawSignal = Boolean(init?.signal);
    throw new Error("network down");
  });
  assert.equal(sawSignal, true);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.headlines, []);

  const badStatus = await fetchRippleHeadlines(async () => new Response("nope", { status: 503 }));
  assert.equal(badStatus.ok, false);
  assert.deepEqual(badStatus.headlines, []);
});

test("wall stays up when the press feed fails and merges headlines without touching programs", async () => {
  const down = await buildWall({
    xBearerToken: null,
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    fetch: async () => {
      throw new Error("rpc down");
    },
  });
  assert.notEqual(down.wire_status, "down");
  assert.deepEqual(down.headlines, []);
  assert.ok(down.programs.length >= 12);
  assert.match(down.probe_notes.join(" "), /Cointelegraph Ripple press feed was unavailable/);
  assert.match(down.probe_notes.join(" "), /No X bearer is configured/);
  assert.match(down.probe_notes.join(" "), /X headlines stay empty/);
  assert.doesNotMatch(JSON.stringify(down), /seed|secret|sEd/);

  const xml = feedXml([
    itemXml("Ripple custody desk expands", "/news/ripple-custody-desk", "Wed, 30 Sep 2026 15:00:00 +0000"),
    itemXml("Ripple seed round is not kept", "/news/ripple-seed-round", "Wed, 30 Sep 2026 18:00:00 +0000"),
  ]);
  const payload = await buildWall({
    xBearerToken: null,
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    fetch: async (input) => {
      if (String(input) === RIPPLE_HEADLINE_FEED) return new Response(xml, { status: 200 });
      throw new Error("rpc down");
    },
  });
  assert.notEqual(payload.wire_status, "down");
  assert.equal(payload.programs.length, (programsJson as unknown[]).length);
  assert.equal(payload.headlines.length, 1);
  assert.equal(payload.headlines[0].title, "Ripple custody desk expands");
  assert.equal(payload.headlines[0].onchain.kind, "none");
  assert.ok(payload.programs.every((row) => !row.id.startsWith("ct-")));
  const rss = renderRss(payload.programs, payload.generated_at, payload.headlines);
  assert.match(rss, /<category>press<\/category>/);
  assert.match(rss, /Press headline\. Not on-chain\./);
  assert.match(rss, /https:\/\/cointelegraph\.com\/news\/ripple-custody-desk/);
  assert.doesNotMatch(rss, /ripple-seed-round|seed round/);
  const rumors = payload.programs.filter((row) => row.stage === "rumor").length;
  assert.equal((rss.match(/<item>/g) || []).length, payload.programs.length - rumors + payload.headlines.length);
  assert.doesNotMatch(JSON.stringify(payload), /seed|secret|sEd/);

  const poisoned = await buildWall({
    xBearerToken: null,
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    headlines: [
      {
        id: "ct-ripple-seed-round",
        ts: "2026-09-30T18:00:00.000Z",
        actor: "Cointelegraph",
        title: "Ripple seed round is not kept",
        stage: "press",
        onchain: { kind: "none" },
        url: "https://cointelegraph.com/news/ripple-seed-round",
        source_title: "Cointelegraph",
        label: "Press headline. Not on-chain.",
      },
    ],
    fetch: async () => {
      throw new Error("rpc down");
    },
  });
  assert.notEqual(poisoned.wire_status, "down");
  assert.deepEqual(poisoned.headlines, []);
  assert.doesNotMatch(JSON.stringify(poisoned), /seed|secret|sEd/);
});

test("wall marquee loop is slow and still pauses", () => {
  assert.ok(WALL_TICKER_LOOP_S >= 70 && WALL_TICKER_LOOP_S <= 90);
  const css = readFileSync(new URL("../../web/app/globals.css", import.meta.url), "utf8");
  const tsx = readFileSync(new URL("../../web/components/wall-of-change.tsx", import.meta.url), "utf8");
  assert.match(css, new RegExp(`animation:\\s*wall-marquee\\s+${WALL_TICKER_LOOP_S}s\\s+linear\\s+infinite`));
  assert.match(css, /\.wall-ticker:hover \.wall-ticker-track/);
  assert.match(css, /\.wall-ticker:focus-within \.wall-ticker-track/);
  assert.match(css, /animation-play-state:\s*paused/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.ticker-copy \{\s*display:\s*none;/);
  assert.match(tsx, /animationDuration: `\$\{WALL_TICKER_LOOP_S\}s`/);
  assert.match(tsx, /PRESS/);
  assert.match(tsx, /X_POST_LABEL/);
  assert.match(tsx, /Cointelegraph titles and X posts/);
});

const X_TOKEN = "test-bearer-token-value-0123456789";

function xUser(id: string, username: string): { id: string; username: string } {
  return { id, username };
}

function xTweet(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "1840000000000000001",
    text: "RLUSD settlement update for the XRPL.",
    author_id: "100",
    created_at: "2026-09-30T16:00:00.000Z",
    lang: "en",
    ...over,
  };
}

test("x bearer stays out of git and a missing token does not fetch", async () => {
  assert.equal(X_SEARCH_ENDPOINT, "https://api.x.com/2/tweets/search/recent");
  assert.equal(X_HEADLINE_MAX, 10);
  assert.equal(X_HEADLINE_TIMEOUT_MS, 5000);
  assert.equal(X_HEADLINE_CACHE_MS, 3 * 60 * 1000);
  assert.equal(MERGED_HEADLINE_CAP, 15);
  assert.deepEqual(X_ACCOUNT_ALLOWLIST, ["Ripple", "RippleXDev", "RippleX", "bgarlinghouse", "smqkedqg"]);
  assert.equal(
    X_HEADLINE_QUERY,
    `(from:${X_ACCOUNT_ALLOWLIST.join(" OR from:")}) -is:retweet -is:reply lang:en`
  );
  for (const name of X_ACCOUNT_ALLOWLIST) {
    assert.match(X_HEADLINE_QUERY, new RegExp(`from:${name}\\b`));
  }
  assert.match(X_HEADLINE_QUERY, /-is:retweet/);
  assert.match(X_HEADLINE_QUERY, /-is:reply/);
  assert.match(X_HEADLINE_QUERY, /lang:en/);
  assert.doesNotMatch(X_HEADLINE_QUERY, /\bOR\s+(?:Ripple|RLUSD|XRPL|XRP)\b/);
  assert.doesNotMatch(X_HEADLINE_QUERY, /bearer|seed|secret/i);
  const endpoint = new URL(xRecentSearchUrl());
  assert.equal(endpoint.origin + endpoint.pathname, X_SEARCH_ENDPOINT);
  assert.equal(endpoint.searchParams.get("query"), X_HEADLINE_QUERY);
  assert.equal(endpoint.searchParams.get("max_results"), "10");
  assert.equal(endpoint.searchParams.get("next_token"), null);
  assert.equal(readXBearerToken({}), null);
  assert.equal(readXBearerToken({ X_BEARER_TOKEN: "short" }), null);
  assert.equal(readXBearerToken({ X_BEARER_TOKEN: "bad token value that is long enough!!" }), null);
  assert.equal(readXBearerToken({ X_BEARER_TOKEN: "a".repeat(20), TWITTER_BEARER_TOKEN: "b".repeat(20) }), "a".repeat(20));
  assert.equal(readXBearerToken({ TWITTER_BEARER_TOKEN: "c".repeat(25) }), "c".repeat(25));
  const example = readFileSync(new URL("../../web/.env.example", import.meta.url), "utf8");
  assert.match(example, /X_BEARER_TOKEN=/);
  assert.doesNotMatch(example, /X_BEARER_TOKEN=\S+/);
  let calls = 0;
  const missed = await fetchXHeadlines(
    async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
    { token: null, cache: null }
  );
  assert.equal(calls, 0);
  assert.equal(missed.ok, false);
  assert.equal(missed.reason, "unconfigured");
  assert.deepEqual(missed.headlines, []);
});

test("x recent search maps posts, drops noise, and caches without the bearer", async () => {
  const long = `Ripple ${"A".repeat(300)}`;
  const body = {
    data: [
      xTweet({ id: "1840000000000000009", text: "Ripple seed phrase giveaway", created_at: "2026-09-30T18:00:00.000Z" }),
      xTweet({ id: "1840000000000000008", text: "sEdABCDEF shown in a post", created_at: "2026-09-30T17:50:00.000Z" }),
      xTweet({
        id: "1840000000000000007",
        text: "RT @Ripple: copied post about XRPL",
        referenced_tweets: [{ type: "retweeted", id: "1" }],
        created_at: "2026-09-30T17:40:00.000Z",
      }),
      xTweet({
        id: "1840000000000000006",
        text: "Replying about XRPL",
        referenced_tweets: [{ type: "replied_to", id: "2" }],
        created_at: "2026-09-30T17:30:00.000Z",
      }),
      xTweet({ id: "1840000000000000005", text: "XRPL en español", lang: "es", created_at: "2026-09-30T17:20:00.000Z" }),
      xTweet({
        id: "1840000000000000004",
        text: "gm",
        author_id: "200",
        created_at: "2026-09-30T17:10:00.000Z",
      }),
      xTweet({ id: "1840000000000000003", text: "Office hours today", created_at: "2026-09-30T17:00:00.000Z" }),
      xTweet({
        id: "1840000000000000002",
        text: "Quoted note on RLUSD",
        referenced_tweets: [{ type: "quoted", id: "3" }],
        author_id: "200",
        created_at: "2026-09-30T16:30:00.000Z",
      }),
      xTweet({
        id: "1840000000000000012",
        text: "Desk note from the founder account",
        author_id: "400",
        created_at: "2026-09-30T16:45:00.000Z",
      }),
      xTweet({ id: "1840000000000000001", text: long, created_at: "2026-09-30T16:00:00.000Z" }),
      xTweet({ id: "1840000000000000001", text: "Ripple duplicate id", created_at: "2026-09-30T16:00:00.000Z" }),
      xTweet({
        id: "1840000000000000010",
        text: "RLUSD settlement update for the XRPL.",
        created_at: "2026-09-30T15:45:00.000Z",
      }),
      { id: 1840000000000000001, text: "Ripple numeric id", author_id: "100", created_at: "2026-09-30T15:00:00.000Z", lang: "en" },
      xTweet({ id: "1840000000000000011", text: "XRPL from a missing author", author_id: "404", created_at: "2026-09-30T15:30:00.000Z" }),
    ],
    includes: {
      users: [xUser("100", "Ripple"), xUser("200", "xrpl_watch"), xUser("300", "bad.name"), xUser("400", "smqkedqg")],
    },
    meta: { next_token: "do-not-page" },
  };
  const headlines = parseXHeadlines(body, X_TOKEN);
  assert.equal(headlines.length, 4);
  assert.equal(headlines[0].actor, "@Ripple");
  assert.equal(headlines[0].title, "Office hours today");
  assert.equal(headlines[0].url, "https://x.com/Ripple/status/1840000000000000003");
  assert.equal(headlines[0].id, "x-1840000000000000003");
  assert.equal(headlines[0].stage, "press");
  assert.equal(headlines[0].onchain.kind, "none");
  assert.equal(headlines[0].label, X_POST_LABEL);
  assert.equal(headlines[0].source_title, "X");
  assert.equal(headlines[1].actor, "@smqkedqg");
  assert.equal(headlines[1].title, "Desk note from the founder account");
  assert.equal(headlines[1].url, "https://x.com/smqkedqg/status/1840000000000000012");
  assert.equal(headlines[2].actor, "@Ripple");
  assert.equal(headlines[2].title.length <= 240, true);
  assert.ok(headlines[2].title.endsWith("…"));
  assert.equal(headlines[3].actor, "@Ripple");
  assert.equal(headlines[3].title, "RLUSD settlement update for the XRPL.");
  assert.equal(new Set(headlines.map((row) => row.url)).size, headlines.length);
  for (const row of headlines) {
    const handle = row.actor.slice(1).toLowerCase();
    assert.ok(X_ACCOUNT_ALLOWLIST.some((name) => name.toLowerCase() === handle));
  }
  const blob = JSON.stringify(headlines);
  assert.doesNotMatch(blob, /seed|secret|sEd|giveaway|español|duplicate|numeric|missing author|\bgm\b|xrpl_watch|Quoted note/);
  assert.doesNotMatch(blob, new RegExp(X_TOKEN));
  assert.equal(parseXHeadlines({ meta: { result_count: 0 } }).length, 0);
  const many = parseXHeadlines({
    data: Array.from({ length: 12 }, (_, i) =>
      xTweet({
        id: `1840000000000002${String(i).padStart(3, "0")}`,
        text: "XRPL bulletin",
        created_at: new Date(Date.UTC(2026, 8, 1, 0, i, 0)).toISOString(),
      })
    ),
    includes: { users: [xUser("100", "Ripple")] },
  });
  assert.equal(many.length, X_HEADLINE_MAX);
  assert.equal(many[0].id, "x-1840000000000002011");

  const memory: { slot: { at: number; key: string; result: { headlines: unknown[]; ok: boolean } } | null } = { slot: null };
  let calls = 0;
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input).includes(X_TOKEN), false);
    assert.equal(String(input).includes("next_token"), false);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(Boolean(init?.signal), true);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${X_TOKEN}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const first = await fetchXHeadlines(fetchImpl, { token: X_TOKEN, now: 1_000, cache: memory });
  const second = await fetchXHeadlines(fetchImpl, { token: X_TOKEN, now: 1_000 + 60_000, cache: memory });
  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.headlines.length, first.headlines.length);
  assert.equal(JSON.stringify(memory).includes(X_TOKEN), false);
  const third = await fetchXHeadlines(fetchImpl, { token: X_TOKEN, now: 1_000 + X_HEADLINE_CACHE_MS, cache: memory });
  assert.equal(calls, 2);
  assert.equal(third.ok, true);

  const denied = await fetchXHeadlines(async () => new Response(JSON.stringify({ errors: [{ message: X_TOKEN }] }), { status: 401 }), {
    token: X_TOKEN,
    cache: null,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "failed");
  assert.doesNotMatch(JSON.stringify(denied), new RegExp(X_TOKEN));

  const empty = await fetchXHeadlines(async () => new Response(JSON.stringify({ meta: { result_count: 0 } }), { status: 200 }), {
    token: X_TOKEN,
    cache: null,
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.headlines, []);

  const offHost = await fetchXHeadlines(
    async () => ({ ok: true, url: "https://evil.example/phish", text: async () => JSON.stringify(body) }) as Response,
    { token: X_TOKEN, cache: null }
  );
  assert.equal(offHost.ok, false);
  assert.deepEqual(offHost.headlines, []);

  const down = await fetchXHeadlines(
    async () => {
      throw new Error("network down");
    },
    { token: X_TOKEN, cache: null }
  );
  assert.equal(down.ok, false);
  assert.deepEqual(down.headlines, []);
});

test("wall merges cointelegraph and x headlines without inventing posts", async () => {
  const older: PressHeadline[] = [];
  for (let i = 0; i < 10; i += 1) {
    older.push({
      id: `ct-ripple-bulletin-${i}`,
      ts: new Date(Date.UTC(2026, 8, 20, 12, i, 0)).toISOString(),
      actor: "Cointelegraph",
      title: `Ripple bulletin ${i}`,
      stage: "press",
      onchain: { kind: "none" },
      url: `https://cointelegraph.com/news/ripple-bulletin-${i}`,
      source_title: "Cointelegraph",
      label: "Press headline. Not on-chain.",
    });
  }
  const posts = Array.from({ length: 10 }, (_, i) => ({
    id: `x-18400000000000001${i.toString().padStart(2, "0")}`,
    ts: new Date(Date.UTC(2026, 8, 21, 12, i, 0)).toISOString(),
    actor: "@Ripple",
    title: `XRPL note ${i}`,
    stage: "press" as const,
    onchain: { kind: "none" as const },
    url: `https://x.com/Ripple/status/18400000000000001${i.toString().padStart(2, "0")}`,
    source_title: "X",
    label: X_POST_LABEL,
  }));
  const merged = mergePressHeadlines(older, [
    ...posts,
    { ...posts[0], url: "https://www.x.com/Ripple/status/1840000000000000100" },
    {
      id: "x-1840000000000000199",
      ts: "2026-09-30T18:00:00.000Z",
      actor: "@Ripple",
      title: "Ripple seed phrase giveaway",
      stage: "press" as const,
      onchain: { kind: "none" as const },
      url: "https://x.com/Ripple/status/1840000000000000199",
      source_title: "X",
      label: X_POST_LABEL,
    },
    {
      id: "x-1840000000000000188",
      ts: "2026-09-30T18:00:00.000Z",
      actor: "@Other",
      title: "XRPL mismatch",
      stage: "press" as const,
      onchain: { kind: "none" as const },
      url: "https://x.com/Ripple/status/1840000000000000188",
      source_title: "X",
      label: X_POST_LABEL,
    },
    {
      id: "x-1840000000000000177",
      ts: "2026-09-30T18:00:00.000Z",
      actor: "@TJJXRP",
      title: "RLUSD keyword from outside the allowlist",
      stage: "press" as const,
      onchain: { kind: "none" as const },
      url: "https://x.com/TJJXRP/status/1840000000000000177",
      source_title: "X",
      label: X_POST_LABEL,
    },
  ]);
  assert.equal(merged.length, MERGED_HEADLINE_CAP);
  assert.equal(merged.filter((row) => row.label === X_POST_LABEL).length, 10);
  assert.equal(merged.filter((row) => row.actor === "Cointelegraph").length, 5);
  assert.ok(Date.parse(merged[0].ts) >= Date.parse(merged[merged.length - 1].ts));
  assert.equal(new Set(merged.map((row) => row.url.toLowerCase())).size, merged.length);
  assert.doesNotMatch(JSON.stringify(merged), /seed|secret|sEd|mismatch|TJJXRP|outside the allowlist/);

  const xml = feedXml([
    itemXml("Ripple custody desk expands", "/news/ripple-custody-desk", "Wed, 30 Sep 2026 15:00:00 +0000"),
  ]);
  const xBody = {
    data: [
      xTweet({ id: "1840000000000000042", text: "RLUSD is live for institutions.", created_at: "2026-09-30T16:00:00.000Z" }),
    ],
    includes: { users: [xUser("100", "Ripple")] },
  };
  let xCalls = 0;
  const payload = await buildWall({
    xBearerToken: X_TOKEN,
    xCache: { slot: null },
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    fetch: async (input, init) => {
      const url = String(input);
      if (url === RIPPLE_HEADLINE_FEED) return new Response(xml, { status: 200 });
      if (url === xRecentSearchUrl()) {
        xCalls += 1;
        assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${X_TOKEN}`);
        assert.equal(url.includes(X_TOKEN), false);
        return new Response(JSON.stringify(xBody), { status: 200 });
      }
      throw new Error("rpc down");
    },
  });
  assert.equal(xCalls, 1);
  assert.equal(payload.headlines.length, 2);
  assert.equal(payload.headlines[0].actor, "@Ripple");
  assert.equal(payload.headlines[0].label, "X post. Not on-chain.");
  assert.equal(payload.headlines[0].url, "https://x.com/Ripple/status/1840000000000000042");
  assert.equal(payload.headlines[1].actor, "Cointelegraph");
  assert.equal(payload.headlines[1].label, "Press headline. Not on-chain.");
  assert.equal(payload.programs.length, (programsJson as unknown[]).length);
  assert.doesNotMatch(payload.probe_notes.join(" "), /X press feed was unavailable/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(X_TOKEN));
  assert.doesNotMatch(JSON.stringify(payload), /seed|secret|sEd/);
  const rss = renderRss(payload.programs, payload.generated_at, payload.headlines);
  assert.match(rss, /X post\. Not on-chain\./);
  assert.match(rss, /https:\/\/x\.com\/Ripple\/status\/1840000000000000042/);
  assert.match(rss, /Press headline\. Not on-chain\./);
  assert.match(rss, /https:\/\/cointelegraph\.com\/news\/ripple-custody-desk/);
  const rumors = payload.programs.filter((row) => row.stage === "rumor").length;
  assert.equal((rss.match(/<item>/g) || []).length, payload.programs.length - rumors + payload.headlines.length);

  const xOnly = await buildWall({
    xBearerToken: X_TOKEN,
    xCache: { slot: null },
    now: Date.parse("2026-09-30T02:00:00.000Z"),
    status: null,
    fetch: async (input) => {
      if (String(input) === xRecentSearchUrl()) return new Response(JSON.stringify(xBody), { status: 200 });
      throw new Error("rss down");
    },
  });
  assert.equal(xOnly.headlines.length, 1);
  assert.equal(xOnly.headlines[0].label, X_POST_LABEL);
  assert.match(xOnly.probe_notes.join(" "), /Cointelegraph Ripple press feed was unavailable/);
  assert.doesNotMatch(xOnly.probe_notes.join(" "), /Headlines stay empty/);
  assert.equal(xOnly.programs.length, (programsJson as unknown[]).length);
});

const LIVE_IDS = ["sg-forge-eur", "rlusd-issuer", "circle-usdc", "ondo-ousg", "quantoz-eurq-usdq", "schuman-europ"];
const PILOT_IDS = ["guggenheim-dcp", "archax-abrdn-mmf", "ctrl-alt-dld"];

function freshAmendments(now: number) {
  return {
    probed_at: new Date(now).toISOString(),
    build_version: "3.4.1",
    amendments: [] as { name: string; enabled: boolean; majority: null }[],
  };
}

function accountInfoResult(account: string, drops: string, sequence: number, validated = true) {
  return {
    account_data: { Account: account, Balance: drops, Sequence: sequence },
    validated,
    ledger_index: 107390809,
  };
}

test("on-chain and mainnet filters stay on curated rows", () => {
  const rows = (programsJson as unknown[]).map((row) => validateProgram(row, sources));
  const targets = mainnetAccountTargets(rows);
  assert.deepEqual(
    targets.map((row) => row.id),
    LIVE_IDS
  );
  assert.equal(targets.some((row) => PILOT_IDS.includes(row.id)), false);
  assert.equal(targets.some((row) => row.id === "openeden-tbill"), false);
  const onChain = filterPrograms(rows, "on-chain");
  const mainnet = filterPrograms(rows, "mainnet");
  assert.ok(onChain.every((row) => row.onchain.kind !== "none"));
  for (const id of LIVE_IDS) {
    assert.equal(onChain.some((row) => row.id === id), true);
    assert.equal(mainnet.some((row) => row.id === id), true);
  }
  for (const id of PILOT_IDS) {
    assert.equal(onChain.some((row) => row.id === id), false);
    assert.equal(mainnet.some((row) => row.id === id), true);
    assert.equal(mainnet.find((row) => row.id === id)?.onchain.kind, "none");
  }
  assert.equal(onChain.some((row) => row.id === "openeden-tbill"), false);
  assert.equal(mainnet.some((row) => row.id === "openeden-tbill"), false);
  assert.equal(mainnet.some((row) => row.id === "odl-sbi-tranglo"), false);
  const tsx = readFileSync(new URL("../../web/components/wall-of-change.tsx", import.meta.url), "utf8");
  assert.match(tsx, /filter !== "all" && filter !== "press"/);
  assert.match(tsx, /on ledger · seq/);
  assert.equal(dropsToXrp("1500000"), "1.500000");
  assert.equal(dropsToXrp("118249602"), "118.249602");
  assert.equal(dropsToXrp("nope"), null);
});

test("mainnet account read refreshes allowlisted cards and fails soft", async () => {
  const now = Date.parse("2026-10-02T22:13:00.000Z");
  const fresh = freshAmendments(now);
  const curated = (programsJson as unknown[]).map((row) => validateProgram(row, sources));
  const expectedAccounts = new Map(mainnetAccountTargets(curated).map((row) => [row.id, row.account]));
  const calls: { host: string; method: string; account?: string }[] = [];

  function wallFetch(mode: "ok" | "down" | "missing" | "bad-network"): typeof fetch {
    return (async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: Record<string, unknown>[] };
      const method = String(body.method);
      const account = typeof body.params?.[0]?.account === "string" ? body.params[0].account : undefined;
      calls.push({ host: url.hostname, method, account });
      assert.ok(method === "server_info" || method === "feature" || method === "account_info");
      assert.notEqual(method, "submit");
      assert.notEqual(method, "sign");
      if (url.hostname === "xrplcluster.com" && method === "server_info") {
        return rpcResponse({
          info: {
            network_id: mode === "bad-network" ? 1 : 0,
            build_version: "3.4.1",
            validated_ledger: { seq: 107390809 },
          },
        });
      }
      if (url.hostname === "xrplcluster.com" && method === "feature") {
        return rpcResponse({
          features: {
            BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB: {
              name: "TokenEscrow",
              enabled: true,
              majority: null,
            },
          },
        });
      }
      if (url.hostname === "xrplcluster.com" && method === "account_info") {
        assert.equal(url.pathname, "/");
        assert.equal(body.params?.[0]?.ledger_index, "validated");
        assert.equal([...expectedAccounts.values()].includes(String(account)), true);
        if (mode === "down") throw new Error("mainnet unreachable");
        if (mode === "missing" && account === expectedAccounts.get("circle-usdc")) {
          return rpcResponse({ error: "actNotFound", error_message: "Account not found.", status: "error" });
        }
        return rpcResponse(accountInfoResult(String(account), "1500000", 42));
      }
      if (url.hostname === "s.altnet.rippletest.net" && method === "server_info") {
        return rpcResponse({
          info: { network_id: 1, build_version: "3.4.1", validated_ledger: { seq: 9 } },
        });
      }
      throw new Error(`unexpected ${method} ${url.hostname}`);
    }) as typeof fetch;
  }

  calls.length = 0;
  const payload = await buildWall({
    xBearerToken: null,
    headlines: [],
    now,
    status: {},
    testnetFile: fresh,
    devnetFile: fresh,
    lastSeen: { amendments: {} },
    fetch: wallFetch("ok"),
  });
  assert.equal(payload.wire_status, "ok");
  assert.equal(payload.amendments.TokenEscrow.mainnet, "on");
  assert.equal(payload.headlines.length, 0);
  const asked = calls.filter((call) => call.method === "account_info").map((call) => call.account);
  assert.deepEqual(asked.slice().sort(), [...expectedAccounts.values()].slice().sort());
  assert.equal(calls.some((call) => call.method === "submit" || call.method === "sign"), false);
  assert.equal(calls.some((call) => call.host !== "xrplcluster.com" && call.host !== "s.altnet.rippletest.net"), false);
  for (const id of LIVE_IDS) {
    const row = payload.programs.find((item) => item.id === id);
    const prior = curated.find((item) => item.id === id);
    assert.ok(row);
    assert.ok(prior);
    assert.equal(row.actor, prior.actor);
    assert.equal(row.claim, prior.claim);
    assert.equal(row.onchain.id, prior.onchain.id);
    assert.equal(row.onchain.url, prior.onchain.url);
    assert.equal(row.ledger?.present, true);
    assert.equal(row.ledger?.sequence, 42);
    assert.equal(row.ledger?.balance_xrp, "1.500000");
    assert.equal(row.ledger?.seen_at, "2026-10-02T22:13:00.000Z");
  }
  for (const id of [...PILOT_IDS, "openeden-tbill"]) {
    const row = payload.programs.find((item) => item.id === id);
    assert.equal(row?.ledger, undefined);
    assert.equal(row?.onchain.kind, "none");
  }
  const onChain = filterPrograms(payload.programs, "on-chain");
  const mainnet = filterPrograms(payload.programs, "mainnet");
  assert.ok(LIVE_IDS.every((id) => onChain.some((row) => row.id === id)));
  assert.ok(PILOT_IDS.every((id) => !onChain.some((row) => row.id === id)));
  assert.ok(PILOT_IDS.every((id) => mainnet.some((row) => row.id === id)));
  assert.doesNotMatch(JSON.stringify(payload), /seed|secret|sEd/);

  calls.length = 0;
  const down = await buildWall({
    xBearerToken: null,
    headlines: [],
    now,
    status: {},
    testnetFile: fresh,
    devnetFile: fresh,
    lastSeen: { amendments: {} },
    fetch: wallFetch("down"),
  });
  assert.equal(down.wire_status, "degraded");
  assert.match(down.probe_notes.join(" "), /Mainnet account probe failed for/);
  assert.match(down.probe_notes.join(" "), /Curated cards stay/);
  for (const id of LIVE_IDS) {
    const row = down.programs.find((item) => item.id === id);
    const prior = curated.find((item) => item.id === id);
    assert.equal(row?.ledger, undefined);
    assert.equal(row?.claim, prior?.claim);
    assert.equal(row?.onchain.id, prior?.onchain.id);
    assert.equal(filterPrograms(down.programs, "on-chain").some((item) => item.id === id), true);
    assert.equal(filterPrograms(down.programs, "mainnet").some((item) => item.id === id), true);
  }
  assert.equal(filterPrograms(down.programs, "mainnet").some((row) => row.id === "guggenheim-dcp"), true);
  assert.equal(filterPrograms(down.programs, "on-chain").some((row) => row.id === "guggenheim-dcp"), false);

  const missing = await buildWall({
    xBearerToken: null,
    headlines: [],
    now,
    status: {},
    testnetFile: fresh,
    devnetFile: fresh,
    lastSeen: { amendments: {} },
    fetch: wallFetch("missing"),
  });
  assert.equal(missing.wire_status, "degraded");
  assert.match(missing.probe_notes.join(" "), /not on the validated ledger for circle-usdc/);
  assert.equal(missing.programs.find((row) => row.id === "circle-usdc")?.ledger, undefined);
  assert.equal(missing.programs.find((row) => row.id === "circle-usdc")?.onchain.id, expectedAccounts.get("circle-usdc"));
  assert.equal(missing.programs.find((row) => row.id === "rlusd-issuer")?.ledger?.sequence, 42);

  calls.length = 0;
  const refused = await buildWall({
    xBearerToken: null,
    headlines: [],
    now,
    status: {},
    testnetFile: fresh,
    devnetFile: fresh,
    lastSeen: { amendments: {} },
    fetch: wallFetch("bad-network"),
  });
  assert.equal(calls.some((call) => call.method === "account_info"), false);
  assert.match(refused.probe_notes.join(" "), /Mainnet feature probe failed/);
  assert.match(refused.probe_notes.join(" "), /Mainnet account probe was not applied/);
  assert.equal(refused.programs.find((row) => row.id === "sg-forge-eur")?.ledger, undefined);
  assert.equal(refused.amendments.TokenEscrow.mainnet, "unknown");
  assert.notEqual(refused.amendments.TokenEscrow.mainnet, "on");
});
