"use strict";

const fs = require("fs");
const path = require("path");

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "events.jsonl");
}

function readEvents(dir) {
  const file = ensure(dir);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "ledger.torn", counted: false });
    }
  }
  return events;
}

function appendEvents(dir, events) {
  const file = ensure(dir);
  const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return events;
}

function appendEvent(dir, event) {
  appendEvents(dir, [event]);
  return event;
}

function exclusive(dir, fn) {
  ensure(dir);
  const lock = path.join(dir, "lock");
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (Date.now() - start > 8000) throw coded("mission ledger lock timed out", "LOCK");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  try {
    return fn({
      read: () => readEvents(dir),
      append: (event) => appendEvent(dir, event),
      appendAll: (events) => appendEvents(dir, events),
    });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

module.exports = {
  coded,
  readEvents,
  appendEvents,
  exclusive,
};
