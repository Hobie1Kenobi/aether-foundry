"use strict";

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const hosts = require("../xrpl-hosts");
const guard = require("../x402-outbound-guard");
const gov = require("../governance/policy");
const policy = require("./policy");
const discover = require("./discover");
const record = require("./record");

const ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const out = {
    dryRun: false,
    record: false,
    aeth: false,
    noRpc: false,
    drops: "",
    destination: "",
    reason: "",
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--aeth") out.aeth = true;
    else if (arg === "--no-rpc") out.noRpc = true;
    else if (arg === "--drops") {
      out.drops = args[i + 1] || "";
      i += 1;
    } else if (arg === "--destination") {
      out.destination = args[i + 1] || "";
      i += 1;
    } else if (arg === "--reason") {
      out.reason = args[i + 1] || "";
      i += 1;
    } else {
      throw policy.coded(`unknown flag ${arg}`, "ARGS");
    }
  }
  if (out.dryRun && out.record) {
    throw policy.coded("--record needs a submitted hash; omit it on --dry-run", "ARGS");
  }
  if (out.reason && !policy.REASONS.includes(out.reason)) {
    throw policy.coded(`unknown grant reason ${out.reason}`, "REASON");
  }
  if (out.destination) policy.assertClassic(out.destination, "--destination");
  if (out.drops && !/^[0-9]+$/.test(out.drops)) throw policy.coded("--drops must be an integer string", "DROPS");
  return out;
}

function loadEnvText(text) {
  const parsed = {};
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
    parsed[match[1]] = value;
  }
  return parsed;
}

function loadSignerSeed(env, io) {
  const file = (env && env.AETHER_SECRETS) || policy.SECRETS_PATH;
  const exists = (io && io.existsSync) || fs.existsSync;
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  const fromFile = exists(file) ? loadEnvText(readFile(file, "utf8")) : {};
  const merged = Object.assign({}, fromFile);
  for (const name of ["W6_REGULAR_SEED", "W6_SEED", "GRANTS_SEED"]) {
    if (env && env[name]) merged[name] = env[name];
  }
  if (merged.W6_REGULAR_SEED) return { mode: "regular", name: "W6_REGULAR_SEED", seed: merged.W6_REGULAR_SEED };
  if (merged.W6_SEED) return { mode: "master", name: "W6_SEED", seed: merged.W6_SEED };
  if (merged.GRANTS_SEED) return { mode: "master", name: "GRANTS_SEED", seed: merged.GRANTS_SEED };
  return null;
}

function readMotions(dir, io) {
  const exists = io.existsSync || fs.existsSync;
  const readDir = io.readdirSync || fs.readdirSync;
  const readFile = io.readFileSync || fs.readFileSync;
  if (!exists(dir)) return [];
  return readDir(dir)
    .filter((name) => gov.isMotionFile(name))
    .map((name) => ({ name, text: readFile(path.join(dir, name), "utf8") }));
}

function pathsFor(root) {
  return {
    root,
    ledgerPath: path.join(root, "lab", "ledger-log.jsonl"),
    grantsPath: path.join(root, "lab", "grants", "ledger.jsonl"),
    pnlPath: path.join(root, "market", "pnl.md"),
    resultsPath: path.join(root, "machines", "grants-flywheel", "RESULTS.md"),
    motionsDir: path.join(root, "lab", "motions"),
    activated: path.join(root, "machines", "governance-board", "activated.json"),
  };
}

function expectedRegular(file, io) {
  const readFile = (io && io.readFileSync) || fs.readFileSync;
  const raw = JSON.parse(readFile(file, "utf8"));
  const row = (raw.regular_keys || []).find((item) => item.id === "W6");
  if (!row || !policy.isClassic(row.regular_key)) {
    throw policy.coded("W6 regular key is missing from activated.json", "SIGNER");
  }
  if (row.account !== policy.W6) throw policy.coded("activated.json W6 account drifted", "SIGNER");
  return row.regular_key;
}

function safeError(error, seeds) {
  let message = error && error.message ? error.message : String(error || "grant failed");
  for (const seed of seeds || []) {
    if (seed && message.includes(seed)) message = message.split(seed).join("[redacted]");
  }
  if (/sEd[1-9A-HJ-NP-Za-km-z]{15,}/.test(message)) {
    return "grant failed (details omitted because they mentioned a seed)";
  }
  return message;
}

