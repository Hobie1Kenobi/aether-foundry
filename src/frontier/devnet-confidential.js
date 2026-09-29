#!/usr/bin/env node
"use strict";

/**
 * F10 confidential MPT on XRPL Devnet. Dry-run is the default.
 * DynamicMPT ImmutableFlags plus ConfidentialTransfer.
 * Proof-bearing transactions are built only on --live by xrpl.js.
 * This module does not invent a ZKProof or a ciphertext.
 *
 *   npm run frontier:devnet-confidential
 *   FOUNDRY_DAEMON_LIVE=yes npm run frontier:devnet-confidential -- --live --step issue
 */

const grants = require("../grants/policy");
const policy = require("../runtime/policy");
const guard = require("./devnet-guard");

const AMENDMENTS = ["DynamicMPT", "ConfidentialTransfer", "MPTokensV1"];
const TF_MPT_CAN_LOCK = 0x00000002;
const TF_MPT_CAN_TRANSFER = 0x00000020;
const TF_MPT_CAN_CLAWBACK = 0x00000040;
const TF_MPT_CAN_HOLD_CONFIDENTIAL = 0x00000080;
const TIF_MPT_CAN_LOCK = 0x00000002;
const TIF_MPT_CAN_TRANSFER = 0x00000020;
const TIF_MPT_CAN_CLAWBACK = 0x00000040;
const TIF_MPT_CAN_HOLD_CONFIDENTIAL = 0x00000080;
const TF_MPT_LOCK = 0x00000001;
const ISSUANCE_FLAGS =
  TF_MPT_CAN_LOCK | TF_MPT_CAN_TRANSFER | TF_MPT_CAN_CLAWBACK | TF_MPT_CAN_HOLD_CONFIDENTIAL;
const IMMUTABLE_FLAGS =
  TIF_MPT_CAN_LOCK | TIF_MPT_CAN_TRANSFER | TIF_MPT_CAN_CLAWBACK | TIF_MPT_CAN_HOLD_CONFIDENTIAL;
const MAXIMUM_AMOUNT = "1000000";
const PUBLIC_SENDER = "100";
const PUBLIC_D3 = "1";
const CONFIDENTIAL_AMOUNT = "10";
const TICKER = "DCONF";
const SYMBOL = "DEVNET-CONF";
const STEPS = [
  "issue",
  "keys",
  "authorize-sender",
  "authorize-d3",
  "public-sender",
  "public-d3",
  "convert-d3",
  "convert-sender",
  "merge-sender",
  "pay",
  "lock",
  "clawback",
];
const PROOF_STEPS = new Set(["convert-d3", "convert-sender", "pay", "clawback"]);

const PUBLIC_LEDGER = {
  shows: [
    "MPTokenIssuanceCreate flag CanHoldConfidentialBalance and DynamicMPT ImmutableFlags",
    "IssuerEncryptionKey, a public 33-byte key, with no auditor key",
    "public Payment amounts from D0 to the sender and to D3",
    "ConfidentialMPTConvert MPTAmount in plaintext, including the 1-unit key registration",
    "ConfidentialMPTSend accounts, destination, and issuance id",
    "ConfidentialMPTClawback Holder, issuance id, and plaintext MPTAmount of the full balance",
  ],
  hides: [
    "the ConfidentialMPTSend amount (ciphertexts and a ZKProof, no plaintext amount field)",
    "holder confidential inbox and spending balances, which stay ciphertext",
    "how a confidential balance was split across earlier sends",
  ],
  proof:
    "A public observer cannot read the send amount. The issuer can still prove the mirror balance with D0_ELGAMAL_SEED, and D3 can prove a receipt with D3_ELGAMAL_SEED. No auditor key is registered, so there is no third-party auditor ciphertext. The clawback transaction itself publishes the plaintext total it burns.",
};

