"use strict";

/**
 * Week-2 board policy for W0 SignerList and W1–W6 regular keys.
 * Pure helpers: no ledger submit, no seed values.
 *
 * Hunch H1: weights Director 2, Treasurer 2, Atelier 1, Market 1, quorum 3.
 * No single persona reaches quorum. Atelier+Market (2) does not pass.
 * Any other pair does. Master key stays enabled.
 */

const xrpl = require("xrpl");
const hosts = require("../xrpl-hosts");

const HUNCH = "H1";
const QUORUM = 3;
const NETWORK = "XRPL Testnet";
const NETWORK_ID = 1;
const XRPL_WS = hosts.PRIMARY_WS;
const XRPL_HTTP = hosts.PRIMARY_HTTP;
const SECRETS_PATH = "/workspace/aether-foundry-secrets/.env";
const MOTION_XRP = 50;
const MOTION_DROPS = 50000000n;
const DEMO_DROPS = "10000";
const DEMO_SOURCE_TAG = 202609274;
const DEMO_SIGNER_IDS = ["director", "market"];
const ASF_DISABLE_MASTER = 4;
const LSF_DISABLE_MASTER = 0x00100000;
const LSF_PASSWORD_SPENT = 0x00010000;
const MAX_SIGNER_WEIGHT = 65535;
const MAX_SIGNERS = 8;

const W0 = "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs";
const W6 = "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf";

const ACCOUNTS = [
  {
    id: "W0",
    role: "TREASURY",
    address: W0,
    masterEnv: ["W0_SEED", "TREASURY_SEED"],
  },
  {
    id: "W1",
    role: "MARKET",
    address: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
    masterEnv: ["W1_SEED", "MARKET_SEED"],
    regularEnv: "W1_REGULAR_SEED",
  },
  {
    id: "W2",
    role: "ATELIER",
    address: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
    masterEnv: ["W2_SEED", "ATELIER_SEED"],
    regularEnv: "W2_REGULAR_SEED",
  },
  {
    id: "W3",
    role: "CHANNELS",
    address: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
    masterEnv: ["W3_SEED", "CHANNELS_SEED"],
    regularEnv: "W3_REGULAR_SEED",
  },
  {
    id: "W4",
    role: "ESCROW",
    address: "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
    masterEnv: ["W4_SEED", "ESCROW_SEED"],
    regularEnv: "W4_REGULAR_SEED",
  },
  {
    id: "W5",
    role: "R&D",
    address: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
    masterEnv: ["W5_SEED", "RD_SEED"],
    regularEnv: "W5_REGULAR_SEED",
  },
  {
    id: "W6",
    role: "GRANTS",
    address: W6,
    masterEnv: ["W6_SEED", "GRANTS_SEED"],
    regularEnv: "W6_REGULAR_SEED",
  },
];

const SIGNERS = [
  { id: "director", persona: "Director", weight: 2, env: "SIGNER_DIRECTOR_SEED" },
  { id: "treasurer", persona: "Treasurer", weight: 2, env: "SIGNER_TREASURER_SEED" },
  { id: "atelier", persona: "Atelier", weight: 1, env: "SIGNER_ATELIER_SEED" },
  { id: "market", persona: "Market", weight: 1, env: "SIGNER_MARKET_SEED" },
];

const ANCHOR_ADDRESSES = new Set(ACCOUNTS.map((row) => row.address));

function envIsCi(env) {
  if (!env) return false;
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
}

function assertNotCi(env) {
  if (envIsCi(env)) {
    throw new Error("refusing to load seeds or sign in CI");
  }
}

function isMainnetUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const blocked = ["ripple.com", "xrplcluster.com", "xrpl.ws", "xrpl.link"];
    return blocked.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function assertTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("refusing unparseable XRPL url"), { code: "MAINNET" });
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("xahau")) {
    throw Object.assign(new Error("refusing Xahau host for week-2 XRPL governance"), {
      code: "XAHAU",
    });
  }
  if (isMainnetUrl(raw)) {
    throw Object.assign(new Error("refusing mainnet XRPL url"), { code: "MAINNET" });
  }
  if (!hosts.isApprovedXrplTestnetHost(host)) {
    throw Object.assign(new Error("refusing non-testnet XRPL url"), { code: "MAINNET" });
  }
  return raw;
}

function assertNetworkId(networkId) {
  if (networkId == null) return;
  if (Number(networkId) !== NETWORK_ID) {
    throw new Error(`refusing NetworkID ${networkId}`);
  }
}

function accountIdHex(address) {
  return Buffer.from(xrpl.decodeAccountID(address)).toString("hex");
}

function assertClassicAddress(address, label) {
  if (typeof address !== "string" || address.length === 0) {
    throw new Error(`${label} is not a classic address`);
  }
  try {
    accountIdHex(address);
  } catch {
    throw new Error(`${label} is not a classic address`);
  }
}

