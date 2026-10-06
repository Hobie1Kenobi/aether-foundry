import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { surfaceFromTexts, toHellos, toSessions, W3 } from "../../web/lib/net-chat.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("desk net surface keeps xrpl:1 rows and drops secret-shaped text", () => {
  const hellos = [
    JSON.stringify({
      network: "xrpl:1",
      account: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
      hash: "A".repeat(64),
      ledger: 42,
      memo: { repo: "https://github.com/example/peer", x402: "https://peer.example/x402" },
      seen_at: "2026-10-06T01:36:00Z",
    }),
    JSON.stringify({
      network: "xrpl:0",
      account: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
      hash: "B".repeat(64),
      memo: { repo: "https://github.com/example/mainnet" },
    }),
    JSON.stringify({
      network: "xrpl:1",
      account: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
      hash: "C".repeat(64),
      memo: { repo: "sEdTM1uX8pu2do5XvTnutH6HsouMaM2gyVq1wS5tA4s1yYg" },
    }),
  ].join("\n");
  const sessions = [
    JSON.stringify({
      network: "xrpl:1",
      session: "s_a11ce00000000001",
      state: "open",
      peer: W3,
      from: "aether-herald",
      hash: "D".repeat(64),
      topic: "discover-foundry",
      synthetic: true,
      ledger_claim: false,
      seen_at: "2026-10-06T03:00:00Z",
    }),
  ].join("\n");
  const surface = surfaceFromTexts(hellos, sessions, "test");
  assert.equal(surface.signing, "none");
  assert.equal(surface.desk, "read-only");
  assert.equal(surface.w3, W3);
  assert.equal(surface.hellos.length, 1);
  assert.equal(surface.hellos[0].repo, "https://github.com/example/peer");
  assert.equal(surface.sessions.length, 1);
  assert.equal(surface.sessions[0].synthetic, true);
  assert.equal(surface.sessions[0].ledger_claim, false);
  assert.equal(JSON.stringify(surface).includes("sEd"), false);
});

test("empty files stay an empty public list", () => {
  const surface = surfaceFromTexts("", "", "test");
  assert.deepEqual(toHellos([]), []);
  assert.deepEqual(toSessions([]), []);
  assert.equal(surface.hellos.length, 0);
  assert.equal(surface.sessions.length, 0);
  assert.equal(surface.note, null);
});

test("desk routes do not sign", () => {
  const files = [
    "web/app/net/page.tsx",
    "web/app/api/peers/hellos/route.ts",
    "web/app/api/peers/sessions/route.ts",
    "web/lib/net-chat.ts",
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/Wallet\.sign|\.submit\(|signAndSubmit|FOUNDRY_SIGNER/.test(text), false, rel);
  }
});
