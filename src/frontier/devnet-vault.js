#!/usr/bin/env node
"use strict";

/**
 * F9 SingleAssetVault + LendingProtocol on XRPL Devnet. Dry-run is the default.
 * Asset is XRP. LendingProtocolV1_1 forces cash-basis and a closed-ended vault.
 * First-loss cover is D0 Devnet XRP, not Testnet W6.
 *
 *   npm run frontier:devnet-vault
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-vault -- --live --step create
 */

const grants = require("../grants/policy");
const policy = require("../runtime/policy");
const { rippleNow, rippleToUnix } = require("../time/rippleEpoch");
const { rpcCall } = require("../director/snapshot");
const guard = require("./devnet-guard");

const AMENDMENTS = ["SingleAssetVault", "LendingProtocol", "LendingProtocolV1_1"];
const VAULT_KIND_CLOSED = 1;
const WITHDRAWAL_FIRST_COME = 1;
const SUBSCRIPTION_DELAY_SEC = 180;
const INVESTMENT_SPAN_SEC = 3600;
const DEPOSIT_DROPS = "5000000";
const ASSETS_MAXIMUM = "10000000";
const PRINCIPAL_DROPS = "1000000";
const COVER_DROPS = "200000";
const COVER_RATE_MINIMUM = 10000;
const COVER_RATE_LIQUIDATION = 100000;
const INTEREST_RATE = 1000;
const PAYMENT_TOTAL = 1;
const PAYMENT_INTERVAL = 600;
const GRACE_PERIOD = 60;
const TF_LOAN_DEFAULT = 0x00010000;
const STEPS = ["create", "deposit", "broker", "cover", "loan", "repay", "default"];

const HELP = `Usage: node src/frontier/devnet-vault.js [--dry-run] [--live --step STEP]
       [--d0 ADDRESS] [--d1 ADDRESS] [--xrpl-http URL]
       [--vault-id HEX] [--broker-id HEX] [--loan-id HEX] [--amount DROPS]

--dry-run is the default. It does not read D0_SEED or D1_SEED.
--live requires FOUNDRY_DAEMON_LIVE=yes, one --step, and network id 2.
Steps: ${STEPS.join(", ")}.
The vault asset is XRP. The Testnet AETH-LABOR issuance id is refused.
LendingProtocolV1_1 selects cash-basis (LEVersion 1). This pack does not book accrual.
LoanSet is closed-ended: wait until SubscriptionDate before --step loan.
--step repay reads Loan.PeriodicPayment unless --amount is set.
--step default builds LoanManage tfLoanDefault. The ledger rejects it until grace has passed.`;

function coded(message, code) {
  return guard.coded(message, code);
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) throw coded("pass only one of --dry-run or --live", "ARGS");
  const out = {
    dryRun: !args.includes("--live"),
    live: args.includes("--live"),
    help: args.includes("--help") || args.includes("-h"),
    step: null,
    d0: null,
    d1: null,
    xrplHttp: null,
    vaultId: null,
    brokerId: null,
    loanId: null,
    amount: null,
  };
  const valued = ["--step", "--d0", "--d1", "--xrpl-http", "--vault-id", "--broker-id", "--loan-id", "--amount"];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run" || arg === "--live" || arg === "--help" || arg === "-h") continue;
    if (!valued.includes(arg)) throw coded(`unknown arg ${arg}`, "ARGS");
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw coded(`${arg} needs a value`, "ARGS");
    i += 1;
    if (arg === "--step") out.step = value;
    else if (arg === "--d0") out.d0 = value;
    else if (arg === "--d1") out.d1 = value;
    else if (arg === "--xrpl-http") out.xrplHttp = value;
    else if (arg === "--vault-id") out.vaultId = value;
    else if (arg === "--broker-id") out.brokerId = value;
    else if (arg === "--loan-id") out.loanId = value;
    else out.amount = value;
  }
  if (out.step && !STEPS.includes(out.step)) throw coded(`unknown step ${out.step}`, "ARGS");
  if (out.live && !out.step) throw coded("pass --step with --live", "ARGS");
  if (out.amount != null && !/^\d+$/.test(out.amount)) throw coded("--amount must be integer drops", "AMOUNT");
  return out;
}

