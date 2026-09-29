#!/usr/bin/env node
"use strict";

/**
 * F8 Sponsor (XLS-68) on XRPL Devnet. Dry-run is the default.
 * D0 creates a new D2 with tfSponsorCreatedAccount, then co-signs a
 * DepositPreauth so D2 holds an object without the full reserve.
 *
 *   npm run frontier:devnet-sponsor
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step create
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-sponsor -- --live --step object
 */

const grants = require("../grants/policy");
const policy = require("../runtime/policy");
const guard = require("./devnet-guard");

const AMENDMENTS = ["Sponsor"];
const TF_SPONSOR_CREATED_ACCOUNT = 0x00080000;
const SPF_SPONSOR_FEE = 0x00000001;
const SPF_SPONSOR_RESERVE = 0x00000002;
const CREATE_DROPS = "1";
const STEPS = ["create", "object"];

const HELP = `Usage: node src/frontier/devnet-sponsor.js [--dry-run] [--live --step create|object]
       [--d0 ADDRESS] [--d2 ADDRESS] [--xrpl-http URL]

--dry-run is the default. It prints unsigned transactions and does not read D0_SEED or D2_SEED.
--live requires FOUNDRY_DAEMON_LIVE=yes, one --step, and network id 2.
D2 must be a new unfunded Devnet account, not a Testnet labeled wallet.
create: Payment Amount "${CREATE_DROPS}" with tfSponsorCreatedAccount.
object: DepositPreauth from D2, Sponsor D0, spfSponsorFee|spfSponsorReserve.`;

function coded(message, code) {
  return guard.coded(message, code);
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw coded("pass only one of --dry-run or --live", "ARGS");
  }
  const out = {
    dryRun: !args.includes("--live"),
    live: args.includes("--live"),
    help: args.includes("--help") || args.includes("-h"),
    step: null,
    d0: null,
    d2: null,
    xrplHttp: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run" || arg === "--live" || arg === "--help" || arg === "-h") continue;
    if (arg === "--step" || arg === "--d0" || arg === "--d2" || arg === "--xrpl-http") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw coded(`${arg} needs a value`, "ARGS");
      i += 1;
      if (arg === "--step") out.step = value;
      else if (arg === "--d0") out.d0 = value;
      else if (arg === "--d2") out.d2 = value;
      else out.xrplHttp = value;
    } else throw coded(`unknown arg ${arg}`, "ARGS");
  }
  if (out.step && !STEPS.includes(out.step)) throw coded(`unknown step ${out.step}`, "ARGS");
  if (out.live && !out.step) throw coded("pass --step with --live", "ARGS");
  return out;
}

function memos(purpose) {
  return [grants.memo("purpose", purpose), grants.memo("experiment", "devnet-sponsor"), grants.memo("network", "XRPL Devnet")];
}

function accountsOf(env, mode) {
  const d0 = guard.addressFrom(env, "D0", mode.d0);
  const d2 = guard.addressFrom(env, "D2", mode.d2);
  guard.assertDistinct([
    ["D0", d0],
    ["D2", d2],
  ]);
  return { d0, d2 };
}

