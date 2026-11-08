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

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

function writePrivateAccount(file, wallet) {
  const resolved = assertOutside(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify({ address: wallet.address, seed: wallet.seed }), { mode: 0o600 });
  if (modeOf(resolved) !== 0o600) throw coded("diagnostic account file must be mode 0600", "AUTH");
  return { address: wallet.address };
}

function inspectAccount(file) {
  const resolved = assertOutside(file);
  if (!fs.existsSync(resolved)) throw coded("diagnostic account file is missing", "AUTH");
  if (modeOf(resolved) !== 0o600) throw coded("diagnostic account file must be mode 0600", "AUTH");
  const body = JSON.parse(fs.readFileSync(resolved, "utf8"));
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
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${text}\n`, { mode: 0o644 });
  return body;
}

function readHandover(file) {
  const resolved = assertOutside(file);
  const text = fs.readFileSync(resolved, "utf8");
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
