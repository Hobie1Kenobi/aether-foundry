#!/usr/bin/env node
"use strict";

/**
 * Foundry-box signer for week-2 governance. Testnet only.
 * Loads master seeds from AETHER_SECRETS or /workspace/aether-foundry-secrets/.env.
 * Generates signer and regular-key seeds into that file when they are missing.
 * Never prints a seed. Refuses CI, mainnet, Xahau, and asfDisableMaster.
 *
 *   npm run gov:live
 *   npm run gov:live -- --dry-run
 *   npm run gov:multisign
 */

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const policy = require("./policy");
const keyfile = require("./keyfile");

const ROOT = path.resolve(__dirname, "..", "..");
const LEDGER_LOG = path.join(ROOT, "lab", "ledger-log.jsonl");
const ACTIVATED = path.join(ROOT, "machines", "governance-board", "activated.json");
const MOTIONS = path.join(ROOT, "lab", "motions");

function die(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function parseArgs(argv) {
  const out = { dryRun: false, multisign: false, replace: false };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--multisign-demo") out.multisign = true;
    else if (arg === "--replace") out.replace = true;
    else die(`unknown flag ${arg}`);
  }
  return out;
}

function walletFromSeed(seed, label) {
  try {
    const wallet = xrpl.Wallet.fromSeed(seed);
    if (!wallet.classicAddress) throw new Error("no address");
    return wallet;
  } catch {
    throw new Error(`${label} is not a usable seed`);
  }
}

function loadMasters(env) {
  const missing = policy.missingMasterNames(env);
  if (missing.length) {
    throw Object.assign(new Error(policy.missingSeedMessage()), { code: "NO_SEED" });
  }
  return policy.ACCOUNTS.map((row) => {
    const wallet = walletFromSeed(policy.firstEnv(env, row.masterEnv), row.masterEnv[0]);
    if (wallet.classicAddress !== row.address) {
      throw new Error(
        `${row.masterEnv[0]} address ${wallet.classicAddress} is not ${row.id} ${row.address}`
      );
    }
    return { account: row, wallet };
  });
}

function ensureKey(env, label, envName, allowGenerate) {
  if (env[envName]) {
    return { wallet: walletFromSeed(env[envName], envName), envName, generated: false };
  }
  if (!allowGenerate) throw new Error(`${envName} is not loaded`);
  const wallet = xrpl.Wallet.generate("ed25519");
  if (!wallet.seed) throw new Error(`could not generate ${label}`);
  return { wallet, envName, generated: true, seed: wallet.seed };
}

function boardFromEnv(env, opts = {}) {
  const allowGenerate = opts.generate === true;
  const generated = {};
  const signers = policy.SIGNERS.map((row) => {
    const got = ensureKey(env, row.persona, row.env, allowGenerate);
    if (got.generated) generated[got.envName] = got.seed;
    return Object.assign({}, row, { address: got.wallet.classicAddress, wallet: got.wallet });
  });
  const regulars = policy.ACCOUNTS.filter((row) => row.regularEnv).map((row) => {
    const got = ensureKey(env, `${row.id} regular key`, row.regularEnv, allowGenerate);
    if (got.generated) generated[got.envName] = got.seed;
    return {
      id: row.id,
      role: row.role,
      account: row.address,
      env: row.regularEnv,
      address: got.wallet.classicAddress,
      wallet: got.wallet,
    };
  });
  policy.disjointBoard(
    signers
      .map((row) => ({ address: row.address, label: row.persona }))
      .concat(regulars.map((row) => ({ address: row.address, label: `${row.id} regular key` })))
  );
  return { signers, regulars, generated };
}

function motionFiles() {
  if (!fs.existsSync(MOTIONS)) return [];
  return fs
    .readdirSync(MOTIONS)
    .filter((name) => policy.isMotionFile(name))
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(MOTIONS, name), "utf8"),
    }));
}

function appendLedger(event) {
  const line = JSON.stringify(policy.ledgerEvent(event));
  fs.mkdirSync(path.dirname(LEDGER_LOG), { recursive: true });
  let prefix = "";
  if (fs.existsSync(LEDGER_LOG)) {
    const cur = fs.readFileSync(LEDGER_LOG, "utf8");
    if (cur.length && !cur.endsWith("\n")) prefix = "\n";
  }
  fs.appendFileSync(LEDGER_LOG, `${prefix}${line}\n`);
}