function buildCreate(d0, d2) {
  const tx = {
    TransactionType: "Payment",
    Account: d0,
    Destination: d2,
    Amount: CREATE_DROPS,
    Flags: TF_SPONSOR_CREATED_ACCOUNT,
    Memos: memos("aether-devnet-sponsor-create"),
  };
  if (tx.Flags !== TF_SPONSOR_CREATED_ACCOUNT) throw coded("create flag drifted", "FLAGS");
  if (tx.Amount !== "1") throw coded("sponsored account create delivers 1 drop", "AMOUNT");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildObject(d0, d2) {
  const tx = {
    TransactionType: "DepositPreauth",
    Account: d2,
    Authorize: d0,
    Sponsor: d0,
    SponsorFlags: SPF_SPONSOR_FEE | SPF_SPONSOR_RESERVE,
    Memos: memos("aether-devnet-sponsor-object"),
  };
  if ((tx.SponsorFlags & SPF_SPONSOR_RESERVE) === 0) throw coded("object reserve is not sponsored", "FLAGS");
  if ((tx.SponsorFlags & SPF_SPONSOR_FEE) === 0) throw coded("object fee is not sponsored", "FLAGS");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function stepBody(name, tx, ready, reason) {
  return {
    step: name,
    ready: ready === true,
    reason: reason || null,
    tx: ready ? tx : null,
  };
}

async function plan(opts) {
  const options = opts || {};
  const mode = options.mode || {};
  const env = options.env || {};
  let ledger = null;
  try {
    ledger = await guard.loadAmendments({
      env,
      xrplHttp: mode.xrplHttp || options.xrplHttp || null,
      fetchImpl: options.fetchImpl,
      names: AMENDMENTS,
    });
    const accounts = accountsOf(env, mode);
    const steps = [
      stepBody("create", buildCreate(accounts.d0, accounts.d2), true, "D0 sponsors the new D2 account reserve"),
      stepBody(
        "object",
        buildObject(accounts.d0, accounts.d2),
        true,
        "D2 holds a DepositPreauth; D0 co-signs fee and object reserve on --live"
      ),
    ];
    return {
      allow: true,
      code: "DRY_RUN",
      message: "unsigned Sponsor sequence for a new D2 account",
      http: ledger.http,
      network: ledger.network,
      network_id: ledger.network_id,
      build_version: ledger.build_version,
      amendments: ledger.amendments,
      accounts,
      steps: mode.step ? steps.filter((row) => row.step === mode.step) : steps,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return {
      allow: false,
      code: (error && error.code) || "REFUSED",
      message: error && error.message ? error.message : String(error),
      http: ledger && ledger.http ? ledger.http : null,
      network: guard.NETWORK,
      network_id: guard.NETWORK_ID,
      build_version: ledger && ledger.build_version ? ledger.build_version : null,
      amendments: null,
      accounts: null,
      steps: [],
    };
  }
}

function publicBody(mode, draft, seedReads) {
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: ["D0_SEED", "D2_SEED"],
    network: guard.NETWORK,
    network_id: draft.network_id,
    action: "devnet_sponsor",
    intent: "devnet_sponsor",
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendments: draft.amendments,
    accounts: draft.accounts,
    steps: draft.steps,
    signer: "Devnet D0_SEED and D2_SEED; not the Testnet agent allowlist",
  };
}

async function liveStep(draft, mode, env, loadSeed, deps) {
  const step = draft.steps.find((row) => row.step === mode.step);
  if (!draft.allow || !step || !step.tx) throw coded(draft.message || `${mode.step} is not ready`, draft.code || "REFUSED");
  const options = deps || {};
  const ctx = {
    env,
    networkId: draft.network_id,
    http: draft.http,
    xrplHttp: mode.xrplHttp,
    client: options.client,
    xrpl: options.xrpl,
  };
  if (options.submit) return options.submit(step.tx, mode.step, ctx);
  const xrpl = options.xrpl || require("xrpl");
  if (mode.step === "create") {
    const seed = loadSeed(guard.SEED_ENV.D0);
    return guard.submitAutofill(step.tx, seed, draft.accounts.d0, ctx);
  }
  const d0Seed = loadSeed(guard.SEED_ENV.D0);
  const d2Seed = loadSeed(guard.SEED_ENV.D2);
  return guard.withDevnetClient(ctx, async ({ client }) => {
    const prepared = guard.assertPrepared(await client.autofill(step.tx));
    const sponsee = guard.walletFromSeed(xrpl, d2Seed, draft.accounts.d2);
    const sponsor = guard.walletFromSeed(xrpl, d0Seed, draft.accounts.d0);
    const first = sponsee.sign(prepared);
    const cosigned = xrpl.signAsSponsor(sponsor, first.tx_blob);
    return guard.readEngine(await client.submitAndWait(cosigned.tx_blob));
  });
}

async function run(argv, deps) {
  const options = deps || {};
  const mode = parseArgs(argv);
  const write = options.stdout || ((text) => console.log(text));
  if (mode.help) {
    write(HELP);
    return 0;
  }
  const env = options.env || process.env;
  const root = options.root || require("../director/anchors").repoRoot();
  let seedReads = 0;
  const loadSeed = (name) => {
    seedReads += 1;
    if (!mode.live) throw coded("dry-run read a seed", "SEED");
    const reader = options.loadSeed || ((key) => guard.readSeed(key, env, options.io));
    return reader(name);
  };
  if (mode.live) policy.assertLiveGate(env);
  const draft = await plan({ env, mode, fetchImpl: options.fetchImpl });
  if (!mode.live) {
    const body = publicBody(mode, draft, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    return draft.allow ? 0 : 2;
  }
  const submitted = await liveStep(draft, mode, env, loadSeed, options);
  const row = guard.archiveDevnet(root, {
    ts: (options.now || new Date()).toISOString(),
    action: "devnet_sponsor",
    step: mode.step,
    network: guard.NETWORK,
    network_id: guard.NETWORK_ID,
    account: mode.step === "object" ? draft.accounts.d2 : draft.accounts.d0,
    sponsor: draft.accounts.d0,
    sponsee: draft.accounts.d2,
    hash: submitted.hash,
    result: submitted.result,
    ledger_index: submitted.ledger_index,
  });
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    network: guard.NETWORK,
    network_id: guard.NETWORK_ID,
    action: "devnet_sponsor",
    step: mode.step,
    allow: true,
    code: "SUBMITTED",
    hash: row.hash,
    ledger_index: row.ledger_index,
    result: "tesSUCCESS",
  };
  policy.assertNoSeedFields(body);
  const text = JSON.stringify(body, null, 2);
  policy.assertPrintSafe(text);
  write(text);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const code = error && error.code ? error.code : "FATAL";
      console.error(`${code}: ${policy.redact(error && error.message)}`);
      process.exit(1);
    });
}

module.exports = {
  HELP,
  AMENDMENTS,
  TF_SPONSOR_CREATED_ACCOUNT,
  SPF_SPONSOR_FEE,
  SPF_SPONSOR_RESERVE,
  CREATE_DROPS,
  STEPS,
  parseArgs,
  buildCreate,
  buildObject,
  plan,
  run,
};