function compareAccounts(a, b) {
  const left = accountIdHex(a);
  const right = accountIdHex(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sumWeights(rows) {
  return rows.reduce((total, row) => total + Number(row.weight), 0);
}

function quorumMet(rows, quorum = QUORUM) {
  return sumWeights(rows) >= quorum;
}

function signerById(id) {
  const row = SIGNERS.find((item) => item.id === id);
  if (!row) throw new Error(`unknown signer ${id}`);
  return row;
}

function coalitionRows(ids) {
  return ids.map((id) => signerById(id));
}

function coalitions() {
  const ids = SIGNERS.map((row) => row.id);
  const out = [];
  const n = ids.length;
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const chosen = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) chosen.push(ids[i]);
    }
    const rows = coalitionRows(chosen);
    out.push({
      ids: chosen,
      weight: sumWeights(rows),
      pass: quorumMet(rows),
    });
  }
  return out;
}

function demoSigners() {
  const rows = coalitionRows(DEMO_SIGNER_IDS);
  if (!quorumMet(rows)) throw new Error("demo coalition does not meet quorum");
  if (sumWeights(rows) !== QUORUM) {
    throw new Error("demo coalition is not an exact quorum");
  }
  return rows;
}

function assertWeight(weight, label) {
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_SIGNER_WEIGHT) {
    throw new Error(`${label} weight must be 1..${MAX_SIGNER_WEIGHT}`);
  }
}

function buildSignerListSet(signers, account = W0) {
  assertClassicAddress(account, "SignerList account");
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error("SignerList needs at least one signer");
  }
  if (signers.length > MAX_SIGNERS) {
    throw new Error(`SignerList supports at most ${MAX_SIGNERS} signers without relying on a higher cap`);
  }
  const seen = new Set();
  const entries = signers.map((row) => {
    const address = row.address || row.Account;
    assertClassicAddress(address, row.persona || "signer");
    if (address === account) throw new Error("signer list cannot include its own account");
    if (seen.has(address)) throw new Error(`duplicate signer ${address}`);
    seen.add(address);
    assertWeight(row.weight, row.persona || address);
    if (row.id) {
      const spec = signerById(row.id);
      if (row.weight !== spec.weight) {
        throw new Error(`${row.id} weight is fixed at ${spec.weight} by hunch ${HUNCH}`);
      }
    }
    return {
      address,
      weight: row.weight,
      persona: row.persona || null,
      id: row.id || null,
    };
  });
  const total = sumWeights(entries);
  if (QUORUM < 1 || QUORUM > total) {
    throw new Error(`quorum ${QUORUM} is outside 1..${total}`);
  }
  entries.sort((a, b) => compareAccounts(a.address, b.address));
  const tx = {
    TransactionType: "SignerListSet",
    Account: account,
    SignerQuorum: QUORUM,
    SignerEntries: entries.map((row) => ({
      SignerEntry: {
        Account: row.address,
        SignerWeight: row.weight,
      },
    })),
  };
  assertNoDisableMaster(tx);
  xrpl.validate(tx);
  return tx;
}

function buildSetRegularKey(account, regularKey) {
  assertClassicAddress(account, "RegularKey account");
  assertClassicAddress(regularKey, "RegularKey");
  if (regularKey === account) {
    throw new Error("RegularKey must not equal the account master address");
  }
  const tx = {
    TransactionType: "SetRegularKey",
    Account: account,
    RegularKey: regularKey,
  };
  assertNoDisableMaster(tx);
  xrpl.validate(tx);
  return tx;
}

function assertNoDisableMaster(tx) {
  if (!tx || typeof tx !== "object") throw new Error("missing tx");
  if (tx.TransactionType === "AccountSet") {
    throw new Error("refusing AccountSet in week-2 governance");
  }
  if (Number(tx.SetFlag) === ASF_DISABLE_MASTER) {
    throw new Error("refusing asfDisableMaster");
  }
  if (tx.RegularKey === "" && tx.TransactionType === "SetRegularKey") {
    throw new Error("refusing to clear RegularKey in week-2 governance");
  }
}

function masterDisabled(flags) {
  return (Number(flags) & LSF_DISABLE_MASTER) !== 0;
}

function passwordSpent(flags) {
  return (Number(flags) & LSF_PASSWORD_SPENT) !== 0;
}

function assertMasterEnabled(flags, label) {
  if (masterDisabled(flags)) {
    throw new Error(
      `${label} has lsfDisableMaster. Week-2 does not clear it and does not set it.`
    );
  }
}