function memos(purpose) {
  return [grants.memo("purpose", purpose), grants.memo("experiment", "devnet-vault"), grants.memo("network", "XRPL Devnet")];
}

function xrpAsset() {
  const asset = { currency: "XRP" };
  guard.assertNotLaborIssuance(asset.mpt_issuance_id, "vault asset");
  if (asset.currency !== "XRP" || asset.issuer) throw coded("vault asset must be XRP", "ASSET");
  return asset;
}

function vaultWindow(now) {
  const clock = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const subscription = rippleNow(clock) + SUBSCRIPTION_DELAY_SEC;
  const redemption = subscription + INVESTMENT_SPAN_SEC;
  if (redemption - subscription < 180) throw coded("vault window is shorter than 180 seconds", "WINDOW");
  if (subscription >= 1e12) throw coded("vault dates look like Unix seconds", "WINDOW");
  return {
    vault_kind: VAULT_KIND_CLOSED,
    subscription_date: subscription,
    redemption_date: redemption,
    subscription_unix: rippleToUnix(subscription),
    redemption_unix: rippleToUnix(redemption),
    accounting: "cash-basis",
    le_version: 1,
    accounting_note:
      "LendingProtocolV1_1 is enabled, so VaultCreate records cash-basis (LEVersion 1). Interest is recognized when a payment delivers it. This pack does not set an accrual model.",
  };
}

function accountsOf(env, mode) {
  const d0 = guard.addressFrom(env, "D0", mode.d0);
  const d1 = guard.addressFrom(env, "D1", mode.d1);
  guard.assertDistinct([
    ["D0", d0],
    ["D1", d1],
  ]);
  return { d0, d1 };
}

function optionalHash(value, label) {
  if (value == null || value === "") return null;
  return guard.assertHashId(value, label);
}

function buildCreate(d0, now) {
  const window = vaultWindow(now);
  const tx = {
    TransactionType: "VaultCreate",
    Account: d0,
    Asset: xrpAsset(),
    AssetsMaximum: ASSETS_MAXIMUM,
    VaultKind: window.vault_kind,
    SubscriptionDate: window.subscription_date,
    RedemptionDate: window.redemption_date,
    WithdrawalPolicy: WITHDRAWAL_FIRST_COME,
    Data: Buffer.from("foundry-devnet-xrp-vault", "utf8").toString("hex").toUpperCase(),
    Memos: memos("aether-devnet-vault-create"),
  };
  if (Object.prototype.hasOwnProperty.call(tx, "Scale")) throw coded("XRP vault must not set Scale", "ASSET");
  if (tx.Asset.mpt_issuance_id) throw coded("refusing an MPT vault in this pack", "ASSET");
  guard.assertNoProofMaterial(tx);
  return { tx, window };
}