const HELP = `Usage: node src/frontier/devnet-confidential.js [--dry-run] [--live --step STEP]
       [--d0 ADDRESS] [--d3 ADDRESS] [--sender ADDRESS] [--xrpl-http URL]
       [--issuance-id HEX] [--issuer-encryption-key HEX]

--dry-run is the default. It does not read seeds and does not invent a ZKProof.
--live requires FOUNDRY_DAEMON_LIVE=yes, one --step, and network id 2.
ElGamal seeds are D0_ELGAMAL_SEED, D3_ELGAMAL_SEED, and D_CONF_SENDER_ELGAMAL_SEED.
They must differ from the signing seeds. The issuer cannot hold its own confidential balance.
The sender must not be D0 or D3. A self-deal is not a counterparty.
Steps: ${STEPS.join(", ")}.`;

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
    d3: null,
    sender: null,
    xrplHttp: null,
    issuanceId: null,
    issuerKey: null,
  };
  const valued = ["--step", "--d0", "--d3", "--sender", "--xrpl-http", "--issuance-id", "--issuer-encryption-key"];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run" || arg === "--live" || arg === "--help" || arg === "-h") continue;
    if (!valued.includes(arg)) throw coded(`unknown arg ${arg}`, "ARGS");
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw coded(`${arg} needs a value`, "ARGS");
    i += 1;
    if (arg === "--step") out.step = value;
    else if (arg === "--d0") out.d0 = value;
    else if (arg === "--d3") out.d3 = value;
    else if (arg === "--sender") out.sender = value;
    else if (arg === "--xrpl-http") out.xrplHttp = value;
    else if (arg === "--issuance-id") out.issuanceId = value;
    else out.issuerKey = value;
  }
  if (out.step && !STEPS.includes(out.step)) throw coded(`unknown step ${out.step}`, "ARGS");
  if (out.live && !out.step) throw coded("pass --step with --live", "ARGS");
  return out;
}

function memos(purpose) {
  return [
    grants.memo("purpose", purpose),
    grants.memo("experiment", "devnet-confidential"),
    grants.memo("network", "XRPL Devnet"),
  ];
}

function metadataObject() {
  return {
    t: TICKER,
    n: SYMBOL,
    d: "Devnet confidential MPT. Not Testnet AETH-LABOR.",
    ac: "other",
    in: "Aether Foundry",
  };
}

function encodeMetadata() {
  const xrpl = require("xrpl");
  const hex = xrpl.encodeMPTokenMetadata(metadataObject());
  if (typeof hex !== "string" || hex.length === 0 || hex.length > 2048) {
    throw coded("MPTokenMetadata length is wrong", "METADATA");
  }
  return hex.toUpperCase();
}

function accountsOf(env, mode) {
  const d0 = guard.addressFrom(env, "D0", mode.d0);
  const d3 = guard.addressFrom(env, "D3", mode.d3);
  const sender = guard.addressFrom(env, "SENDER", mode.sender);
  guard.assertDistinct([
    ["D0", d0],
    ["D3", d3],
    ["sender", sender],
  ]);
  return { d0, d3, sender };
}

function issuanceOf(mode) {
  if (mode.issuanceId == null || mode.issuanceId === "") return null;
  return guard.assertIssuanceId(mode.issuanceId);
}

