"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ENTRIES = ["src/business/worker.js", "src/business/dex/live.js", "src/business/dex/supervisor.js"];

function walk(root, rel, seen) {
  if (seen.has(rel)) return;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`missing dex pack file ${rel}`);
  seen.add(rel);
  if (!rel.endsWith(".js")) return;
  const text = fs.readFileSync(abs, "utf8");
  const pattern = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const target = path.normalize(path.join(path.dirname(rel), match[1]));
    const candidates = [target, `${target}.js`, `${target}.json`];
    const found = candidates.find((item) => fs.existsSync(path.join(root, item)) && fs.statSync(path.join(root, item)).isFile());
    if (!found) throw new Error(`unresolved require ${match[1]} from ${rel}`);
    walk(root, found, seen);
  }
}

function packDex(options) {
  const root = options.root;
  const seen = new Set();
  for (const entry of ENTRIES) walk(root, entry, seen);
  seen.add("docs/w1-dex-operator.md");
  seen.add("package.json");
  seen.add("package-lock.json");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "w1-dex-pack-"));
  const files = [];
  for (const rel of seen) {
    if (/(^|\/)\.env|events\.jsonl|\/lab\/|seed|secret/i.test(rel)) throw new Error(`refusing dex pack path ${rel}`);
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const bytes = fs.readFileSync(path.join(root, rel));
    if (/W0_SEED\s*=\s*\S+|sEd[1-9A-HJ-NP-Za-km-z]{10,}/.test(bytes.toString("utf8"))) {
      throw new Error(`refusing embedded secret in ${rel}`);
    }
    fs.writeFileSync(dest, bytes);
    files.push({
      path: rel,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const gitSha = git.status === 0 ? git.stdout.trim() : "unknown";
  const attestation = {
    schema: "aether.business.dex.attestation",
    git_sha: gitSha,
    live_proof: false,
    caps_raised: false,
    legacy_hold: "msn5b5c3223e5e88526",
    legacy_drops: "1747",
    w1: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
    axelar_drops: "0",
    review_command: "node --test src/business/business.test.js src/business/dex.test.js src/business/dex/director.test.js src/business/bankroll.test.js src/business/bankroll-audit.test.js",
  };
  fs.writeFileSync(path.join(stage, "ATTESTATION.json"), `${JSON.stringify(attestation, null, 2)}\n`);
  const manifest = {
    schema: "aether.business.dex.pack",
    git_sha: gitSha,
    live_proof: false,
    files,
  };
  fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = files.map((row) => `${row.sha256}  ${row.path}`).concat([
    `${crypto.createHash("sha256").update(fs.readFileSync(path.join(stage, "manifest.json"))).digest("hex")}  manifest.json`,
    `${crypto.createHash("sha256").update(fs.readFileSync(path.join(stage, "ATTESTATION.json"))).digest("hex")}  ATTESTATION.json`,
  ]).join("\n");
  fs.writeFileSync(path.join(stage, "SHA256SUMS"), `${sums}\n`);
  const outDir = options.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const tarPath = path.join(outDir, `foundry-w1-dex-${gitSha}.tar`);
  const packed = spawnSync("tar", ["-cf", tarPath, "-C", stage, "."], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
  const tarSha = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");
  return { tarPath, tarSha, gitSha, manifest };
}

if (require.main === module) {
  const outDir = process.argv[2] || path.join(os.tmpdir(), "w1-dex-out");
  const result = packDex({ root: path.resolve(__dirname, "..", "..", ".."), outDir });
  process.stdout.write(`${JSON.stringify({ tar: result.tarPath, tar_sha256: result.tarSha, git_sha: result.gitSha, files: result.manifest.files.length })}\n`);
}

module.exports = { packDex };
