#!/usr/bin/env node
"use strict";

const engine = require("./engine");

if (require.main === module) {
  engine.mainScan(process.argv.slice(2)).catch((error) => {
    console.error(engine.safeError(error));
    process.exit(engine.exitCode(error));
  });
}