function dropsOf(amount) {
  if (typeof amount === "bigint") {
    if (amount < 0n) throw new Error("drops must be non-negative");
    return amount;
  }
  if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("drops must be a safe integer");
    return BigInt(amount);
  }
  if (typeof amount === "string" && /^[0-9]+$/.test(amount)) return BigInt(amount);
  throw new Error("drops must be an integer string");
}

function motionRequired(drops) {
  return dropsOf(drops) >= MOTION_DROPS;
}

function isMotionFile(name) {
  const base = String(name);
  if (base.startsWith(".")) return false;
  if (!base.endsWith(".md")) return false;
  return base.toLowerCase() !== "readme.md";
}

function parseMotion(text) {
  const fields = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^\s*(destination|amount_drops|amount_xrp)\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

function motionCovers(text, destination, drops) {
  const fields = parseMotion(text);
  if (fields.destination !== destination) return false;
  const need = dropsOf(drops);
  if (fields.amount_drops != null) {
    try {
      return dropsOf(fields.amount_drops) === need;
    } catch {
      return false;
    }
  }
  if (fields.amount_xrp != null) {
    try {
      return BigInt(xrpl.xrpToDrops(fields.amount_xrp)) === need;
    } catch {
      return false;
    }
  }
  return false;
}

function assertMotion(drops, destination, files) {
  const amount = dropsOf(drops);
  assertClassicAddress(destination, "payment destination");
  if (!motionRequired(amount)) return { required: false };
  const list = Array.isArray(files) ? files : [];
  const hit = list.some((file) => motionCovers(file.text, destination, amount));
  if (!hit) {
    throw new Error(
      `W0 payment of ${amount.toString()} drops to ${destination} needs a motion in /lab/motions/`
    );
  }
  return { required: true };
}

function buildDemoPayment(opts = {}) {
  const account = opts.account || W0;
  const destination = opts.destination || W6;
  const drops = opts.drops == null ? DEMO_DROPS : String(opts.drops);
  assertClassicAddress(account, "payer");
  assertClassicAddress(destination, "destination");
  if (account === destination) throw new Error("refusing a payment to self");
  const amount = dropsOf(drops);
  if (amount <= 0n) throw new Error("payment amount must be positive");
  if (motionRequired(amount) && !opts.motionOk) {
    throw new Error("refusing a treasury payment at or above 50 XRP without a motion");
  }
  const tx = {
    TransactionType: "Payment",
    Account: account,
    Destination: destination,
    Amount: amount.toString(),
    SourceTag: DEMO_SOURCE_TAG,
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from("foundry", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from("gov-quorum-demo", "utf8").toString("hex").toUpperCase(),
        },
      },
    ],
  };
  assertNoDisableMaster(tx);
  xrpl.validate(tx);
  return tx;
}

function multisignFeeDrops(baseFeeDrops, signerCount) {
  const base = dropsOf(baseFeeDrops);
  const count = Number(signerCount);
  if (!Number.isInteger(count) || count < 1) throw new Error("signer count must be a positive integer");
  return (base * BigInt(count + 1)).toString();
}

function signerListOwnerDelta(existingCount) {
  const count = Number(existingCount) || 0;
  return count > 0 ? 0 : 1;
}

function reserveDrops(baseDrops, incDrops, ownerCount) {
  return dropsOf(baseDrops) + dropsOf(incDrops) * BigInt(ownerCount);
}

function normalizeSignerEntries(list) {
  const entries = (list && list.SignerEntries) || [];
  return entries
    .map((wrapper) => {
      const row = wrapper.SignerEntry || wrapper;
      return { address: row.Account, weight: Number(row.SignerWeight) };
    })
    .sort((a, b) => compareAccounts(a.address, b.address));
}

function signerListsMatch(ledgerList, plannedTx) {
  if (!ledgerList || !plannedTx) return false;
  if (Number(ledgerList.SignerQuorum) !== Number(plannedTx.SignerQuorum)) return false;
  const left = normalizeSignerEntries(ledgerList);
  const right = normalizeSignerEntries(plannedTx);
  if (left.length !== right.length) return false;
  return left.every((row, i) => row.address === right[i].address && row.weight === right[i].weight);
}

function isTxHash(value) {
  return typeof value === "string" && /^[A-Fa-f0-9]{64}$/.test(value);
}

function submittedView(submitted) {
  const result = (submitted && (submitted.result || submitted)) || {};
  const meta = result.meta || result.metaData || {};
  const hash = typeof result.hash === "string" ? result.hash.toUpperCase() : "";
  return {
    hash: isTxHash(hash) ? hash : "",
    result: meta.TransactionResult || "",
    ledger_index: result.ledger_index == null ? null : result.ledger_index,
  };
}

function ledgerEvent(fields) {
  if (!isTxHash(fields.hash)) throw new Error("refusing to log a transaction without a hash");
  if (fields.result !== "tesSUCCESS") throw new Error("refusing to log a transaction that did not succeed");
  return Object.assign(
    {
      ts: fields.ts || new Date().toISOString(),
      network: NETWORK,
      hunch: HUNCH,
    },
    fields,
    { hash: fields.hash.toUpperCase() }
  );
}

