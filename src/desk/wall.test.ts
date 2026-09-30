import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import programsJson from "../../lab/wall/programs.json" with { type: "json" };
import sourcesJson from "../../lab/wall/sources.json" with { type: "json" };
import {
  CLOCK,
  filterPrograms,
  validateProgram,
  validateSources,
  type Program,
} from "../../web/lib/wall-schema.ts";
import { applyFoundryTwins, buildWall, renderRss, resolveAmendmentDots } from "../../web/lib/wall.ts";

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
  assert.ok((programsJson as unknown[]).length >= 18);
  assert.ok((programsJson as unknown[]).length <= 20);
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
