#!/usr/bin/env node
"use strict";

const path = require("path");
const { handlePublic } = require("./public");
const { coded } = require("./ledger");

const ROOT = path.resolve(__dirname, "..", "..");
const LEDGER = path.join(ROOT, "lab", "missions");

function fail(error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: error.code || "ERROR",
      error: error.message,
      signed: false,
      submitted: false,
      spending_enabled: false,
    })}\n`
  );
  process.exit(1);
}

function main(argv) {
  const cmd = argv[2] || "status";
  if (cmd === "sign" || cmd === "submit" || cmd === "spend") {
    throw coded("mission signing and spending are disabled", "SIGNING_DISABLED");
  }
  if (cmd === "status" || cmd === "feed") {
    return handlePublic({ method: "GET", route: cmd === "feed" ? "feed" : "status" }, LEDGER).body;
  }
  throw coded(`unknown mission command ${cmd}`, "COMMAND");
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv), null, 2)}\n`);
  } catch (error) {
    fail(error);
  }
}

module.exports = { main };