function renderPlan(result) {
  const lines = [];
  lines.push(result.dryRun ? "dry-run" : "pay");
  lines.push("signed false");
  lines.push("seed not loaded");
  lines.push(`network ${policy.NETWORK}`);
  lines.push(`payer ${policy.W6}`);
  lines.push(`default_drops ${policy.DEFAULT_DROPS}`);
  lines.push(`selectable ${result.report.selectable.length}`);
  result.report.selectable.forEach((row, index) => {
    lines.push(`${index + 1} ${row.address} ${row.reason}`);
  });
  if (!result.chosen) {
    lines.push("eligible 0");
    lines.push("no tx hash (not submitted)");
    return lines.join("\n");
  }
  lines.push(`destination ${result.chosen.address}`);
  lines.push(`reason ${result.chosen.reason}`);
  lines.push(`drops ${result.tx.Amount}`);
  const memos = policy.decodeMemos(result.tx);
  lines.push(`memo purpose ${memos.purpose}`);
  lines.push(`memo experiment ${memos.experiment}`);
  lines.push(`memo reason ${memos.reason}`);
  lines.push("tx Payment");
  lines.push(`account ${result.tx.Account}`);
  if (result.aethTx) {
    lines.push(`aeth ${result.aethTx.Amount.value}`);
    lines.push(`aeth_send_max ${result.aethTx.SendMax}`);
  } else if (result.aethSkipped) {
    lines.push("aeth skipped (no trust-line evidence on the chosen counterparty)");
  } else {
    lines.push("aeth skipped");
  }
  if (result.float) lines.push(`float ${result.float}`);
  lines.push("no tx hash (not submitted)");
  return lines.join("\n");
}

function floatStatus(w6, drops) {
  if (!w6 || w6.balance == null || w6.reserveBase == null || w6.reserveInc == null) return "unknown";
  try {
    policy.assertFloat(w6.balance, w6.ownerCount || 0, w6.reserveBase, w6.reserveInc, drops);
    return "ok";
  } catch (error) {
    if (error && error.code === "FLOAT") return "short";
    return "unknown";
  }
}

async function prepare(args, io) {
  const env = io.env || process.env;
  const root = io.root || ROOT;
  const files = io.paths || pathsFor(root);
  const readFile = io.readFileSync || fs.readFileSync;
  const exists = io.existsSync || fs.existsSync;
  const http = policy.assertTestnetUrl(hosts.resolveHttp(env));
  const labeled = io.labeled || guard.foundryIndex();
  if (args.destination && labeled.get(args.destination)) {
    throw policy.coded(
      `refusing Foundry wallet ${labeled.get(args.destination)} (${args.destination})`,
      "FOUNDRY"
    );
  }
  const ledgerText = exists(files.ledgerPath) ? readFile(files.ledgerPath, "utf8") : "";
  const grantsText = exists(files.grantsPath) ? readFile(files.grantsPath, "utf8") : "";
  const report = await discover.collect({
    ledgerText,
    grantsText,
    labeled,
    http,
    fetchImpl: io.fetchImpl || globalThis.fetch,
    now: io.now == null ? Date.now() : io.now,
    cooldownMs: io.cooldownMs,
    rpc: args.noRpc ? false : io.rpc !== false,
    payload: io.payload,
  });
  const chosen = discover.choose(report.selectable, args);
  if (args.destination && !chosen) {
    const cooled = report.excluded.some((row) => row.address === args.destination && row.why === "cooldown");
    if (cooled) {
      throw policy.coded(`refusing double-pay to ${args.destination} for ${args.reason || "the open reason"} inside the cooldown`, "COOLDOWN");
    }
    throw policy.coded(`${args.destination} is not an eligible non-Foundry counterparty`, "NONE");
  }
  const motions = io.motions || readMotions(files.motionsDir, { existsSync: exists, readdirSync: io.readdirSync || fs.readdirSync, readFileSync: readFile });
  const drops = policy.assertGrantDrops(args.drops || policy.DEFAULT_DROPS, chosen ? chosen.address : policy.W6, motions);
  let tx = null;
  let aethTx = null;
  let aethSkipped = false;
  if (chosen) {
    tx = policy.buildGrantPayment({
      destination: chosen.address,
      drops,
      reason: chosen.reason,
      motions,
    });
    if (args.aeth && chosen.reason === "aeth_counterparty") {
      aethTx = policy.buildAethGrantPayment({ destination: chosen.address, reason: chosen.reason });
    } else if (args.aeth) {
      aethSkipped = true;
    }
  }
  return {
    args,
    env,
    files,
    report,
    chosen,
    tx,
    aethTx,
    aethSkipped,
    drops,
    float: floatStatus(report.w6, drops),
    labeled,
  };
}