function buildIssue(d0) {
  const tx = {
    TransactionType: "MPTokenIssuanceCreate",
    Account: d0,
    AssetScale: 0,
    TransferFee: 0,
    MaximumAmount: MAXIMUM_AMOUNT,
    Flags: ISSUANCE_FLAGS,
    ImmutableFlags: IMMUTABLE_FLAGS,
    MPTokenMetadata: encodeMetadata(),
    Memos: memos("aether-devnet-confidential-issue"),
  };
  if ((tx.Flags & TF_MPT_CAN_HOLD_CONFIDENTIAL) === 0) throw coded("confidential flag missing", "FLAGS");
  if ((tx.ImmutableFlags & TIF_MPT_CAN_HOLD_CONFIDENTIAL) === 0) throw coded("DynamicMPT immutable confidential flag missing", "FLAGS");
  if (tx.TransferFee !== 0) throw coded("confidential issuance transfer fee must be 0", "FLAGS");
  if ((tx.Flags & 0x00000010) !== 0) throw coded("confidential pack must not set CanTrade", "FLAGS");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildKeys(d0, issuanceId, publicKey) {
  const tx = {
    TransactionType: "MPTokenIssuanceSet",
    Account: d0,
    MPTokenIssuanceID: guard.assertIssuanceId(issuanceId),
    IssuerEncryptionKey: guard.assertElgamalPublic(publicKey),
    Memos: memos("aether-devnet-confidential-keys"),
  };
  if (tx.AuditorEncryptionKey) throw coded("this pack does not register an auditor key", "KEY");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildAuthorize(account, issuanceId, purpose) {
  const tx = {
    TransactionType: "MPTokenAuthorize",
    Account: account,
    MPTokenIssuanceID: guard.assertIssuanceId(issuanceId),
    Memos: memos(purpose),
  };
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildPublicPay(d0, destination, issuanceId, value, purpose) {
  const tx = {
    TransactionType: "Payment",
    Account: d0,
    Destination: destination,
    Amount: { mpt_issuance_id: guard.assertIssuanceId(issuanceId), value: String(value) },
    Memos: memos(purpose),
  };
  guard.assertNotLaborIssuance(tx.Amount.mpt_issuance_id, "payment");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildMerge(account, issuanceId) {
  const tx = {
    TransactionType: "ConfidentialMPTMergeInbox",
    Account: account,
    MPTokenIssuanceID: guard.assertIssuanceId(issuanceId),
    Memos: memos("aether-devnet-confidential-merge"),
  };
  guard.assertNoProofMaterial(tx);
  return tx;
}

function buildLock(d0, d3, issuanceId) {
  const tx = {
    TransactionType: "MPTokenIssuanceSet",
    Account: d0,
    Holder: d3,
    MPTokenIssuanceID: guard.assertIssuanceId(issuanceId),
    Flags: TF_MPT_LOCK,
    Memos: memos("aether-devnet-confidential-lock"),
  };
  if (tx.Account === tx.Holder) throw coded("lock Holder must not be the issuer", "ADDRESS");
  guard.assertNoProofMaterial(tx);
  return tx;
}

function proofShape(step, fields) {
  return {
    step,
    ready: false,
    reason: "ZKProof is built on --live by xrpl.js. Dry-run does not invent one.",
    tx: null,
    shape: Object.assign({ TransactionType: fields.TransactionType }, fields, {
      withheld: ["ciphertexts", "ZKProof"],
    }),
  };
}

function ready(name, tx, reason) {
  return { step: name, ready: true, reason, tx };
}

function held(name, reason) {
  return { step: name, ready: false, reason, tx: null };
}

function planSteps(accounts, mode) {
  const issuance = issuanceOf(mode);
  const key = mode.issuerKey ? guard.assertElgamalPublic(mode.issuerKey) : null;
  const steps = [
    ready("issue", buildIssue(accounts.d0), "D0 confidential issuance. TransferFee 0. DynamicMPT immutable confidential flag set."),
  ];
  if (!issuance) {
    steps.push(held("keys", "issuance id is unknown until MPTokenIssuanceCreate tesSUCCESS"));
  } else if (!key) {
    steps.push(held("keys", "pass --issuer-encryption-key, or --live derives the public key from D0_ELGAMAL_SEED"));
  } else {
    steps.push(ready("keys", buildKeys(accounts.d0, issuance, key), "registers IssuerEncryptionKey only"));
  }
  const needId = (name, builder, reason) => {
    steps.push(issuance ? ready(name, builder(), reason) : held(name, "issuance id is unknown until MPTokenIssuanceCreate tesSUCCESS"));
  };
  needId(
    "authorize-sender",
    () => buildAuthorize(accounts.sender, issuance, "aether-devnet-confidential-auth-sender"),
    "sender opts in"
  );
  needId(
    "authorize-d3",
    () => buildAuthorize(accounts.d3, issuance, "aether-devnet-confidential-auth-d3"),
    "D3 opts in"
  );
  needId(
    "public-sender",
    () => buildPublicPay(accounts.d0, accounts.sender, issuance, PUBLIC_SENDER, "aether-devnet-confidential-public-sender"),
    `public Payment of ${PUBLIC_SENDER}. The ledger shows this amount.`
  );
  needId(
    "public-d3",
    () => buildPublicPay(accounts.d0, accounts.d3, issuance, PUBLIC_D3, "aether-devnet-confidential-public-d3"),
    `public Payment of ${PUBLIC_D3} so D3 can register a holder key. The ledger shows this amount.`
  );
  steps.push(
    proofShape("convert-d3", {
      TransactionType: "ConfidentialMPTConvert",
      Account: accounts.d3,
      MPTokenIssuanceID: issuance,
      plaintext_amount: PUBLIC_D3,
    })
  );
  steps.push(
    proofShape("convert-sender", {
      TransactionType: "ConfidentialMPTConvert",
      Account: accounts.sender,
      MPTokenIssuanceID: issuance,
      plaintext_amount: CONFIDENTIAL_AMOUNT,
    })
  );
  needId("merge-sender", () => buildMerge(accounts.sender, issuance), "folds the sender inbox into the spending balance");
  steps.push(
    proofShape("pay", {
      TransactionType: "ConfidentialMPTSend",
      Account: accounts.sender,
      Destination: accounts.d3,
      MPTokenIssuanceID: issuance,
      amount_hidden: CONFIDENTIAL_AMOUNT,
    })
  );
  needId("lock", () => buildLock(accounts.d0, accounts.d3, issuance), "tfMPTLock on D3 before clawback");
  steps.push(
    proofShape("clawback", {
      TransactionType: "ConfidentialMPTClawback",
      Account: accounts.d0,
      Holder: accounts.d3,
      MPTokenIssuanceID: issuance,
      plaintext: "full confidential balance, published in MPTAmount",
    })
  );
  return mode.step ? steps.filter((row) => row.step === mode.step) : steps;
}

async function plan(opts) {
  const options = opts || {};
  const mode = options.mode || {};
  const env = options.env || {};
  let ledger = null;
  try {
    ledger = await guard.loadAmendments({
      env,
      xrplHttp: mode.xrplHttp || null,
      fetchImpl: options.fetchImpl,
      names: AMENDMENTS,
    });
    const accounts = accountsOf(env, mode);
    const steps = planSteps(accounts, mode);
    return {
      allow: true,
      code: "DRY_RUN",
      message: "unsigned confidential issuance. Proof steps stay empty until --live.",
      http: ledger.http,
      network: ledger.network,
      network_id: ledger.network_id,
      build_version: ledger.build_version,
      amendments: ledger.amendments,
      accounts,
      public_ledger: PUBLIC_LEDGER,
      amounts: {
        public_sender: PUBLIC_SENDER,
        public_d3_register: PUBLIC_D3,
        confidential_payment: CONFIDENTIAL_AMOUNT,
      },
      steps,
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
      public_ledger: PUBLIC_LEDGER,
      amounts: null,
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
    key_env: ["D0_SEED", "D3_SEED", "D_CONF_SENDER_SEED", "D0_ELGAMAL_SEED", "D3_ELGAMAL_SEED", "D_CONF_SENDER_ELGAMAL_SEED"],
    network: guard.NETWORK,
    network_id: draft.network_id,
    action: "devnet_confidential",
    intent: "devnet_confidential",
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendments: draft.amendments,
    symbol: SYMBOL,
    ticker: TICKER,
    accounts: draft.accounts,
    public_ledger: draft.public_ledger,
    amounts: draft.amounts,
    steps: draft.steps,
    signer: "Devnet D0/D3/sender seeds; not the Testnet agent allowlist",
  };
}

function elgamalPair(xrpl, seed) {
  const pair = xrpl.deriveConfidentialKeypair(seed);
  if (!pair || !pair.publicKey || !pair.privateKey) throw coded("ElGamal derivation failed", "ELGAMAL");
  guard.assertElgamalPublic(pair.publicKey);
  return pair;
}

async function liveStep(draft, mode, env, loadSeed, deps) {
  const step = (draft.steps || []).find((row) => row.step === mode.step);
  if (!draft.allow || !step) throw coded(draft.message || `${mode.step} is not ready`, draft.code || "REFUSED");
  const options = deps || {};
  const xrpl = options.xrpl || require("xrpl");
  const ctx = {
    env,
    networkId: draft.network_id,
    http: draft.http,
    xrplHttp: mode.xrplHttp,
    client: options.client,
    xrpl,
  };
  if (!PROOF_STEPS.has(mode.step)) {
    if (!step.ready || !step.tx) throw coded(step.reason || `${mode.step} is not ready`, "REFUSED");
    if (mode.step === "keys" && !step.tx.IssuerEncryptionKey) {
      throw coded("keys transaction is missing the public encryption key", "KEY");
    }
    if (options.submit) return options.submit(step.tx, mode.step, ctx);
    const who = seedForPlain(mode.step);
    const seed = loadSeed(who);
    const expected = expectedAddress(draft.accounts, mode.step);
    return guard.submitAutofill(step.tx, seed, expected, ctx);
  }
  if (!draft.accounts) throw coded("accounts are missing", "ADDRESS");
  const issuance = issuanceOf(mode);
  if (!issuance) throw coded("pass --issuance-id from the issue tesSUCCESS", "ISSUANCE");
  return guard.withDevnetClient(ctx, async ({ client }) => {
    const built = await prepareProof(xrpl, client, mode.step, draft.accounts, issuance, env, loadSeed, options);
    if (!built || typeof built.ZKProof !== "string" || built.ZKProof.length === 0) {
      throw coded("xrpl.js did not return a ZKProof; refusing to invent one", "PROOF");
    }
    const seedName = seedForProof(mode.step);
    const seed = loadSeed(seedName);
    const expected = expectedAddress(draft.accounts, mode.step);
    const wallet = guard.walletFromSeed(xrpl, seed, expected);
    const prepared = guard.assertPrepared(await client.autofill(built));
    if (prepared.Sequence !== built.Sequence) {
      throw coded("autofill changed Sequence after the proof was bound", "PROOF");
    }
    const signed = wallet.sign(prepared);
    return guard.readEngine(await client.submitAndWait(signed.tx_blob));
  });
}

function seedForPlain(step) {
  if (step === "authorize-sender" || step === "merge-sender") return guard.SEED_ENV.SENDER;
  if (step === "authorize-d3") return guard.SEED_ENV.D3;
  return guard.SEED_ENV.D0;
}

function seedForProof(step) {
  if (step === "convert-d3") return guard.SEED_ENV.D3;
  if (step === "convert-sender" || step === "pay") return guard.SEED_ENV.SENDER;
  return guard.SEED_ENV.D0;
}

function expectedAddress(accounts, step) {
  if (step === "authorize-sender" || step === "convert-sender" || step === "merge-sender" || step === "pay") {
    return accounts.sender;
  }
  if (step === "authorize-d3" || step === "convert-d3") return accounts.d3;
  return accounts.d0;
}

async function prepareProof(xrpl, client, step, accounts, issuance, env, loadSeed, options) {
  if (options.prepareProof) return options.prepareProof({ step, accounts, issuance, client });
  if (step === "convert-d3") {
    const signing = loadSeed(guard.SEED_ENV.D3);
    const elgamal = loadSeed(guard.SEED_ENV.D3_ELGAMAL);
    guard.assertSigningSeedDistinct(signing, elgamal);
    return xrpl.prepareConfidentialConvert(client, {
      account: accounts.d3,
      mptIssuanceID: issuance,
      amount: BigInt(PUBLIC_D3),
      holderKeypair: elgamalPair(xrpl, elgamal),
    });
  }
  if (step === "convert-sender") {
    const signing = loadSeed(guard.SEED_ENV.SENDER);
    const elgamal = loadSeed(guard.SEED_ENV.SENDER_ELGAMAL);
    guard.assertSigningSeedDistinct(signing, elgamal);
    return xrpl.prepareConfidentialConvert(client, {
      account: accounts.sender,
      mptIssuanceID: issuance,
      amount: BigInt(CONFIDENTIAL_AMOUNT),
      holderKeypair: elgamalPair(xrpl, elgamal),
    });
  }
  if (step === "pay") {
    const signing = loadSeed(guard.SEED_ENV.SENDER);
    const elgamal = loadSeed(guard.SEED_ENV.SENDER_ELGAMAL);
    guard.assertSigningSeedDistinct(signing, elgamal);
    return xrpl.prepareConfidentialSend(client, {
      account: accounts.sender,
      destination: accounts.d3,
      mptIssuanceID: issuance,
      amount: BigInt(CONFIDENTIAL_AMOUNT),
      senderKeypair: elgamalPair(xrpl, elgamal),
    });
  }
  const signing = loadSeed(guard.SEED_ENV.D0);
  const elgamal = loadSeed(guard.SEED_ENV.D0_ELGAMAL);
  guard.assertSigningSeedDistinct(signing, elgamal);
  return xrpl.prepareConfidentialClawback(client, {
    account: accounts.d0,
    holder: accounts.d3,
    mptIssuanceID: issuance,
    issuerKeypair: elgamalPair(xrpl, elgamal),
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
  let draft = await plan({ env, mode, fetchImpl: options.fetchImpl });
  if (mode.live && draft.allow && mode.step === "keys" && !mode.issuerKey) {
    const signing = loadSeed(guard.SEED_ENV.D0);
    const elgamal = loadSeed(guard.SEED_ENV.D0_ELGAMAL);
    guard.assertSigningSeedDistinct(signing, elgamal);
    const xrpl = options.xrpl || require("xrpl");
    mode.issuerKey = elgamalPair(xrpl, elgamal).publicKey;
    draft = await plan({ env, mode, fetchImpl: options.fetchImpl });
  }
  if (!mode.live) {
    const body = publicBody(mode, draft, seedReads);
    for (const row of body.steps || []) guard.assertNoProofMaterial(row.tx);
    policy.assertNoSeedFields(body);
    const text = JSON.stringify(body, null, 2);
    policy.assertPrintSafe(text);
    write(text);
    const requested = mode.step ? draft.steps[0] && draft.steps[0].ready : draft.allow;
    return requested && draft.allow ? 0 : 2;
  }
  const submitted = await liveStep(draft, mode, env, loadSeed, options);
  const issuance = mode.step === "issue" ? guard.issuanceFromMeta(submitted.meta) : issuanceOf(mode);
  const row = guard.archiveDevnet(root, {
    ts: (options.now || new Date()).toISOString(),
    action: "devnet_confidential",
    step: mode.step,
    network: guard.NETWORK,
    network_id: guard.NETWORK_ID,
    account: expectedAddress(draft.accounts, mode.step),
    symbol: SYMBOL,
    mpt_issuance_id: issuance,
    hash: submitted.hash,
    result: submitted.result,
    ledger_index: submitted.ledger_index,
    public_ledger: mode.step === "pay" || mode.step === "clawback" ? PUBLIC_LEDGER.hides[0] : null,
  });
  const body = {
    mode: "live",
    signed: true,
    submitted: true,
    key_loaded: seedReads > 0,
    network: guard.NETWORK,
    network_id: guard.NETWORK_ID,
    action: "devnet_confidential",
    step: mode.step,
    symbol: SYMBOL,
    allow: true,
    code: "SUBMITTED",
    hash: row.hash,
    mpt_issuance_id: issuance,
    ledger_index: row.ledger_index,
    result: "tesSUCCESS",
    public_ledger: PUBLIC_LEDGER,
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
  PROOF_STEPS,
  ISSUANCE_FLAGS,
  IMMUTABLE_FLAGS,
  TF_MPT_CAN_HOLD_CONFIDENTIAL,
  TIF_MPT_CAN_HOLD_CONFIDENTIAL,
  TF_MPT_LOCK,
  PUBLIC_LEDGER,
  PUBLIC_SENDER,
  PUBLIC_D3,
  CONFIDENTIAL_AMOUNT,
  TICKER,
  SYMBOL,
  parseArgs,
  metadataObject,
  buildIssue,
  buildKeys,
  buildAuthorize,
  buildPublicPay,
  buildMerge,
  buildLock,
  plan,
  run,
};
