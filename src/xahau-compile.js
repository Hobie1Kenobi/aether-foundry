#!/usr/bin/env node
"use strict";

/**
 * Compile hooks/w7-split/w7-split.c with the local wasm32 clang.
 * Does not sign. Does not read seeds.
 *
 *   npm run xahau:compile
 *
 * Needs clang with a wasm32 target and wasm-ld (apt package lld).
 * Headers are hooks/vendor/xahau from Xahau/xahaud (see that directory's
 * LICENSE.md). -Os is used because the unrolled hook has no loops; the
 * guard checker rejects an unguarded loop. clang also writes custom
 * sections (name, producers, target_features). The guard checker
 * rejects those, so this script runs wasm-strip before the artifact
 * that SetHook uploads is written.
 *
 * The public buildbox at https://hook-buildbox.xrpl.org still guard-checks
 * against a header set that does not list `prepare`. Xahau Testnet
 * (2026.6.21, HooksUpdate2) does. This script compiles locally so the
 * import matches the network that will run SetHook.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const guard = require("./xahau-split-guard");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "hooks", "w7-split", "w7-split.c");
const OUT_WASM = path.join(ROOT, "hooks", "w7-split", "w7-split.wasm");
const OUT_META = path.join(ROOT, "hooks", "w7-split", "build-meta.json");
const INCLUDE = path.join(ROOT, "hooks", "vendor", "xahau");

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function main() {
  const clang = process.env.HOOK_CLANG || "clang";
  const args = [
    "--target=wasm32",
    "-Os",
    "-nostdlib",
    "-ffreestanding",
    "-fno-builtin",
    "-I",
    INCLUDE,
    "-Wl,--no-entry",
    "-Wl,--allow-undefined",
    "-Wl,--export=hook",
    "-Wl,--export=cbak",
    "-o",
    OUT_WASM,
    SOURCE,
  ];
  const run = spawnSync(clang, args, { encoding: "utf8" });
  if (run.error && run.error.code === "ENOENT") {
    die(
      [
        "clang was not found.",
        "Install a wasm32 clang and wasm-ld, then re-run npm run xahau:compile.",
        "Debian/Ubuntu: sudo apt-get install -y clang lld wabt",
        "The public hook buildbox currently rejects the prepare import; do not use it for this hook.",
      ].join("\n")
    );
  }
  if (run.status !== 0) {
    die([run.stdout, run.stderr, `clang exited ${run.status}`].filter(Boolean).join("\n"));
  }
  const strip = spawnSync("wasm-strip", [OUT_WASM], { encoding: "utf8" });
  if (strip.error && strip.error.code === "ENOENT") {
    die("wasm-strip was not found. Install wabt (apt package wabt), then re-run npm run xahau:compile.");
  }
  if (strip.status !== 0) {
    die([strip.stdout, strip.stderr, `wasm-strip exited ${strip.status}`].filter(Boolean).join("\n"));
  }
  const wasm = fs.readFileSync(OUT_WASM);
  const info = guard.assertHookWasm(wasm);
  const meta = {
    source: "hooks/w7-split/w7-split.c",
    wasm: "hooks/w7-split/w7-split.wasm",
    bytes: wasm.length,
    sha256: crypto.createHash("sha256").update(wasm).digest("hex"),
    compiler: `${clang} --target=wasm32 -Os && wasm-strip`,
    headers: "hooks/vendor/xahau",
    headers_commit: "a7f9c683c427637ba8b534171af30f1d5c937dec",
    exports: info.exports.map((row) => row.name),
    imports: info.imports.map((row) => row.name),
    compiled_at: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`compiled ${wasm.length} bytes`);
  console.log(`sha256 ${meta.sha256}`);
  console.log(`exports ${meta.exports.join(",")}`);
  console.log(`imports ${meta.imports.join(",")}`);
  console.log(`wrote ${path.relative(ROOT, OUT_WASM)}`);
}

main();