function writeActivated(board, txs) {
  const submittedList = txs.some((row) => row.tx_type === "SignerListSet");
  const body = {
    network: policy.NETWORK,
    hunch: policy.HUNCH,
    quorum: policy.QUORUM,
    master_disabled: false,
    signer_list_status: submittedList ? "submitted" : "already_matches",
    signers: board.signers.map((row) => ({
      id: row.id,
      persona: row.persona,
      weight: row.weight,
      address: row.address,
      env: row.env,
    })),
    regular_keys: board.regulars.map((row) => ({
      id: row.id,
      role: row.role,
      account: row.account,
      regular_key: row.address,
      env: row.env,
    })),
    txs,
  };
  fs.mkdirSync(path.dirname(ACTIVATED), { recursive: true });
  fs.writeFileSync(ACTIVATED, `${JSON.stringify(body, null, 2)}\n`);
}

function plannedSignerTx(signers) {
  return policy.buildSignerListSet(
    signers.map((row) => ({
      id: row.id,
      persona: row.persona,
      weight: row.weight,
      address: row.address,
    }))
  );
}

async function accountInfo(client, address) {
  const response = await client.request({
    command: "account_info",
    account: address,
    ledger_index: "validated",
    signer_lists: true,
  });
  return response.result;
}

function decideSigner(info, planned, replace) {
  const lists = info.signer_lists || [];
  if (lists.length === 0) return "set";
  if (policy.signerListsMatch(lists[0], planned)) return "skip";
  if (!replace) {
    throw new Error(
      "W0 already has a different SignerList. Refusing to replace it without --replace. No tx submitted."
    );
  }
  return "set";
}

function decideRegular(info, address, replace, id) {
  const current = info.account_data.RegularKey || "";
  if (!current) return "set";
  if (current === address) return "skip";
  if (!replace) {
    throw new Error(
      `${id} RegularKey is ${current}, not ${address}. Refusing to replace it without --replace. No tx submitted.`
    );
  }
  return "set";
}

