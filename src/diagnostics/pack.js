"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ENTRIES = [
  "src/diagnostics/buyer-diagnostic.js",
  "src/diagnostics/controlled-seller.js",
  "src/diagnostics/controlled-purchase.js",
];

function walk(root, rel, seen) {
  if (seen.has(rel)) return;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`missing diagnostic file ${rel}`);
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

function packDiagnostic(options) {
  const root = options.root;
  const seen = new Set();
  for (const entry of ENTRIES) walk(root, entry, seen);
  seen.add("machines/diagnostics/BUYER.md");
  seen.add("package.json");
  seen.add("package-lock.json");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "buyer-diagnostic-"));
  const files = [];
  for (const rel of seen) {
    if (/\.env|events\.jsonl|\/lab\/|seed/i.test(rel)) throw new Error(`refusing diagnostic pack path ${rel}`);
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
    const bytes = fs.readFileSync(dest);
    files.push({
      path: rel,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const gitSha = git.status === 0 ? git.stdout.trim() : "unknown";
  const manifest = { schema: "aether.diagnostics.buyer.pack", git_sha: gitSha, files };
  fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = files.map((row) => `${row.sha256}  ${row.path}`).concat([
    `${crypto.createHash("sha256").update(fs.readFileSync(path.join(stage, "manifest.json"))).digest("hex")}  manifest.json`,
  ]).join("\n");
  fs.writeFileSync(path.join(stage, "SHA256SUMS"), `${sums}\n`);
  const outDir = options.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const tarPath = path.join(outDir, `foundry-buyer-diagnostic-${gitSha}.tar`);
  const packed = spawnSync("tar", ["-cf", tarPath, "-C", stage, "."], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
  return { tarPath, gitSha, manifest };
}

if (require.main === module) {
  const outDir = process.argv[2] || path.join(os.tmpdir(), "buyer-diagnostic-out");
  const result = packDiagnostic({ root: path.resolve(__dirname, "..", ".."), outDir });
  process.stdout.write(`${JSON.stringify({ tar: result.tarPath, git_sha: result.gitSha, files: result.manifest.files.length })}\n`);
}

module.exports = { packDiagnostic };