function firstEnv(env, names) {
  for (const name of names) {
    if (env && typeof env[name] === "string" && env[name].length > 0) return env[name];
  }
  return "";
}

function missingMasterNames(env) {
  return ACCOUNTS.filter((row) => !firstEnv(env, row.masterEnv)).map((row) => row.masterEnv[0]);
}

function disjointBoard(rows) {
  const seen = new Map();
  for (const row of rows) {
    assertClassicAddress(row.address, row.label || "key");
    if (ANCHOR_ADDRESSES.has(row.address)) {
      throw new Error(`${row.label} address collides with a Foundry anchor`);
    }
    if (seen.has(row.address)) {
      throw new Error(`${row.label} address collides with ${seen.get(row.address)}`);
    }
    seen.set(row.address, row.label);
  }
}

function renderDryRun(state) {
  const lines = [];
  lines.push("dry-run");
  lines.push(`hunch ${HUNCH}`);
  lines.push(`network ${NETWORK}`);
  lines.push(`quorum ${QUORUM}`);
  lines.push(
    `weights ${SIGNERS.map((row) => `${row.persona}=${row.weight}`).join(" ")}`
  );
  lines.push(`demo ${DEMO_SIGNER_IDS.join("+")} ${DEMO_DROPS} drops to ${W6}`);
  lines.push("master lsfDisableMaster left enabled");
  lines.push("transaction types SignerListSet and SetRegularKey");
  if (state.server) {
    lines.push(`ledger ${state.server.ledgerIndex}`);
    lines.push(`reserve_base_drops ${state.server.reserveBase}`);
    lines.push(`reserve_inc_drops ${state.server.reserveInc}`);
    if (state.server.networkId != null) lines.push(`network_id ${state.server.networkId}`);
  }
  const accounts = state.accounts || [];
  for (const row of accounts) {
    const listCount = (row.signerLists || []).length;
    const delta = row.id === "W0" ? signerListOwnerDelta(listCount) : 0;
    lines.push(
      [
        row.id,
        row.address,
        `balance_drops=${row.balanceDrops}`,
        `owner_count=${row.ownerCount}`,
        `regular_key=${row.regularKey || "none"}`,
        `signer_lists=${listCount}`,
        `disable_master=${row.disableMaster ? "yes" : "no"}`,
        `password_spent=${row.passwordSpent ? "yes" : "no"}`,
        `owner_delta=${delta}`,
      ].join(" ")
    );
  }
  lines.push("signer addresses are not assigned in dry-run (seeds are not read)");
  lines.push("no tx hash (not submitted)");
  return lines.join("\n");
}

function missingSeedMessage() {
  return [
    "Master seeds are not loaded. Put W0_SEED…W6_SEED (or TREASURY_SEED…GRANTS_SEED) in AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.",
    "Refusing to sign. No tx hash.",
    "One-click on the Foundry box:",
    "npm run gov:dry",
    "npm run gov:live",
    "npm run gov:multisign",
  ].join("\n");
}

module.exports = {
  HUNCH,
  QUORUM,
  NETWORK,
  NETWORK_ID,
  XRPL_WS,
  XRPL_HTTP,
  SECRETS_PATH,
  MOTION_XRP,
  MOTION_DROPS,
  DEMO_DROPS,
  DEMO_SOURCE_TAG,
  DEMO_SIGNER_IDS,
  ASF_DISABLE_MASTER,
  LSF_DISABLE_MASTER,
  LSF_PASSWORD_SPENT,
  MAX_SIGNERS,
  W0,
  W6,
  ACCOUNTS,
  SIGNERS,
  ANCHOR_ADDRESSES,
  envIsCi,
  assertNotCi,
  isMainnetUrl,
  assertTestnetUrl,
  assertNetworkId,
  accountIdHex,
  assertClassicAddress,
  compareAccounts,
  sumWeights,
  quorumMet,
  signerById,
  coalitionRows,
  coalitions,
  demoSigners,
  buildSignerListSet,
  buildSetRegularKey,
  assertNoDisableMaster,
  masterDisabled,
  passwordSpent,
  assertMasterEnabled,
  dropsOf,
  motionRequired,
  isMotionFile,
  parseMotion,
  motionCovers,
  assertMotion,
  buildDemoPayment,
  multisignFeeDrops,
  signerListOwnerDelta,
  reserveDrops,
  normalizeSignerEntries,
  signerListsMatch,
  isTxHash,
  submittedView,
  ledgerEvent,
  firstEnv,
  missingMasterNames,
  disjointBoard,
  renderDryRun,
  missingSeedMessage,
};