async function submitSingle(client, wallet, tx) {
  policy.assertNoDisableMaster(tx);
  const prepared = await client.autofill(tx);
  policy.assertNetworkId(prepared.NetworkID);
  const signed = wallet.sign(prepared);
  const submitted = await client.submitAndWait(signed.tx_blob);
  const view = policy.submittedView(submitted);
  if (view.result !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} result ${view.result || "missing"}`);
  }
  if (!policy.isTxHash(view.hash)) throw new Error(`${tx.TransactionType} returned no tx hash`);
  return view;
}

async function submitMultisign(client, tx, wallets) {
  policy.assertNoDisableMaster(tx);
  const prepared = await client.autofill(tx, wallets.length);
  policy.assertNetworkId(prepared.NetworkID);
  const parts = wallets.map((wallet) => wallet.sign(prepared, true).tx_blob);
  const blob = xrpl.multisign(parts);
  const submitted = await client.submitAndWait(blob);
  const view = policy.submittedView(submitted);
  if (view.result !== "tesSUCCESS") {
    throw new Error(`multisign Payment result ${view.result || "missing"}`);
  }
  if (!policy.isTxHash(view.hash)) throw new Error("multisign Payment returned no tx hash");
  return view;
}

function printBoard(signers, regulars) {
  console.log(`hunch ${policy.HUNCH}`);
  console.log(`quorum ${policy.QUORUM}`);
  for (const row of signers) {
    console.log(`signer ${row.persona} weight ${row.weight} ${row.address}`);
  }
  for (const row of regulars) {
    console.log(`regular ${row.id} ${row.account} -> ${row.address}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  policy.assertNotCi(process.env);
  const ws = policy.assertTestnetUrl(process.env.XRPL_WS_URL || policy.XRPL_WS);
  const secretsFile = process.env.AETHER_SECRETS || policy.SECRETS_PATH;
  const fileEnv = keyfile.readKeyFile(secretsFile);
  const env = Object.assign({}, fileEnv);
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length > 0 && /^[A-Z0-9_]+$/.test(key)) {
      env[key] = value;
    }
  }
  const masters = loadMasters(env);
  if (args.dryRun) {
    let board;
    try {
      board = boardFromEnv(env, { generate: false });
    } catch (error) {
      console.log("dry-run");
      console.log(error.message);
      console.log("signer addresses are not assigned (seeds are not generated on dry-run)");
      console.log("no tx hash (not submitted)");
      return;
    }
    printBoard(board.signers, board.regulars);
    console.log("dry-run");
    console.log("SignerListSet", JSON.stringify(plannedSignerTx(board.signers)));
    for (const row of board.regulars) {
      console.log(
        "SetRegularKey",
        JSON.stringify(policy.buildSetRegularKey(row.account, row.address))
      );
    }
    if (args.multisign) console.log("Payment", JSON.stringify(policy.buildDemoPayment()));
    console.log("no tx hash (not submitted)");
    return;
  }

  const board = boardFromEnv(env, { generate: true });
  if (Object.keys(board.generated).length) {
    keyfile.upsertKeyFile(secretsFile, board.generated, { repoRoot: ROOT });
    console.log(`wrote secret keys (names only): ${Object.keys(board.generated).join(" ")}`);
  }
  printBoard(board.signers, board.regulars);
  const planned = plannedSignerTx(board.signers);

  const client = new xrpl.Client(ws);
  await client.connect();
  const txs = [];
  try {
    policy.assertNetworkId(client.networkID);
    const infos = new Map();
    for (const row of policy.ACCOUNTS) {
      const info = await accountInfo(client, row.address);
      policy.assertMasterEnabled(info.account_data.Flags, row.id);
      infos.set(row.id, info);
    }
    const w0 = infos.get("W0");
    const signerAction = decideSigner(w0, planned, args.replace);
    const regularActions = board.regulars.map((row) => ({
      row,
      action: decideRegular(infos.get(row.id), row.address, args.replace, row.id),
    }));
    if (signerAction === "set") {
      const server = await client.request({ command: "server_state" });
      const validated = server.result.state.validated_ledger;
      const ownerCount = Number(w0.account_data.OwnerCount || 0);
      const delta = policy.signerListOwnerDelta((w0.signer_lists || []).length);
      const need = policy.reserveDrops(
        validated.reserve_base,
        validated.reserve_inc,
        ownerCount + delta
      );
      const balance = policy.dropsOf(w0.account_data.Balance);
      if (balance <= need) {
        throw new Error(
          `W0 balance ${balance.toString()} drops does not cover reserve ${need.toString()} after SignerListSet`
        );
      }
    }

    if (signerAction === "skip") {
      console.log("SignerListSet already matches; no new tx");
    } else {
      const master = masters.find((row) => row.account.id === "W0").wallet;
      const view = await submitSingle(client, master, planned);
      console.log("SignerListSet", view.hash);
      const event = {
        action: "SignerListSet",
        tx_type: "SignerListSet",
        account: policy.W0,
        hash: view.hash,
        result: view.result,
        ledger_index: view.ledger_index,
        quorum: policy.QUORUM,
      };
      appendLedger(event);
      txs.push(event);
      writeActivated(board, txs);
    }

    for (const item of regularActions) {
      if (item.action === "skip") {
        console.log(`SetRegularKey ${item.row.id} already matches; no new tx`);
        continue;
      }
      const master = masters.find((row) => row.account.id === item.row.id).wallet;
      const tx = policy.buildSetRegularKey(item.row.account, item.row.address);
      const view = await submitSingle(client, master, tx);
      console.log(`SetRegularKey ${item.row.id}`, view.hash);
      const event = {
        action: "SetRegularKey",
        tx_type: "SetRegularKey",
        account: item.row.account,
        wallet: item.row.id,
        regular_key: item.row.address,
        hash: view.hash,
        result: view.result,
        ledger_index: view.ledger_index,
      };
      appendLedger(event);
      txs.push(event);
      writeActivated(board, txs);
    }

    if (args.multisign) {
      const again = await accountInfo(client, policy.W0);
      if (!policy.signerListsMatch((again.signer_lists || [])[0], planned)) {
        throw new Error("refusing multisign demo; on-ledger SignerList does not match H1");
      }
      const payment = policy.buildDemoPayment();
      policy.assertMotion(payment.Amount, payment.Destination, motionFiles());
      const demoIds = new Set(policy.DEMO_SIGNER_IDS);
      const demoWallets = board.signers.filter((row) => demoIds.has(row.id)).map((row) => row.wallet);
      if (demoWallets.length !== policy.DEMO_SIGNER_IDS.length) {
        throw new Error("demo signers are missing");
      }
      const view = await submitMultisign(client, payment, demoWallets);
      console.log("Payment", view.hash);
      const event = {
        action: "Payment_multisign_quorum_demo",
        tx_type: "Payment",
        account: policy.W0,
        destination: policy.W6,
        amount_drops: policy.DEMO_DROPS,
        signers: policy.DEMO_SIGNER_IDS.join("+"),
        hash: view.hash,
        result: view.result,
        ledger_index: view.ledger_index,
      };
      appendLedger(event);
      txs.push(event);
      writeActivated(board, txs);
    }
    writeActivated(board, txs);
  } finally {
    await client.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error && error.code === "NO_SEED") die(error.message);
    die(error.message || String(error));
  });
}

module.exports = {
  parseArgs,
  walletFromSeed,
  loadMasters,
  boardFromEnv,
  decideSigner,
  decideRegular,
  ACTIVATED,
  LEDGER_LOG,
};
