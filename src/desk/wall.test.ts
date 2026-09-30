import assert from "node:assert/strict";
import test from "node:test";
import programsJson from "../../lab/wall/programs.json" with { type: "json" };
import sourcesJson from "../../lab/wall/sources.json" with { type: "json" };
import {
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
  assert.ok((programsJson as unknown[]).length >= 12);
  assert.ok((programsJson as unknown[]).length <= 20);
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
