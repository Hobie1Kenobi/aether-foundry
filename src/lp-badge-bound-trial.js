#!/usr/bin/env node
"use strict";

/**
 * Bind an LP position to a guild-door payment with Credentials + DepositPreauth.
 * XRPL Testnet only. Loads seeds from AETHER_SECRETS or the secrets file.
 * Never prints seeds. Refuses CI and mainnet hosts.
 *
 *   npm run lp-badge:bound -- --dry-run
 *   npm run lp-badge:bound -- --record
 */

const fs = require("fs");
const path = require("path");
const xrpl = require("xrpl");
const guard = require("./lp-badge-bound-guard");

const ROOT = path.resolve(__dirname, "..");
const BOOK = path.join(ROOT, "machines", "lp-badge-bound", "addresses.json");
const TRIAL = path.join(ROOT, "machines", "lp-badge-bound", "trial.json");
const LOG = path.join(ROOT, "lab", "ledger-log.jsonl");

function die(message, code) {
  const text = String(message || "failed").replace(/s[1-9A-HJ-NP-Za-km-z]{20,}/g, "[redacted]");
  console.error(text);
  process.exit(code || 1);
}

function parseArgs(argv) {
  const out = { dryRun: false, record: false };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--record") out.record = true;
    else die(`unknown flag ${arg}`);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secretsFile(env) {
  return env.AETHER_SECRETS || guard.SECRETS_PATH;
}

function readSecrets(env) {
  const file = secretsFile(env);
  if (!fs.existsSync(file)) return {};
  return guard.loadEnvText(fs.readFileSync(file, "utf8"));
}

function writeSecrets(env, pairs) {
  const file = secretsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const bag = guard.loadEnvText(prior);
  for (const [key, value] of pairs) bag[key] = value;
  const body = Object.keys(bag)
    .sort()
    .map((key) => `${key}=${bag[key]}`)
    .join("\n");
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* mode already applied */
  }
  return file;
}

function appendLog(row) {
  guard.assertPublicRecord(row);
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
}

function resultView(submitted) {
  const result = (submitted && (submitted.result || submitted)) || {};
  const meta = result.meta || result.metaData || {};
  return {
    hash: result.hash ? String(result.hash).toUpperCase() : null,
    engine: meta.TransactionResult || null,
    ledger_index: result.ledger_index == null ? null : result.ledger_index,
    meta,
  };
}

async function submitTx(client, wallet, tx) {
  let last = "submit failed";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const prepared = await client.autofill(tx);
      if (prepared.NetworkID != null) guard.assertNetworkId(prepared.NetworkID);
      const signed = wallet.sign(prepared);
      const submitted = await client.submitAndWait(signed.tx_blob);
      return resultView(submitted);
    } catch (err) {
      last = err && err.message ? err.message : String(err);
      if (/^tem|malformed|LastLedgerSequence/i.test(last) && attempt > 1) break;
      if (/credential type|network id|refusing/i.test(last)) break;
      await sleep(1200 * attempt);
    }
  }
  throw new Error(last.replace(/s[1-9A-HJ-NP-Za-km-z]{20,}/g, "[redacted]"));
}

async function faucetOnce(url) {
  guard.assertXrplTestnetUrl(url);
  let last = "faucet failed";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "aether-foundry-lp-badge-bound/1",
        Accept: "application/json",
      },
      body: "{}",
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const parsed = guard.parseFaucetBody(data);
    if (response.ok && parsed) return parsed;
    last = `faucet HTTP ${response.status} attempt ${attempt}`;
    await sleep(1500 * attempt);
  }
  throw new Error(last);
}

function loadBook() {
  if (!fs.existsSync(BOOK)) return null;
  return JSON.parse(fs.readFileSync(BOOK, "utf8"));
}

function writeBook(accounts) {
  const book = {
    network: "XRPL Testnet",
    network_id: guard.NETWORK_ID,
    ws: guard.XRPL_WS,
    note: "Public addresses only. Seeds are not in this file. These accounts are not W1 or W2.",
    xrpl_twins: {
      W1_MARKET: guard.W1,
      W2_ATELIER: guard.W2,
      W0_TREASURY: guard.W0,
      AMM: guard.AMM,
      note: "Twins are the existing XRPL Testnet anchors. The trial holder is separate so W1's seeded LP is not withdrawn.",
    },
    accounts,
  };
  guard.assertPublicRecord(book);
  fs.mkdirSync(path.dirname(BOOK), { recursive: true });
  fs.writeFileSync(BOOK, `${JSON.stringify(book, null, 2)}\n`);
  return book;
}

