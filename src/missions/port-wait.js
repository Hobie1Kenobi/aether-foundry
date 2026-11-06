#!/usr/bin/env node
"use strict";

const net = require("net");
const { coded } = require("./ledger");

const DEDICATED_PORTS = new Set([8788, 8794]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid, killImpl) {
  const signal = killImpl || process.kill;
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

function listenProbe(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (free) => {
      server.removeAllListeners();
      if (free) server.close(() => resolve(true));
      else resolve(false);
    };
    server.once("error", () => finish(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => finish(true));
  });
}

async function releaseOwn(options) {
  const opts = options || {};
  const pid = Number(opts.pid);
  const port = Number(opts.port);
  if (!Number.isInteger(pid) || pid <= 1) throw coded("refusing to signal that pid", "PORT_BUSY");
  if (!DEDICATED_PORTS.has(port) && opts.allowPort !== true) {
    throw coded(`refusing to manage port ${port}`, "PORT_BUSY");
  }
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 10000;
  const stepMs = Number.isFinite(opts.stepMs) ? opts.stepMs : 250;
  const killImpl = opts.kill || process.kill;
  const probe = opts.probe || listenProbe;
  const deadline = Date.now() + waitMs;
  let termSent = false;
  while (Date.now() < deadline) {
    const alive = pidAlive(pid, killImpl);
    if (alive && opts.signal !== false) {
      try {
        killImpl(pid, termSent && Date.now() > deadline - 2000 ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (!error || error.code !== "ESRCH") throw coded("could not signal the dedicated pid", "PORT_BUSY");
      }
      termSent = true;
    }
    if (!pidAlive(pid, killImpl)) {
      const free = await probe(port);
      if (free) return { released: true, pid, port };
      throw coded(`127.0.0.1:${port} is still in use after pid ${pid} exited. Not killing it.`, "PORT_BUSY");
    }
    await (opts.sleep || sleep)(stepMs);
  }
  throw coded(`pid ${pid} did not exit before the wait ended`, "PORT_BUSY");
}

async function assertFree(port, probe) {
  const check = probe || listenProbe;
  if (!DEDICATED_PORTS.has(Number(port))) throw coded(`refusing to manage port ${port}`, "PORT_BUSY");
  const free = await check(Number(port));
  if (!free) throw coded(`127.0.0.1:${port} is in use. Not killing it.`, "PORT_BUSY");
  return { free: true, port: Number(port) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const pidFlag = args.indexOf("--pid");
  const portFlag = args.indexOf("--port");
  const checkOnly = args.includes("--check");
  const port = portFlag === -1 ? 0 : Number(args[portFlag + 1]);
  const run = checkOnly
    ? assertFree(port)
    : releaseOwn({ pid: pidFlag === -1 ? 0 : Number(args[pidFlag + 1]), port });
  run
    .then((body) => {
      process.stdout.write(`${JSON.stringify(body)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "PORT_BUSY"}\n`);
      process.exit(1);
    });
}

module.exports = { DEDICATED_PORTS, releaseOwn, assertFree, listenProbe };