async function submitSigned(client, wallet, tx) {
  if (client.networkID === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
  const prepared = await client.autofill(tx);
  if (prepared.NetworkID === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
  const signed = wallet.sign(prepared);
  return client.submitAndWait(signed.tx_blob);
}

async function defaultAethPaths(client, destination) {
  const response = await client.request({
    command: "ripple_path_find",
    source_account: policy.W6,
    destination_account: destination,
    destination_amount: {
      currency: policy.AETH_HEX,
      issuer: policy.W0,
      value: policy.AETH_VALUE,
    },
    source_currencies: [{ currency: "XRP" }],
  });
  const result = (response && response.result) || response || {};
  return result.alternatives || [];
}

async function execute(argv, io) {
  const hooks = io || {};
  const args = parseArgs(argv);
  const env = hooks.env || process.env;
  if (!args.dryRun) policy.assertNotCi(env);
  const plan = await prepare(args, hooks);
  if (args.dryRun) {
    return {
      dryRun: true,
      seedLoaded: false,
      report: plan.report,
      chosen: plan.chosen,
      tx: plan.tx,
      aethTx: plan.aethTx,
      aethSkipped: plan.aethSkipped,
      float: plan.float,
      text: renderPlan({
        dryRun: true,
        report: plan.report,
        chosen: plan.chosen,
        tx: plan.tx,
        aethTx: plan.aethTx,
        aethSkipped: plan.aethSkipped,
        float: plan.float,
      }),
    };
  }
  if (!plan.chosen || !plan.tx) throw policy.coded("no eligible counterparty", "NONE");
  if (plan.float === "short") {
    throw policy.coded("W6 grant would breach the spendable float", "FLOAT");
  }
  if (grantPaidThisUtcDay(plan.report.paid, hooks.now == null ? Date.now() : hooks.now)) {
    throw policy.coded("refusing a second grant on this UTC day", "DAY");
  }
  if (plan.tx.Account !== policy.W6) throw policy.coded("grant Account must be W6", "PAYER");
  const ws = policy.assertWsUrl(hosts.resolveWs(env));
  const client = hooks.connect
    ? await hosts.withFailover(ws, async (url) => hooks.connect(policy.assertWsUrl(url)))
    : await hosts.openClient(ws, { networkId: policy.NETWORK_ID, assertUrl: (url) => policy.assertWsUrl(url) });
  let seeds = [];
  try {
    if (client.networkID === 0) throw policy.coded("refusing NetworkID 0", "MAINNET");
    policy.assertNetworkId(client.networkID);
    const loader = hooks.loadSeed || loadSignerSeed;
    const loaded = loader(env, hooks);
    if (!loaded || !loaded.seed) {
      throw policy.coded(
        "W6_REGULAR_SEED or W6_SEED is not loaded. Put it in AETHER_SECRETS or /workspace/aether-foundry-secrets/.env. Refusing to sign.",
        "NO_SEED"
      );
    }
    const walletFromSeed = hooks.walletFromSeed || ((seed) => xrpl.Wallet.fromSeed(seed));
    let wallet;
    try {
      wallet = walletFromSeed(loaded.seed);
    } catch {
      throw policy.coded(`${loaded.name} is not a usable seed`, "NO_SEED");
    }
    const signerAddress = wallet.classicAddress || wallet.address;
    if (loaded.mode === "regular") {
      const expected = hooks.regularKey || expectedRegular(plan.files.activated, hooks);
      if (signerAddress !== expected) {
        throw policy.coded("W6_REGULAR_SEED address is not the W6 regular key", "SIGNER");
      }
    } else if (signerAddress !== policy.W6) {
      throw policy.coded(`${loaded.name} address is not W6`, "SIGNER");
    }
    seeds = [loaded.seed];
    const info = hooks.accountInfo
      ? await hooks.accountInfo(client)
      : await client.request({ command: "account_info", account: policy.W6, ledger_index: "validated" });
    const data = (info.result && info.result.account_data) || info.account_data || {};
    if (loaded.mode === "regular" && data.RegularKey !== signerAddress) {
      throw policy.coded("on-ledger RegularKey does not match W6_REGULAR_SEED", "SIGNER");
    }
    const server = hooks.serverState
      ? await hooks.serverState(client)
      : await client.request({ command: "server_state" });
    const validated = ((server.result && server.result.state) || server.state || {}).validated_ledger || {};
    if (validated.reserve_base != null) {
      policy.assertFloat(data.Balance, Number(data.OwnerCount || 0), validated.reserve_base, validated.reserve_inc, plan.tx.Amount);
    }
    const submit = hooks.submit || submitSigned;
    const submitted = await submit(client, wallet, plan.tx);
    const view = gov.submittedView(submitted);
    if (view.result !== "tesSUCCESS" || !view.hash) {
      throw policy.coded(`payment result ${view.result || "missing"}`, "SUBMIT");
    }
    let aethHash = "";
    if (args.aeth && plan.aethTx) {
      try {
        const alternatives = hooks.pathFind
          ? await hooks.pathFind(client, plan.chosen.address)
          : await defaultAethPaths(client, plan.chosen.address);
        const found = policy.chooseAethPath(alternatives);
        if (found) {
          const aethTx = policy.buildAethGrantPayment({
            destination: plan.chosen.address,
            reason: plan.chosen.reason,
            sendMax: found.sendMax,
            paths: found.paths,
          });
          const aethSubmitted = await submit(client, wallet, aethTx);
          const aethView = gov.submittedView(aethSubmitted);
          if (aethView.result === "tesSUCCESS" && aethView.hash) aethHash = aethView.hash;
        }
      } catch {
        aethHash = "";
      }
    }
    const event = {
      ts: new Date(hooks.now == null ? Date.now() : hooks.now).toISOString(),
      action: "grant_paid",
      network: policy.NETWORK,
      network_id: policy.NETWORK_ID,
      experiment: policy.EXPERIMENT,
      payer: policy.W6,
      destination: plan.chosen.address,
      reason: plan.chosen.reason,
      amount_drops: plan.tx.Amount,
      hash: view.hash,
      result: "tesSUCCESS",
      ledger_index: view.ledger_index,
      signer: loaded.mode,
      aeth: Boolean(aethHash),
    };
    if (aethHash) event.aeth_hash = aethHash;
    const io = {
      existsSync: hooks.existsSync || fs.existsSync,
      readFileSync: hooks.readFileSync || fs.readFileSync,
      writeFileSync: hooks.writeFileSync || fs.writeFileSync,
      mkdirSync: hooks.mkdirSync || fs.mkdirSync,
    };
    const recorded = record.recordGrant(event, {
      io,
      grantsPath: plan.files.grantsPath,
      ledgerPath: plan.files.ledgerPath,
      pnlPath: plan.files.pnlPath,
      resultsPath: plan.files.resultsPath,
      root: plan.files.root,
      public: Boolean(args.record),
    });
    return {
      dryRun: false,
      seedLoaded: true,
      hash: view.hash,
      aethHash,
      signer: loaded.mode,
      destination: plan.chosen.address,
      reason: plan.chosen.reason,
      recorded,
      text: aethHash ? `paid ${view.hash} aeth ${aethHash}` : `paid ${view.hash}`,
    };
  } catch (error) {
    error.message = safeError(error, seeds);
    throw error;
  } finally {
    if (!hooks.connect && client && client.disconnect) await client.disconnect();
  }
}

async function executeScan(argv, io) {
  const args = parseArgs(argv.concat(["--dry-run"]));
  args.dryRun = true;
  const plan = await prepare(args, io || {});
  return {
    report: plan.report,
    text: discover.renderScan(plan.report),
  };
}

function grantPaidThisUtcDay(paid, now) {
  const clock = now == null ? Date.now() : now;
  const day = new Date(clock).toISOString().slice(0, 10);
  return (paid || []).some((row) => row && String(row.ts || "").startsWith(day));
}

function exitCode(error) {
  if (!error || !error.code) return 1;
  if (error.code === "FOUNDRY") return 2;
  if (error.code === "NONE") return 3;
  return 1;
}

async function mainPay(argv) {
  const args = parseArgs(argv);
  if (args.dryRun) {
    const result = await execute(argv, {});
    console.log(result.text);
    return;
  }
  const result = await execute(argv, {});
  console.log("payer", policy.W6);
  console.log("destination", result.destination);
  console.log("reason", result.reason);
  console.log("signer", result.signer);
  console.log(result.text);
  if (args.record) console.log("recorded", result.recorded.public === true);
}

async function mainScan(argv) {
  const result = await executeScan(argv, {});
  console.log(result.text);
}

module.exports = {
  parseArgs,
  loadSignerSeed,
  loadEnvText,
  readMotions,
  pathsFor,
  expectedRegular,
  safeError,
  renderPlan,
  prepare,
  execute,
  executeScan,
  grantPaidThisUtcDay,
  exitCode,
  mainPay,
  mainScan,
  ROOT,
};