async function waitFunded(client, address) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const info = await client.request({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      });
      return info.result.account_data.Balance;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`account ${address} was not funded`);
}

async function linesOf(client, account) {
  const page = await client.request({
    command: "account_lines",
    account,
    ledger_index: "validated",
  });
  return page.result.lines || [];
}

async function lpOf(client, holder) {
  const lines = await linesOf(client, holder);
  return {
    lines,
    lp: guard.lpBalanceFromLines(lines, guard.LP_CURRENCY, guard.AMM),
    aeth: guard.iouBalanceFromLines(lines, guard.AETH_HEX, guard.W0),
  };
}

async function accountFlags(client, account) {
  const info = await client.request({
    command: "account_info",
    account,
    ledger_index: "validated",
  });
  return Number(info.result.account_data.Flags || 0);
}

async function credentialEntry(client, index) {
  try {
    const page = await client.request({
      command: "ledger_entry",
      index,
      ledger_index: "validated",
    });
    return page.result.node || page.result;
  } catch (err) {
    const data = err && err.data ? err.data : {};
    const code = data.error || (err && err.message) || "";
    if (String(code).includes("entryNotFound") || String(code).includes("actNotFound")) return null;
    throw err;
  }
}

async function preauthPresent(client, door, issuer, typeHex) {
  const page = await client.request({
    command: "account_objects",
    account: door,
    ledger_index: "validated",
    type: "deposit_preauth",
  });
  const objects = page.result.account_objects || [];
  const want = String(typeHex).toUpperCase();
  return objects.some((obj) => {
    const rows = obj.AuthorizeCredentials || [];
    return rows.some((row) => {
      const cred = row.Credential || row;
      return cred.Issuer === issuer && String(cred.CredentialType).toUpperCase() === want;
    });
  });
}

async function depositAuthorized(client, source, destination, credentialId) {
  const request = {
    command: "deposit_authorized",
    source_account: source,
    destination_account: destination,
    ledger_index: "validated",
  };
  if (credentialId) request.credentials = [credentialId];
  try {
    const page = await client.request(request);
    return { ok: true, deposit_authorized: page.result.deposit_authorized === true };
  } catch (err) {
    const data = err && err.data ? err.data : {};
    return { ok: false, error: data.error || "deposit_authorized_failed" };
  }
}

