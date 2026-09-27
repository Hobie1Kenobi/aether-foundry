"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function assertIgnoredIfInsideRepo(file, repoRoot, execFile) {
  const resolved = path.resolve(file);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  const run = execFile || execFileSync;
  try {
    run("git", ["check-ignore", "--quiet", "--", rel], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(
      `refusing to write key material inside the repo at a path git does not ignore: ${rel}`
    );
  }
}

function readKeyFile(file, io = {}) {
  const exists = io.existsSync || fs.existsSync;
  const readFile = io.readFileSync || fs.readFileSync;
  if (!exists(file)) return {};
  return parseEnv(readFile(file, "utf8"));
}

function upsertKeyFile(file, pairs, io = {}) {
  const keys = Object.keys(pairs);
  if (keys.length === 0) return { wrote: [] };
  for (const key of keys) {
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("refusing a key name that is not uppercase env syntax");
    if (typeof pairs[key] !== "string" || pairs[key].length === 0) {
      throw new Error(`refusing to write an empty ${key}`);
    }
    if (/[\r\n]/.test(pairs[key])) throw new Error(`refusing to write ${key}`);
  }
  const repoRoot = io.repoRoot;
  if (repoRoot) assertIgnoredIfInsideRepo(file, repoRoot, io.execFile);
  const exists = io.existsSync || fs.existsSync;
  const readFile = io.readFileSync || fs.readFileSync;
  const mkdir = io.mkdirSync || fs.mkdirSync;
  const writeFile = io.writeFileSync || fs.writeFileSync;
  const chmod = io.chmodSync || fs.chmodSync;
  mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let text = exists(file) ? readFile(file, "utf8") : "";
  if (text.length && !text.endsWith("\n")) text += "\n";
  const present = parseEnv(text);
  const wrote = [];
  for (const key of keys) {
    if (present[key]) continue;
    text += `${key}=${pairs[key]}\n`;
    wrote.push(key);
  }
  if (wrote.length) {
    writeFile(file, text, { mode: 0o600 });
    chmod(file, 0o600);
  }
  return { wrote };
}

module.exports = {
  parseEnv,
  assertIgnoredIfInsideRepo,
  readKeyFile,
  upsertKeyFile,
};