function buildDeposit(d1, vaultId) {
  const tx = {
    TransactionType: "VaultDeposit",
    Account: d1,
    VaultID: guard.assertHashId(vaultId, "vault id"),
    Amount: DEPOSIT_DROPS,
    Memos: memos("aether-devnet-vault-deposit"),
  };
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildBroker(d0, vaultId) {
  const tx = {
    TransactionType: "LoanBrokerSet",
    Account: d0,
    VaultID: guard.assertHashId(vaultId, "vault id"),
    ManagementFeeRate: 0,
    DebtMaximum: ASSETS_MAXIMUM,
    CoverRateMinimum: COVER_RATE_MINIMUM,
    CoverRateLiquidation: COVER_RATE_LIQUIDATION,
    Data: Buffer.from("foundry-devnet-broker", "utf8").toString("hex").toUpperCase(),
    Memos: memos("aether-devnet-vault-broker"),
  };
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildCover(d0, brokerId) {
  const tx = {
    TransactionType: "LoanBrokerCoverDeposit",
    Account: d0,
    LoanBrokerID: guard.assertHashId(brokerId, "broker id"),
    Amount: COVER_DROPS,
    Memos: memos("aether-devnet-vault-cover"),
  };
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildLoan(d0, d1, brokerId) {
  const tx = {
    TransactionType: "LoanSet",
    Account: d0,
    Counterparty: d1,
    LoanBrokerID: guard.assertHashId(brokerId, "broker id"),
    PrincipalRequested: PRINCIPAL_DROPS,
    InterestRate: INTEREST_RATE,
    PaymentTotal: PAYMENT_TOTAL,
    PaymentInterval: PAYMENT_INTERVAL,
    GracePeriod: GRACE_PERIOD,
    Memos: memos("aether-devnet-vault-loan"),
  };
  if (tx.GracePeriod < 60 || tx.GracePeriod > tx.PaymentInterval) {
    throw coded("loan grace is outside the protocol range", "WINDOW");
  }
  guard.assertNoProofMaterial(tx);
  return tx;
}

function ceilDrops(periodic) {
  const text = String(periodic == null ? "" : periodic).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw coded("PeriodicPayment is not a number", "AMOUNT");
  const [whole, frac] = text.split(".");
  const bumps = frac && /[1-9]/.test(frac);
  const drops = BigInt(whole) + (bumps ? 1n : 0n);
  if (drops <= 0n) throw coded("PeriodicPayment rounds to zero", "AMOUNT");
  return drops.toString();
}

function buildRepay(d1, loanId, amount) {
  const tx = {
    TransactionType: "LoanPay",
    Account: d1,
    LoanID: guard.assertHashId(loanId, "loan id"),
    Amount: amount,
    Memos: memos("aether-devnet-vault-repay"),
  };
  if (!/^\d+$/.test(tx.Amount)) throw coded("repay amount must be integer drops", "AMOUNT");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildDefault(d0, loanId) {
  const tx = {
    TransactionType: "LoanManage",
    Account: d0,
    LoanID: guard.assertHashId(loanId, "loan id"),
    Flags: TF_LOAN_DEFAULT,
    Memos: memos("aether-devnet-vault-default"),
  };
  if (tx.Flags !== TF_LOAN_DEFAULT) throw coded("default flag drifted", "FLAGS");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function ready(name, tx, reason) {
  return { step: name, ready: true, reason, tx };
}

function held(name, reason) {
  return { step: name, ready: false, reason, tx: null };
}

async function repayAmount(opts, loanId, amount) {
  if (amount) return { amount, source: "--amount" };
  if (!loanId) return null;
  const entry = await rpcCall(
    opts.http,
    "ledger_entry",
    { index: loanId, ledger_index: "validated" },
    opts.fetchImpl || globalThis.fetch
  );
  const node = entry && (entry.node || entry);
  const periodic = node && node.PeriodicPayment;
  if (periodic == null) throw coded("Loan entry omitted PeriodicPayment", "AMOUNT");
  return { amount: ceilDrops(periodic), source: "Loan.PeriodicPayment", periodic: String(periodic) };
}

async function plan(opts) {
  const options = opts || {};
  const mode = options.mode || {};
  const env = options.env || {};
  const now = options.now || new Date();
  let ledger = null;
  try {
    ledger = await guard.loadAmendments({
      env,
      xrplHttp: mode.xrplHttp || null,
      fetchImpl: options.fetchImpl,
      names: AMENDMENTS,
    });
    const accounts = accountsOf(env, mode);
    const vaultId = optionalHash(mode.vaultId, "vault id");
    const brokerId = optionalHash(mode.brokerId, "broker id");
    const loanId = optionalHash(mode.loanId, "loan id");
    const created = buildCreate(accounts.d0, now);
    let payment = null;
    if (loanId && (mode.step == null || mode.step === "repay")) {
      payment = await repayAmount(
        { http: ledger.http, fetchImpl: options.fetchImpl },
        loanId,
        mode.amount
      );
    } else if (mode.amount && loanId) {
      payment = { amount: mode.amount, source: "--amount" };
    }
    const steps = [
      ready("create", created.tx, created.window.accounting_note),
      vaultId
        ? ready("deposit", buildDeposit(accounts.d1, vaultId), `D1 deposits ${DEPOSIT_DROPS} drops`)
        : held("deposit", "vault id is unknown until VaultCreate tesSUCCESS"),
      vaultId
        ? ready("broker", buildBroker(accounts.d0, vaultId), "LoanBrokerSet on the XRP vault")
        : held("broker", "vault id is unknown until VaultCreate tesSUCCESS"),
      brokerId
        ? ready("cover", buildCover(accounts.d0, brokerId), `first-loss ${COVER_DROPS} drops from D0, not Testnet W6`)
        : held("cover", "broker id is unknown until LoanBrokerSet tesSUCCESS"),
      brokerId
        ? ready("loan", buildLoan(accounts.d0, accounts.d1, brokerId), "D0 signs first; D1 counter-signs on --live. Wait for SubscriptionDate.")
        : held("loan", "broker id is unknown until LoanBrokerSet tesSUCCESS"),
      loanId && payment
        ? ready("repay", buildRepay(accounts.d1, loanId, payment.amount), `amount ${payment.amount} drops from ${payment.source}`)
        : held("repay", "loan id is unknown until LoanSet tesSUCCESS; amount comes from PeriodicPayment or --amount"),
      loanId
        ? ready("default", buildDefault(accounts.d0, loanId), "tfLoanDefault. The ledger returns tecTOO_SOON until grace passes.")
        : held("default", "loan id is unknown until LoanSet tesSUCCESS"),
    ];
    return {
      allow: true,
      code: "DRY_RUN",
      message: "unsigned XRP vault, cash-basis because LendingProtocolV1_1 is enabled",
      http: ledger.http,
      network: ledger.network,
      network_id: ledger.network_id,
      build_version: ledger.build_version,
      amendments: ledger.amendments,
      accounts,
      accounting: created.window.accounting,
      window: created.window,
      cover_source: "D0 Devnet XRP via LoanBrokerCoverDeposit. Not Testnet W6.",
      terms: {
        principal_drops: PRINCIPAL_DROPS,
        deposit_drops: DEPOSIT_DROPS,
        cover_drops: COVER_DROPS,
        cover_rate_minimum: COVER_RATE_MINIMUM,
        interest_rate_tenth_bps: INTEREST_RATE,
        payment_total: PAYMENT_TOTAL,
        payment_interval_sec: PAYMENT_INTERVAL,
        grace_period_sec: GRACE_PERIOD,
      },
      steps: mode.step ? steps.filter((row) => row.step === mode.step) : steps,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return {
      allow: false,
      code: (error && error.code) || "REFUSED",
      message: error && error.message ? error.message : String(error),
      http: ledger && ledger.http,
      network: guard.NETWORK,
      network_id: guard.NETWORK_ID,
      build_version: null,
      amendments: null,
      accounts: null,
      accounting: null,
      window: null,
      cover_source: "D0 Devnet XRP via LoanBrokerCoverDeposit. Not Testnet W6.",
      terms: null,
      steps: [],
    };
  }
}

function signerFor(step) {
  if (step === "deposit" || step === "repay") return { env: guard.SEED_ENV.D1, id: "d1" };
  return { env: guard.SEED_ENV.D0, id: "d0" };
}

function publicBody(mode, draft, seedReads) {
  return {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: ["D0_SEED", "D1_SEED"],
    network: guard.NETWORK,
    network_id: draft.network_id,
    action: "devnet_vault",
    intent: "devnet_vault",
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendments: draft.amendments,
    accounting: draft.accounting,
    window: draft.window,
    cover_source: draft.cover_source,
    terms: draft.terms,
    accounts: draft.accounts,
    steps: draft.steps,
    signer: "Devnet D0_SEED and D1_SEED; not the Testnet agent allowlist",
  };
}

async function liveStep(draft, mode, env, loadSeed, deps) {
  const step = draft.steps.find((row) => row.step === mode.step);
  if (!draft.allow || !step || !step.ready || !step.tx) {
    throw coded((step && step.reason) || draft.message || `${mode.step} is not ready`, "REFUSED");
  }
  const options = deps || {};
  const ctx = {
    env,
    networkId: draft.network_id,
    http: draft.http,
    xrplHttp: mode.xrplHttp,
    client: options.client,
    xrpl: options.xrpl,
  };
  if (options.submit && mode.step !== "loan") return options.submit(step.tx, mode.step, ctx);
  const xrpl = options.xrpl || require("xrpl");
  if (mode.step !== "loan") {
    const who = signerFor(mode.step);
    const seed = loadSeed(who.env);
    return guard.submitAutofill(step.tx, seed, draft.accounts[who.id], ctx);
  }
  const d0Seed = loadSeed(guard.SEED_ENV.D0);
  const d1Seed = loadSeed(guard.SEED_ENV.D1);
  return guard.withDevnetClient(ctx, async ({ client }) => {
    const prepared = guard.assertPrepared(await client.autofill(step.tx));
    const broker = guard.walletFromSeed(xrpl, d0Seed, draft.accounts.d0);
    const borrower = guard.walletFromSeed(xrpl, d1Seed, draft.accounts.d1);
    const first = broker.sign(prepared);
    const cosigned = xrpl.signLoanSetByCounterparty(borrower, first.tx_blob);
    return guard.readEngine(await client.submitAndWait(cosigned.tx_blob));
  });
}

function idFrom(step, submitted) {
  const meta = submitted.meta || {};
  if (step === "create") return guard.createdIndex(meta, "Vault") || guard.metaHash(meta, ["vault_id", "VaultID"]);
  if (step === "broker") return guard.createdIndex(meta, "LoanBroker") || guard.metaHash(meta, ["loan_broker_id", "LoanBrokerID"]);
  if (step === "loan") return guard.createdIndex(meta, "Loan") || guard.metaHash(meta, ["loan_id", "LoanID"]);
  return null;
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
  const draft = await plan({ env, mode, now: options.now, fetchImpl: options.fetchImpl });
  if (!mode.live) {
    const body = publicBody(mode, draft, seedReads);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    const requested = mode.step ? (draft.steps[0] && draft.steps[0].ready) : draft.allow;
    return requested && draft.allow ? 0 : 2;
  }
  const submitted = await liveStep(draft, mode, env, loadSeed, options);
  const objectId = idFrom(mode.step, submitted);
  const row = guard.archiveDevnet(root, {
    ts: (options.now || new Date()).toISOString(),
    action: "devnet_vault",
    step: mode.step,
    network: guard.NETWORK,
    network_id: guard.NETWORK_ID,
    account: signerFor(mode.step).id === "d1" ? draft.accounts.d1 : draft.accounts.d0,
    accounting: "cash-basis",
    asset: "XRP",
    cover_source: "D0",
    object_id: objectId,
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
    action: "devnet_vault",
    step: mode.step,
    accounting: "cash-basis",
    allow: true,
    code: "SUBMITTED",
    hash: row.hash,
    object_id: objectId,
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
  STEPS,
  DEPOSIT_DROPS,
  PRINCIPAL_DROPS,
  COVER_DROPS,
  COVER_RATE_MINIMUM,
  INTEREST_RATE,
  TF_LOAN_DEFAULT,
  VAULT_KIND_CLOSED,
  parseArgs,
  vaultWindow,
  xrpAsset,
  ceilDrops,
  buildCreate,
  buildDeposit,
  buildBroker,
  buildCover,
  buildLoan,
  buildRepay,
  buildDefault,
  plan,
  run,
};
