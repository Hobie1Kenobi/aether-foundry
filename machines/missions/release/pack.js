#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
const ENTRIES = [
  "src/missions/worker.js",
  "src/missions/signer.js",
  "src/missions/github-publish.js",
  "src/missions/wallet-tool.js",
  "src/missions/runner.js",
  "src/missions/cli.js",
  "src/missions/publish.js",
  "src/missions/engine.js",
  "src/missions/retry-fee.js",
];
const DOCS = [
  "machines/missions/RUNBOOK.md",
  "machines/missions/ACCEPTANCE.md",
  "machines/missions/THREAT.md",
  "machines/missions/ensure-up.snippet.sh",
  "machines/missions/release/INSTALL.md",
];
const BINS = ["start", "health", "stop", "arm", "wake", "account", "execute", "publish", "reconcile"];
const EXTRA = ["src/runtime/allowlist.json", "src/missions/port-wait.js"];

function scriptsFromBins(root) {
  const binDir = path.join(root, "machines/missions/release/bin");
  const present = fs.readdirSync(binDir).filter((name) => fs.statSync(path.join(binDir, name)).isFile());
  for (const name of present) {
    if (!BINS.includes(name)) throw new Error(`bin/${name} is not in the pack list`);
  }
  const scripts = new Set();
  for (const name of BINS) {
    const text = fs.readFileSync(path.join(root, "machines/missions/release/bin", name), "utf8");
    for (const match of text.matchAll(/(?:^|[\s;|&])node\s+(src\/[A-Za-z0-9_./-]+\.js)\b/g)) {
      scripts.add(match[1]);
    }
  }
  if (!scripts.has("src/missions/execute-once.js") || !scripts.has("src/missions/publish-health.js")) {
    throw new Error("bin/execute and bin/publish must name their modules");
  }
  return [...scripts];
}

function walkRequires(root, rel, seen) {
  if (seen.has(rel)) return;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`missing runtime file ${rel}`);
  }
  seen.add(rel);
  if (!rel.endsWith(".js")) return;
  const text = fs.readFileSync(abs, "utf8");
  const pattern = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const target = path.normalize(path.join(path.dirname(rel), match[1]));
    const candidates = [target, `${target}.js`, `${target}.json`, path.join(target, "index.js")];
    const found = candidates.find((item) => fs.existsSync(path.join(root, item)) && fs.statSync(path.join(root, item)).isFile());
    if (!found) throw new Error(`unresolved require ${match[1]} from ${rel}`);
    walkRequires(root, found, seen);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function installText(gitSha) {
  return `# Install this release beside the existing checkout

Release ${gitSha}. Do not unpack it inside /workspace/aether-foundry. Do not pull, reset, stash, or restart the signer on 127.0.0.1:8787, scribe on 8792, or license on 8793.

\`\`\`bash
install -d /workspace/foundry-ops/releases/${gitSha}
tar -xf foundry-missions-${gitSha}.tar -C /workspace/foundry-ops/releases/${gitSha}
cd /workspace/foundry-ops/releases/${gitSha}
npm ci --omit=dev
./bin/start
./bin/health
./bin/stop
\`\`\`

\`npm ci\` installs the pinned \`xrpl@5.3.0\` tree from the public npm registry. No other service is added. The worker listens on 127.0.0.1:8794 and stays asleep. The dedicated signer listens on 127.0.0.1:8788 only when \`FOUNDRY_MISSION_SIGNER_TOKEN\` is set, and \`bin/start\` removes W0–W6 seed variables from both processes. \`bin/start\` also unsets \`FOUNDRY_MISSION_EXECUTE\`.

The ledger for this release is \`/workspace/foundry-ops/missions-runtime/ledger\`. It is not \`lab/missions\` in the old checkout.

Node requirement: >=20.19, because that is the \`xrpl\` engine range. Dependencies are only those in \`package-lock.json\`.
`;
}

function pack(options) {
  const opts = options || {};
  const root = opts.root || REPO;
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0) throw new Error("git rev-parse failed");
  const gitSha = git.stdout.trim();
  const seen = new Set();
  for (const entry of ENTRIES.concat(scriptsFromBins(root))) walkRequires(root, entry, seen);
  for (const extra of EXTRA) {
    if (fs.existsSync(path.join(root, extra))) seen.add(extra);
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mission-release-"));
  for (const rel of seen) {
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  }
  for (const rel of DOCS) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    const dest = path.join(
      stage,
      path.basename(rel) === "INSTALL.md"
        ? "INSTALL.md"
        : path.basename(rel) === "ensure-up.snippet.sh"
          ? "machines/missions/ensure-up.snippet.sh"
          : path.join("docs", path.basename(rel))
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  }
  fs.writeFileSync(path.join(stage, "INSTALL.md"), installText(gitSha));
  const snippet = path.join(stage, "machines/missions/ensure-up.snippet.sh");
  if (fs.existsSync(snippet)) {
    fs.writeFileSync(snippet, fs.readFileSync(snippet, "utf8").replaceAll("REPLACE_WITH_RELEASE_SHA", gitSha));
  }
  fs.copyFileSync(path.join(root, "machines/missions/release/package.json"), path.join(stage, "package.json"));
  fs.copyFileSync(path.join(root, "machines/missions/release/package-lock.json"), path.join(stage, "package-lock.json"));
  fs.mkdirSync(path.join(stage, "bin"));
  for (const name of BINS) {
    const dest = path.join(stage, "bin", name);
    fs.copyFileSync(path.join(root, "machines/missions/release/bin", name), dest);
    fs.chmodSync(dest, 0o755);
  }
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(stage, abs).split(path.sep).join("/");
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else files.push({ path: rel, sha256: sha256(abs), bytes: fs.statSync(abs).size });
    }
  };
  walk(stage);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schema: "aether.missions.release",
    git_sha: gitSha,
    base: "1116ce48a3128aa4ccfb8429c06841bf5cb844aa",
    files,
  };
  fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  manifest.files.push({ path: "manifest.json", sha256: sha256(path.join(stage, "manifest.json")), bytes: fs.statSync(path.join(stage, "manifest.json")).size });
  const sums = manifest.files.map((row) => `${row.sha256}  ${row.path}`).join("\n");
  fs.writeFileSync(path.join(stage, "SHA256SUMS"), `${sums}\n`);
  const outDir = opts.outDir || path.join(root, "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const tarName = `foundry-missions-${gitSha}.tar`;
  const tarPath = path.join(outDir, tarName);
  const packed = spawnSync("tar", ["-cf", tarPath, "-C", stage, "."], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
  return { tarPath, gitSha, manifest, stage };
}

if (require.main === module) {
  const outDir = process.argv[2];
  const result = pack(outDir ? { outDir } : {});
  process.stdout.write(`${JSON.stringify({ tar: result.tarPath, git_sha: result.gitSha, files: result.manifest.files.length })}\n`);
}

module.exports = { pack, walkRequires, ENTRIES };
