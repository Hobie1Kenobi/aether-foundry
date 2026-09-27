#!/usr/bin/env node
"use strict";

/**
 * W6 grants payer. Testnet only.
 *   npm run grants:scan
 *   npm run grants:pay -- --dry-run
 *   npm run grants:pay -- --record
 *
 * Prefers W6_REGULAR_SEED. Account stays W6. Seeds stay outside the repo.
 */

const engine = require("./engine");

if (require.main === module) {
  engine.mainPay(process.argv.slice(2)).catch((error) => {
    console.error(engine.safeError(error));
    process.exit(engine.exitCode(error));
  });
}

module.exports = engine;
