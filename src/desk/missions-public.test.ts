import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { publicMissionResponse } from "../../web/lib/missions-public.ts";

const require = createRequire(import.meta.url);
const { handlePublic } = require("../../src/missions/public.js");

test("a server with no ledger reports unknown live spend and a stale source", async () => {
  const missing = handlePublic({ method: "GET", route: "status", served_at: "2026-11-06T18:00:00.000Z" }, null);
  assert.equal(missing.body.source, "unavailable");
  assert.equal(missing.body.source_observed_at, null);
  assert.equal(missing.body.stale, true);
  assert.equal(missing.body.live_spend_drops, null);
  assert.equal(missing.body.spending_enabled_source, "default_off");
  process.env.FOUNDRY_MISSION_REMOTE = "off";
  const rendered = await publicMissionResponse("GET", "status");
  assert.equal(rendered.body.source, "unavailable");
  assert.equal(rendered.body.live_spend_drops, null);
  assert.equal(rendered.body.stale, true);
});

test("public mission writes are denied", async () => {
  const posted = await publicMissionResponse("POST", "feed");
  assert.equal(posted.status, 405);
  assert.equal(posted.body.code, "PUBLIC_WRITE");
  const routes = [
    "web/app/api/missions/route.ts",
    "web/app/api/missions/status/route.ts",
    "web/app/api/missions/[id]/route.ts",
    "web/app/api/missions/[id]/replay/route.ts",
    "web/app/missions/page.tsx",
    "web/lib/missions-public.ts",
  ];
  for (const file of routes) {
    const text = fs.readFileSync(path.resolve(file), "utf8");
    assert.equal(text.includes("machines/missions/public-feed.json"), false, file);
    assert.equal(text.includes('live_spend_drops: "0"'), false, file);
    assert.equal(text.includes("2026-11-06T17:00:00.000Z"), false, file);
  }
});