function expectEngine(view, wanted, label) {
  if (!view.hash) die(`${label} missing hash`);
  if (view.engine !== wanted) die(`${label} ${view.engine || "no-engine"} wanted ${wanted}`);
  console.log(`${label} ${view.hash} ${view.engine} ledger ${view.ledger_index}`);
  return view;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ws = guard.assertXrplTestnetUrl(process.env.XRPL_WS_URL || guard.XRPL_WS);
  const client = new xrpl.Client(ws);
  await client.connect();
  try {
    const info = await client.request({ command: "server_info" });
    const networkId = info.result.info.network_id;
    guard.assertNetworkId(networkId);
    const features = await client.request({ command: "feature" });
    const report = guard.featureReport(features.result.features);
    console.log(
      `Credentials enabled=${report.credentials.enabled} name=${report.credentials.name} hooks=${report.hooks_amendments.join(",") || "none"}`
    );
    guard.assertCredentialsLive(report);
    const build = info.result.info.build_version;
    if (args.dryRun) {
      const book = loadBook();
      console.log(`dry-run server ${build} network ${networkId}`);
      console.log(book ? `book ${BOOK}` : "no address book yet");
      console.log("dry-run does not sign");
      return;
    }

    if (fs.existsSync(TRIAL)) {
      const prior = JSON.parse(fs.readFileSync(TRIAL, "utf8"));
      const hashes = prior.hashes || {};
      if (hashes.holder_pass && hashes.holder_revoked_fail) {
        console.log(`trial already recorded ${hashes.holder_pass} then ${hashes.holder_revoked_fail}`);
        return;
      }
    }

    guard.assertCanSign(process.env);
    let book = loadBook();
    if (!book) {
      const created = {};
      for (const role of guard.ROLES) {
        const funded = await faucetOnce(guard.FAUCET_URL);
        writeSecrets(process.env, [[role.seed, funded.secret]]);
        created[role.id] = {
          role: role.role,
          address: funded.address,
          seed_env: role.seed,
          faucet_hash: funded.hash,
          amount_xrp: funded.amount,
        };
        console.log(`${role.id} ${funded.address} faucet ${funded.hash || "no-hash"}`);
        appendLog({
          ts: new Date().toISOString(),
          action: "lp_badge_bound_faucet",
          network: "XRPL Testnet",
          network_id: guard.NETWORK_ID,
          wallet: role.id,
          role: role.role,
          address: funded.address,
          amount_xrp: funded.amount,
          hash: funded.hash,
        });
        await sleep(1200);
      }
      book = writeBook(created);
      console.log(`wrote public book ${path.relative(ROOT, BOOK)}`);
    }

    const secrets = readSecrets(process.env);
    const wallets = {};
    for (const role of guard.ROLES) {
      const row = book.accounts[role.id];
      if (!row || !row.address) die(`address book missing ${role.id}`);
      const secret = secrets[role.seed];
      if (!secret) die(`missing ${role.seed} in secrets file`);
      const wallet = guard.walletFromSecret(secret, role.seed);
      if (wallet.classicAddress !== row.address) die(`${role.id} seed does not match the address book`);
      wallets[role.id] = wallet;
      await waitFunded(client, row.address);
    }

    const typeHex = guard.credentialTypeHex();
    const uriHex = guard.credentialUriHex(guard.README_URI);
    const issuer = book.accounts.ISSUER.address;
    const holder = book.accounts.HOLDER.address;
    const door = book.accounts.DOOR.address;
    const stranger = book.accounts.STRANGER.address;
    const credentialId = guard.credentialIndex(holder, issuer, typeHex);

    const ammInfo = await client.request({
      command: "amm_info",
      asset: { currency: guard.AETH_HEX, issuer: guard.W0 },
      asset2: { currency: "XRP" },
    });
    const amm = ammInfo.result.amm;
    if (amm.account !== guard.AMM) die(`AMM account ${amm.account} is not the Foundry pool`);
    const lpCurrency = amm.lp_token && amm.lp_token.currency;
    if (String(lpCurrency).toUpperCase() !== guard.LP_CURRENCY) die("LP currency mismatch");

    let position = await lpOf(client, holder);
    console.log(`LP ${position.lp} AETH ${position.aeth} threshold ${guard.LP_THRESHOLD}`);
    if (guard.lpBelowThreshold(position.lp)) {
      const hasTrust = position.lines.some(
        (line) => line.currency === guard.AETH_HEX && line.account === guard.W0
      );
      if (!hasTrust) {
        const trust = expectEngine(
          await submitTx(client, wallets.HOLDER, guard.buildTrustSet(holder)),
          "tesSUCCESS",
          "trustset"
        );
        appendLog({
          ts: new Date().toISOString(),
          action: "lp_badge_bound_trustset",
          network: "XRPL Testnet",
          hash: trust.hash,
          ledger_index: trust.ledger_index,
          account: holder,
        });
      }
      position = await lpOf(client, holder);
      if (guard.lpBelowThreshold(position.aeth, guard.AETH_DEPOSIT_MAX)) {
        const buy = expectEngine(
          await submitTx(client, wallets.HOLDER, guard.buildAethBuy(holder)),
          "tesSUCCESS",
          "aeth-buy"
        );
        appendLog({
          ts: new Date().toISOString(),
          action: "lp_badge_bound_aeth_buy",
          network: "XRPL Testnet",
          hash: buy.hash,
          ledger_index: buy.ledger_index,
          account: holder,
          value: guard.AETH_BUY_VALUE,
        });
      }
      const deposit = expectEngine(
        await submitTx(client, wallets.HOLDER, guard.buildAmmDeposit(holder)),
        "tesSUCCESS",
        "amm-deposit"
      );
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_deposit",
        network: "XRPL Testnet",
        hash: deposit.hash,
        ledger_index: deposit.ledger_index,
        account: holder,
        amm: guard.AMM,
      });
      position = await lpOf(client, holder);
      console.log(`LP after deposit ${position.lp}`);
      if (guard.lpBelowThreshold(position.lp)) {
        die(`LP ${position.lp} still below ${guard.LP_THRESHOLD}; refusing to issue`);
      }
    }

    if (!guard.hasDepositAuth(await accountFlags(client, door))) {
      const set = expectEngine(
        await submitTx(client, wallets.DOOR, guard.buildAccountSetDepositAuth(door)),
        "tesSUCCESS",
        "deposit-auth"
      );
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_deposit_auth",
        network: "XRPL Testnet",
        hash: set.hash,
        ledger_index: set.ledger_index,
        account: door,
      });
    }
    if (!(await preauthPresent(client, door, issuer, typeHex))) {
      const pre = expectEngine(
        await submitTx(client, wallets.DOOR, guard.buildDepositPreauth(door, issuer, typeHex)),
        "tesSUCCESS",
        "deposit-preauth"
      );
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_preauth",
        network: "XRPL Testnet",
        hash: pre.hash,
        ledger_index: pre.ledger_index,
        account: door,
        issuer,
        credential_type: guard.CREDENTIAL_LABEL,
      });
    }

    const strangerFail = expectEngine(
      await submitTx(
        client,
        wallets.STRANGER,
        guard.buildDoorPayment(stranger, door, guard.DOOR_PAYMENT_DROPS)
      ),
      "tecNO_PERMISSION",
      "stranger-fail"
    );

    let entry = await credentialEntry(client, credentialId);
    if (!entry) {
      position = await lpOf(client, holder);
      if (guard.lpBelowThreshold(position.lp)) {
        die(`refusing CredentialCreate at LP ${position.lp}`);
      }
      const created = await submitTx(
        client,
        wallets.ISSUER,
        guard.buildCredentialCreate(issuer, holder, typeHex, uriHex)
      );
      expectEngine(created, "tesSUCCESS", "credential-create");
      const indexed = guard.createdLedgerIndex(created.meta, "Credential");
      if (indexed !== credentialId) die(`credential index ${indexed} != computed ${credentialId}`);
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_credential_create",
        network: "XRPL Testnet",
        hash: created.hash,
        ledger_index: created.ledger_index,
        credential_id: credentialId,
        issuer,
        subject: holder,
        lp: position.lp,
      });
      entry = await credentialEntry(client, credentialId);
    }
    if (!entry) die("credential missing after create");
    if (!guard.credentialAccepted(entry.Flags)) {
      const accepted = expectEngine(
        await submitTx(client, wallets.HOLDER, guard.buildCredentialAccept(holder, issuer, typeHex)),
        "tesSUCCESS",
        "credential-accept"
      );
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_credential_accept",
        network: "XRPL Testnet",
        hash: accepted.hash,
        ledger_index: accepted.ledger_index,
        credential_id: credentialId,
        subject: holder,
      });
      entry = await credentialEntry(client, credentialId);
    }
    if (!entry || !guard.credentialAccepted(entry.Flags)) die("credential was not accepted");

    const authPass = await depositAuthorized(client, holder, door, credentialId);
    const authBare = await depositAuthorized(client, holder, door, null);
    console.log(
      `deposit_authorized presented=${JSON.stringify(authPass)} bare=${JSON.stringify(authBare)}`
    );

    const bareFail = expectEngine(
      await submitTx(client, wallets.HOLDER, guard.buildDoorPayment(holder, door, guard.DOOR_PAYMENT_DROPS)),
      "tecNO_PERMISSION",
      "holder-bare-fail"
    );
    const pass = expectEngine(
      await submitTx(
        client,
        wallets.HOLDER,
        guard.buildDoorPayment(holder, door, guard.DOOR_PAYMENT_DROPS, credentialId)
      ),
      "tesSUCCESS",
      "holder-pass"
    );
    appendLog({
      ts: new Date().toISOString(),
      action: "lp_badge_bound_pass",
      network: "XRPL Testnet",
      hash: pass.hash,
      ledger_index: pass.ledger_index,
      account: holder,
      door,
      credential_id: credentialId,
      lp: (await lpOf(client, holder)).lp,
    });

    position = await lpOf(client, holder);
    if (!guard.lpBelowThreshold(position.lp)) {
      const withdrawn = expectEngine(
        await submitTx(client, wallets.HOLDER, guard.buildAmmWithdrawAll(holder)),
        "tesSUCCESS",
        "amm-withdraw"
      );
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_withdraw",
        network: "XRPL Testnet",
        hash: withdrawn.hash,
        ledger_index: withdrawn.ledger_index,
        account: holder,
        amm: guard.AMM,
      });
      position = await lpOf(client, holder);
    }
    console.log(`LP after withdraw ${position.lp}`);
    if (!guard.lpBelowThreshold(position.lp)) {
      die(`LP ${position.lp} still meets ${guard.LP_THRESHOLD}; refusing to delete`);
    }

    if (await credentialEntry(client, credentialId)) {
      const deleted = expectEngine(
        await submitTx(client, wallets.ISSUER, guard.buildCredentialDelete(issuer, holder, typeHex)),
        "tesSUCCESS",
        "credential-delete"
      );
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_credential_delete",
        network: "XRPL Testnet",
        hash: deleted.hash,
        ledger_index: deleted.ledger_index,
        credential_id: credentialId,
        issuer,
        subject: holder,
        lp: position.lp,
      });
    }
    if (await credentialEntry(client, credentialId)) die("credential still present after delete");

    const revoked = expectEngine(
      await submitTx(
        client,
        wallets.HOLDER,
        guard.buildDoorPayment(holder, door, guard.DOOR_PAYMENT_DROPS, credentialId)
      ),
      "tecBAD_CREDENTIALS",
      "holder-revoked-fail"
    );
    const authAfter = await depositAuthorized(client, holder, door, credentialId);
    console.log(`deposit_authorized after delete ${JSON.stringify(authAfter)}`);

    const trial = {
      network: "XRPL Testnet",
      network_id: guard.NETWORK_ID,
      build_version: build,
      amendment: report.credentials,
      hooks_amendments: report.hooks_amendments,
      hooks_on_xrpl_testnet: false,
      enforcement: "Credentials + DepositPreauth",
      honor_system: false,
      v0_nftoken_id: guard.V0_NFTOKEN_ID,
      v0_honor_system: true,
      v0_note: "The session-7 NFT on W1 is unchanged and still unbound. This trial does not withdraw W1 LP.",
      credential_type: guard.CREDENTIAL_LABEL,
      credential_type_hex: typeHex,
      credential_id: credentialId,
      lp_threshold: guard.LP_THRESHOLD,
      lp_currency: guard.LP_CURRENCY,
      amm: guard.AMM,
      lp_after_withdraw: position.lp,
      accounts: {
        issuer,
        holder,
        door,
        stranger,
      },
      xrpl_twins: { W1: guard.W1, W2: guard.W2 },
      hashes: {
        stranger_fail: strangerFail.hash,
        holder_bare_fail: bareFail.hash,
        holder_pass: pass.hash,
        holder_revoked_fail: revoked.hash,
      },
      ledgers: {
        stranger_fail: strangerFail.ledger_index,
        holder_bare_fail: bareFail.ledger_index,
        holder_pass: pass.ledger_index,
        holder_revoked_fail: revoked.ledger_index,
      },
      engines: {
        stranger_fail: strangerFail.engine,
        holder_bare_fail: bareFail.engine,
        holder_pass: pass.engine,
        holder_revoked_fail: revoked.engine,
      },
      deposit_authorized_before_pass: authPass,
      deposit_authorized_without_credential: authBare,
      deposit_authorized_after_delete: authAfter,
    };
    guard.assertPublicRecord(trial);
    fs.writeFileSync(TRIAL, `${JSON.stringify(trial, null, 2)}\n`);
    if (args.record) {
      appendLog({
        ts: new Date().toISOString(),
        action: "lp_badge_bound_trial",
        network: "XRPL Testnet",
        credential_id: credentialId,
        holder_pass: pass.hash,
        holder_revoked_fail: revoked.hash,
        stranger_fail: strangerFail.hash,
        lp_after_withdraw: position.lp,
        threshold: guard.LP_THRESHOLD,
      });
    }
    console.log(`wrote ${path.relative(ROOT, TRIAL)}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
