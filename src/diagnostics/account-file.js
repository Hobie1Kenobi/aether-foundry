"use strict";

/**
 * Private buyer account file and the public address handover.
 * The seed stays in a mode 0600 file outside this checkout.
 * This module never writes the seed to stdout.
 */

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const { coded } = require("../missions/ledger");

const CHECKOUT = "/workspace/aether-foundry";

function assertOutside(file) {
  const resolved = path.resolve(String(file || ""));
  if (!file || resolved === CHECKOUT || resolved.startsWith(`${CHECKOUT}/`)) {
    throw coded("refusing an account file inside the checkout", "ISOLATED");
  }
  return resolved;
}

function assertAbsent(resolved) {
  try {
    fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw coded("account file cannot be created", "AUTH");
  }
  throw coded("account file already exists", "AUTH");
}

function createExclusive(resolved, mode) {
  assertAbsent(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_WRONLY;
  let fd;
  try {
    fd = fs.openSync(resolved, flags, mode);
  } catch {
    throw coded("account file cannot be created", "AUTH");
  }
  return fd;
}

function writeExclusive(file, text, mode) {
  const resolved = assertOutside(file);
  const fd = createExclusive(resolved, mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fchmodSync(fd, mode);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== mode) {
      throw coded("account file permissions are not private", "AUTH");
    }
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}

function readNoFollow(file) {
  const resolved = assertOutside(file);
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ENOENT") throw coded("diagnostic account file is missing", "AUTH");
    throw coded("diagnostic account file cannot be read", "AUTH");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw coded("diagnostic account file cannot be read", "AUTH");
    return { resolved, stat, text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateAccount(file, wallet) {
  writeExclusive(file, JSON.stringify({ address: wallet.address, seed: wallet.seed }), 0o600);
  return { address: wallet.address };
}

function inspectAccount(file) {
  const opened = readNoFollow(file);
  if ((opened.stat.mode & 0o777) !== 0o600) throw coded("diagnostic account file must be mode 0600", "AUTH");
  const body = JSON.parse(opened.text);
  let wallet;
  try {
    wallet = xrpl.Wallet.fromSeed(body.seed);
  } catch {
    throw coded("diagnostic account file does not match", "AUTH");
  }
  if (!wallet || wallet.address !== body.address) throw coded("diagnostic account file does not match", "AUTH");
  return { address: wallet.address, wallet };
}

function writeHandover(file, handover) {
  const resolved = assertOutside(file);
  const body = { network: "xrpl:1", buyer: handover.buyer, seller: handover.seller };
  const text = JSON.stringify(body);
  if (/seed|secret|sEd/i.test(text)) throw coded("handover is not public", "AUTH");
  writeExclusive(resolved, `${text}\n`, 0o644);
  return body;
}

function readHandover(file) {
  const text = readNoFollow(file).text;
  if (/seed|secret|sEd/i.test(text)) throw coded("handover is not public", "AUTH");
  const body = JSON.parse(text);
  if (!body || body.network !== "xrpl:1" || typeof body.buyer !== "string" || typeof body.seller !== "string") {
    throw coded("handover is not an xrpl:1 address pair", "AUTH");
  }
  return body;
}

if (require.main === module) {
  try {
    const inspected = inspectAccount(process.argv[2]);
    process.stdout.write(`${JSON.stringify({ address: inspected.address })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "AUTH"}\n`);
    process.exit(1);
  }
}

module.exports = {
  writePrivateAccount,
  inspectAccount,
  writeHandover,
  readHandover,
};
