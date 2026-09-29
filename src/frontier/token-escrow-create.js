#!/usr/bin/env node
"use strict";

/**
 * F3 TokenEscrow create. Dry-run is the default.
 *   npm run frontier:token-escrow-create
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:token-escrow-create -- --live
 */

const policy = require("../runtime/policy");
const escrow = require("./token-escrow-labor");

function run(argv, deps) {
  return escrow.runCommand(argv, deps, "create");
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      console.error(`${code}: ${policy.redact(error && error.message)}`);
      process.exit(1);
    });
}

module.exports = {
  HELP: escrow.HELP.create,
  run,
};
