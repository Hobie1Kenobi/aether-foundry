"use strict";

const { startMission } = require("./engine");

const dir = process.argv[2];
const input = JSON.parse(process.argv[3]);
const opts = JSON.parse(process.argv[4]);
try {
  const result = startMission(dir, input, opts);
  process.stdout.write(JSON.stringify({ ok: true, code: result.mission.code, status: result.mission.status }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || "ERROR" }));
}
