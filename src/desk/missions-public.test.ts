import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { missionFeed, publicMissionResponse } from "../../web/lib/missions-public.ts";

test("public mission snapshot keeps caps, disabled spending, and zero live spend apart", () => {
  const feed = missionFeed();
  assert.equal(feed.spending_enabled, false);
  assert.equal(feed.signing_enabled, false);
  assert.equal(feed.authorized_per_mission_drops, "1000000");
  assert.equal(feed.authorized_daily_drops, "5000000");
  assert.equal(feed.live_spend_drops, "0");
  assert.equal(feed.source, "snapshot");
  assert.equal(feed.source_observed_at, "2026-11-06T17:00:00.000Z");
  assert.equal(feed.timezone, "America/Chicago");
});

test("public mission writes are denied and an unknown detail is not invented", async () => {
  const posted = publicMissionResponse("POST", "feed");
  assert.equal(posted.status, 405);
  assert.equal(posted.body.code, "PUBLIC_WRITE");
  const routes = [
    "web/app/api/missions/route.ts",
    "web/app/api/missions/status/route.ts",
    "web/app/api/missions/[id]/route.ts",
    "web/app/api/missions/[id]/replay/route.ts",
  ];
  for (const file of routes) {
    const text = fs.readFileSync(path.resolve(file), "utf8");
    assert.match(text, /export async function POST/);
    assert.match(text, /publicMissionResponse\("POST"/);
    assert.equal(/W0_SEED|fromSeed|sign\(/.test(text), false, file);
  }
  const missing = publicMissionResponse("GET", "detail", "msn-missing");
  assert.equal(missing.status, 404);
  const status = publicMissionResponse("GET", "status");
  assert.equal(status.body.source_observed_at, "2026-11-06T17:00:00.000Z");
  assert.equal(status.body.live_spend_drops, "0");
  assert.notEqual(status.body.authorized_daily_drops, status.body.live_spend_drops);
});
