"use strict";

/**
 * F3 labor TokenEscrow. Locks 1 AETH-LABOR when lab/metrics.json has
 * mpt_issuance_id, otherwise 1 AETH IOU issued by W0.
 * FinishAfter and CancelAfter are Ripple Epoch. Unix-looking values are refused.
 * This module does not sign on import. Credentials, domains, and Batch are out.
 */

const fs = require("fs");
const path = require("path");
const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const walkIn = require("../walk-in-public");
const { rpcCall } = require("../director/snapshot");
const probe = require("./probe-amendments");
const labor = require("./mpt-labor");
const math = require("./oracle-math");
const policy = require("../runtime/policy");
const metrics = require("../runtime/metrics");
const { rippleNow } = require("../time/rippleEpoch");

const AMENDMENT = "TokenEscrow";
const LOCK_VALUE = "1";
const UNIX_LINE = 1000000000;
const FINISH_DELAY = 120;
const CANCEL_DELAY = 3600;
const REBATE_DELAY = 7 * 24 * 3600;
const REBATE_CAP_DROPS = 1000000n;
const SOURCE_TAG = 202609294;
const INTENT_CREATE = "token_escrow_labor_create";
const INTENT_FINISH = "token_escrow_labor_finish";
const INTENT_CANCEL = "token_escrow_labor_cancel";
const INTENT_REBATE = "token_escrow_labor_rebate";
const README_URL =
  "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/token-escrow-labor/README.md";
const BOX_KEYS = ["W2_REGULAR_SEED", "W4_REGULAR_SEED", "W6_REGULAR_SEED"];
const PAYER = "W2";
const DESK = "W4";
const REBATE_WALLET = "W6";

const HELP = {
  create: `Usage: node src/frontier/token-escrow-create.js [--dry-run] [--live] [--xrpl-http URL]
       [--issuance-id HEX] [--finish-after SEC] [--cancel-after SEC]

--dry-run is the default. It does not read a seed.
Locks 1 AETH-LABOR when lab/metrics.json or --issuance-id has a 48-hex mpt_issuance_id.
Otherwise locks 1 AETH issued by W0. Never locks XRP.
FinishAfter and CancelAfter are Ripple Epoch seconds. A Unix-looking value is refused.
The command refuses network id other than 1 and refuses the transaction when TokenEscrow is disabled.
--live requires FOUNDRY_DAEMON_LIVE=yes and signs with W2_REGULAR_SEED.`,
  finish: `Usage: node src/frontier/token-escrow-finish.js [--dry-run] [--live] [--xrpl-http URL]
       --offer-sequence N [--owner r...] [--quoted DECIMAL] [--rebate]

--dry-run is the default. It does not read a seed.
Prints EscrowFinish for the labor TokenEscrow. Owner defaults to W2. W4 signs --live.
--quoted is the create-time oracle quote. When the live oracle is higher, the JSON
includes a W6 Check rebate of at most 1 XRP. --rebate submits that Check on --live.
The Unix-epoch BUYER escrow is refused. FinishAfter is not a field on this transaction.
The command refuses network id other than 1 and refuses when TokenEscrow is disabled.`,
  cancel: `Usage: node src/frontier/token-escrow-cancel.js [--dry-run] [--live] [--xrpl-http URL]
       --offer-sequence N [--owner r...]

--dry-run is the default. It does not read a seed.
Prints EscrowCancel for the labor TokenEscrow. Owner defaults to W2. W2 signs --live.
The Unix-epoch BUYER escrow is refused. This transaction has no FinishAfter.
The command refuses network id other than 1 and refuses when TokenEscrow is disabled.`,
};

function coded(message, code) {
  return Object.assign(new Error(message), { code: code || "REFUSED" });
}

function parseArgs(argv) {
  const out = {
    dryRun: true,
    live: false,
    help: false,
    rebate: false,
    xrplHttp: null,
    issuanceId: null,
    finishAfter: null,
    cancelAfter: null,
    offerSequence: null,
    owner: null,
    quoted: null,
  };
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--dry-run") && args.includes("--live")) {
    throw coded("pass only one of --dry-run or --live", "ARGS");
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--live") {
      out.live = true;
      out.dryRun = false;
    } else if (arg === "--rebate") out.rebate = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (
      arg === "--xrpl-http" ||
      arg === "--issuance-id" ||
      arg === "--finish-after" ||
      arg === "--cancel-after" ||
      arg === "--offer-sequence" ||
      arg === "--owner" ||
      arg === "--quoted"
    ) {
      const value = args[i + 1];
      i += 1;
      if (!value || value.startsWith("--")) throw coded(`${arg} needs a value`, "ARGS");
      if (arg === "--xrpl-http") out.xrplHttp = value;
      else if (arg === "--issuance-id") out.issuanceId = value;
      else if (arg === "--finish-after") out.finishAfter = value;
      else if (arg === "--cancel-after") out.cancelAfter = value;
      else if (arg === "--offer-sequence") out.offerSequence = value;
      else if (arg === "--owner") out.owner = value;
      else out.quoted = value;
    } else throw coded(`unknown arg ${arg}`, "ARGS");
  }
  return out;
}

function resolveLedger(env, override) {
  try {
    return probe.resolveHttp(env, override);
  } catch (error) {
    if (error && error.code) throw error;
    const message = error && error.message ? error.message : String(error);
    throw coded(message, /mainnet|non-testnet|unparseable/i.test(message) ? "MAINNET" : "RPC");
  }
}

function rowsOf(feature) {
  if (feature && Array.isArray(feature.amendments)) return feature.amendments;
  const raw = feature && feature.features;
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([hash, row]) => Object.assign({ hash }, row || {}));
}

function assertTokenEscrow(feature, verb) {
  const rows = rowsOf(feature);
  if (!rows) throw coded(`feature response omitted features; refusing ${verb}`, "AMENDMENT");
  const row = rows.find((item) => item && item.name === AMENDMENT);
  if (!row) throw coded(`feature response omitted ${AMENDMENT}; refusing ${verb}`, "AMENDMENT");
  const hash = row.hash == null ? null : String(row.hash).toUpperCase();
  const amendment = {
    name: AMENDMENT,
    enabled: row.enabled === true,
    supported: row.supported === true,
    hash: hash && anchors.HASH_RE.test(hash) ? hash : null,
  };
  if (row.enabled !== true) {
    const error = coded(`${AMENDMENT} is disabled; refusing ${verb}`, "AMENDMENT");
    error.amendment = amendment;
    throw error;
  }
  return amendment;
}

function parseTime(value, field) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^[0-9]+$/.test(value)) n = Number(value);
  else throw coded(`${field} is not a Ripple Epoch second`, "EPOCH");
  if (!Number.isInteger(n) || n <= 0) throw coded(`${field} is not a Ripple Epoch second`, "EPOCH");
  if (n > UNIX_LINE) throw coded(`refusing Unix-looking ${field}; time locks are Ripple Epoch only`, "EPOCH");
  return n;
}

function windowFrom(now, finishAfter, cancelAfter) {
  const clock = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const base = rippleNow(clock);
  if (base > UNIX_LINE) throw coded("clock is not in Ripple Epoch range", "EPOCH");
  const finish = finishAfter == null ? base + FINISH_DELAY : parseTime(finishAfter, "FinishAfter");
  const cancel = cancelAfter == null ? base + CANCEL_DELAY : parseTime(cancelAfter, "CancelAfter");
  if (cancel <= finish) throw coded("CancelAfter must be after FinishAfter", "EPOCH");
  return { finish, cancel };
}

function memos(purpose, extra) {
  const list = [grants.memo("purpose", purpose), grants.memo("experiment", "token-escrow-labor")];
  for (const pair of extra || []) list.push(grants.memo(pair[0], pair[1]));
  return list;
}

function metricsIssuanceId(root, io) {
  const disk = io || fs;
  const file = path.join(root, "lab", "metrics.json");
  if (!disk.existsSync(file)) return null;
  const doc = metrics.readMetrics(root, disk);
  return doc && doc.mpt_issuance_id ? doc.mpt_issuance_id : null;
}

function resolveAsset(opts) {
  const options = opts || {};
  const requested = options.issuanceId == null || options.issuanceId === ""
    ? null
    : String(options.issuanceId).toUpperCase();
  const filed = options.filedId == null || options.filedId === ""
    ? null
    : String(options.filedId).toUpperCase();
  if (requested && !labor.isIssuanceId(requested)) throw coded("MPTokenIssuanceID is not 48 hex", "ISSUANCE");
  if (filed && !labor.isIssuanceId(filed)) throw coded("metrics mpt_issuance_id is not 48 hex", "ISSUANCE");
  if (requested && filed && requested !== filed) {
    throw coded("issuance id does not match lab/metrics.json", "MISMATCH");
  }
  const id = requested || filed || null;
  if (id) {
    return {
      kind: "mpt",
      symbol: labor.SYMBOL,
      mpt_issuance_id: id,
      value: LOCK_VALUE,
      amount: { mpt_issuance_id: id, value: LOCK_VALUE },
    };
  }
  return {
    kind: "aeth",
    symbol: "AETH",
    mpt_issuance_id: null,
    value: LOCK_VALUE,
    amount: {
      currency: anchors.AETH_HEX,
      issuer: anchors.WALLETS.W0.address,
      value: LOCK_VALUE,
    },
    note: "mpt_issuance_id is null. This lock is 1 AETH issued by W0. A later create uses AETH-LABOR when metrics has a 48-hex id.",
  };
}

function scale8(text) {
  const raw = String(text == null ? "" : text);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw coded("quote is not a decimal", "QUOTE");
  const parts = raw.split(".");
  if (parts[0].length > 8) throw coded("quote is too large", "QUOTE");
  const padded = ((parts[1] || "") + "00000000").slice(0, 8);
  return BigInt(parts[0]) * 100000000n + BigInt(padded);
}

function rebateDrops(quoted, current) {
  const left = scale8(quoted);
  const right = scale8(current);
  if (right < left) return { drops: null, code: "QUOTE_FELL", capped: false };
  if (right === left) return { drops: null, code: "NO_DRIFT", capped: false };
  const drops = (right - left) / 100n;
  if (drops <= 0n) return { drops: null, code: "DUST", capped: false };
  const capped = drops > REBATE_CAP_DROPS;
  const bounded = capped ? REBATE_CAP_DROPS : drops;
  return { drops: bounded.toString(), code: capped ? "CAPPED" : "DRIFT", capped };
}

function assertNotScar(tx) {
  policy.assertEpochScar(tx);
  const owner = tx.Owner || tx.Account;
  if (owner === policy.EPOCH_SCAR.owner) throw coded("refusing the Unix-epoch BUYER escrow", "EPOCH_SCAR");
  const blob = JSON.stringify(tx).toUpperCase();
  if (blob.includes(policy.EPOCH_SCAR.hash)) throw coded("refusing the Unix-epoch scar hash", "EPOCH_SCAR");
}

function assertBoxTx(tx) {
  if (!tx || typeof tx !== "object") throw coded("refusing empty tx", "TX");
  policy.assertNoSeedFields(tx);
  for (const key of ["CredentialIDs", "DomainID", "RawTransactions", "Condition", "Fulfillment", "ImmutableFlags"]) {
    if (Object.prototype.hasOwnProperty.call(tx, key)) throw coded(`refusing ${key}`, "TX");
  }
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  const type = tx.TransactionType;
  if (type === "EscrowCreate") {
    if (typeof tx.Amount === "string") throw coded("refusing an XRP time-lock; labor locks MPT or AETH", "ASSET");
    if (!tx.Amount || typeof tx.Amount !== "object") throw coded("TokenEscrow Amount is missing", "ASSET");
    if (tx.Amount.mpt_issuance_id) {
      if (!labor.isIssuanceId(String(tx.Amount.mpt_issuance_id))) {
        throw coded("MPTokenIssuanceID is not 48 hex", "ISSUANCE");
      }
      if (String(tx.Amount.value) !== LOCK_VALUE) throw coded("labor lock is 1 unit", "ASSET");
    } else if (tx.Amount.currency === anchors.AETH_HEX) {
      if (tx.Amount.issuer !== anchors.WALLETS.W0.address) throw coded("AETH issuer is not W0", "ASSET");
      if (String(tx.Amount.value) !== LOCK_VALUE) throw coded("labor lock is 1 AETH", "ASSET");
    } else throw coded("refusing an amount that is not AETH-LABOR or AETH", "ASSET");
    if (tx.Account !== anchors.WALLETS[PAYER].address) throw coded("labor TokenEscrow account is not W2", "ACCOUNT");
    if (tx.Destination !== anchors.WALLETS[DESK].address) throw coded("labor TokenEscrow destination is not W4", "ACCOUNT");
    const finish = parseTime(tx.FinishAfter, "FinishAfter");
    const cancel = parseTime(tx.CancelAfter, "CancelAfter");
    if (cancel <= finish) throw coded("CancelAfter must be after FinishAfter", "EPOCH");
  } else if (type === "EscrowFinish" || type === "EscrowCancel") {
    if (Object.prototype.hasOwnProperty.call(tx, "FinishAfter") || Object.prototype.hasOwnProperty.call(tx, "CancelAfter")) {
      throw coded("finish and cancel do not carry a time lock", "EPOCH");
    }
    if (tx.Owner !== anchors.WALLETS[PAYER].address) throw coded("labor TokenEscrow owner is not W2", "ACCOUNT");
    if (!Number.isInteger(tx.OfferSequence) || tx.OfferSequence < 1 || tx.OfferSequence > 0xffffffff) {
      throw coded("offer sequence is not a uint32", "SEQUENCE");
    }
    if (type === "EscrowFinish" && tx.Account !== anchors.WALLETS[DESK].address) {
      throw coded("EscrowFinish account is not W4", "ACCOUNT");
    }
    if (type === "EscrowCancel" && tx.Account !== anchors.WALLETS[PAYER].address) {
      throw coded("EscrowCancel account is not W2", "ACCOUNT");
    }
  } else if (type === "CheckCreate") {
    if (tx.Account !== anchors.WALLETS[REBATE_WALLET].address) throw coded("rebate account is not W6", "ACCOUNT");
    if (tx.Destination !== anchors.WALLETS[PAYER].address) throw coded("rebate destination is not the payer", "ACCOUNT");
    parseTime(tx.Expiration, "Expiration");
    if (typeof tx.SendMax !== "string" || !/^[0-9]+$/.test(tx.SendMax)) throw coded("rebate SendMax is not drops", "ASSET");
    const drops = BigInt(tx.SendMax);
    if (drops <= 0n || drops > REBATE_CAP_DROPS) throw coded("rebate exceeds 1 XRP", "CAP");
  } else throw coded(`refusing ${type || "empty"} in place of TokenEscrow`, "TX");
  assertNotScar(tx);
  return tx;
}

function buildDeliverable(asset, quote) {
  const id = asset && asset.mpt_issuance_id ? asset.mpt_issuance_id : "";
  const query = asset && asset.kind === "mpt"
    ? `mpt=${id}&symbol=${encodeURIComponent(labor.SYMBOL)}`
    : "asset=AETH";
  const price = quote && quote.quote_xrp_per_aeth ? `&quote=${encodeURIComponent(quote.quote_xrp_per_aeth)}` : "";
  const uri = `${README_URL}#${query}${price}`;
  if (Buffer.byteLength(uri, "utf8") > 256) throw coded("NFT URI is longer than 256 bytes", "URI");
  return {
    submitted: false,
    note: "Unsigned NFT deliverable. The create command does not submit it.",
    mint: {
      TransactionType: "NFTokenMint",
      Account: anchors.WALLETS[PAYER].address,
      URI: walkIn.toHexUri(uri),
      Flags: walkIn.TF_TRANSFERABLE,
      TransferFee: walkIn.TRANSFER_FEE,
      NFTokenTaxon: walkIn.TAXON,
    },
  };
}

function buildCreate(opts) {
  const options = opts || {};
  const asset = options.asset || resolveAsset({});
  if (asset.kind !== "mpt" && asset.kind !== "aeth") throw coded("unknown labor asset", "ASSET");
  const times = windowFrom(options.now, options.finishAfter, options.cancelAfter);
  const quoteText = options.quote && options.quote.quote_xrp_per_aeth ? options.quote.quote_xrp_per_aeth : "none";
  const tx = {
    TransactionType: "EscrowCreate",
    Account: anchors.WALLETS[PAYER].address,
    Destination: anchors.WALLETS[DESK].address,
    Amount: asset.amount,
    FinishAfter: times.finish,
    CancelAfter: times.cancel,
    SourceTag: SOURCE_TAG,
    Memos: memos("aether-labor-escrow", [
      ["asset", asset.kind === "mpt" ? `mpt:${asset.mpt_issuance_id}` : "aeth"],
      ["quote", quoteText],
    ]),
  };
  assertBoxTx(tx);
  return { tx, asset, deliverable: buildDeliverable(asset, options.quote) };
}

function parseSequence(raw) {
  if (raw == null || raw === "") throw coded("pass --offer-sequence from the EscrowCreate", "MISSING_SEQUENCE");
  let n;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) n = Number(raw);
  else throw coded("offer sequence is not an integer", "SEQUENCE");
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw coded("offer sequence is not a uint32", "SEQUENCE");
  return n;
}

function parseOwner(raw) {
  const owner = raw || anchors.WALLETS[PAYER].address;
  if (owner === policy.EPOCH_SCAR.owner) throw coded("refusing the Unix-epoch BUYER escrow", "EPOCH_SCAR");
  if (!anchors.ADDRESS_RE.test(owner)) throw coded("owner is not a classic address", "ACCOUNT");
  if (owner !== anchors.WALLETS[PAYER].address) throw coded("labor TokenEscrow owner is W2", "ACCOUNT");
  return owner;
}

function buildFinish(opts) {
  const options = opts || {};
  const owner = parseOwner(options.owner);
  const sequence = parseSequence(options.offerSequence);
  const tx = {
    TransactionType: "EscrowFinish",
    Account: anchors.WALLETS[DESK].address,
    Owner: owner,
    OfferSequence: sequence,
    SourceTag: SOURCE_TAG,
    Memos: memos("aether-labor-finish"),
  };
  assertBoxTx(tx);
  return { tx, owner, offerSequence: sequence };
}

function buildCancel(opts) {
  const options = opts || {};
  const owner = parseOwner(options.owner);
  const sequence = parseSequence(options.offerSequence);
  const tx = {
    TransactionType: "EscrowCancel",
    Account: anchors.WALLETS[PAYER].address,
    Owner: owner,
    OfferSequence: sequence,
    SourceTag: SOURCE_TAG,
    Memos: memos("aether-labor-cancel"),
  };
  assertBoxTx(tx);
  return { tx, owner, offerSequence: sequence };
}

function buildRebate(opts) {
  const options = opts || {};
  const now = options.now instanceof Date ? options.now : new Date(options.now == null ? Date.now() : options.now);
  const priced = rebateDrops(options.quoted, options.current);
  if (!priced.drops) {
    return {
      tx: null,
      code: priced.code,
      drops: null,
      quoted: String(options.quoted),
      current: String(options.current),
      expiration: null,
      capped: false,
      key_env: null,
    };
  }
  const expiration = options.expiration == null
    ? rippleNow(now) + REBATE_DELAY
    : parseTime(options.expiration, "Expiration");
  const tx = {
    TransactionType: "CheckCreate",
    Account: anchors.WALLETS[REBATE_WALLET].address,
    Destination: anchors.WALLETS[PAYER].address,
    SendMax: priced.drops,
    Expiration: expiration,
    SourceTag: SOURCE_TAG,
    Memos: memos("aether-labor-rebate", [
      ["quoted", String(options.quoted)],
      ["current", String(options.current)],
    ]),
  };
  assertBoxTx(tx);
  return {
    tx,
    code: priced.code,
    drops: priced.drops,
    quoted: String(options.quoted),
    current: String(options.current),
    expiration,
    capped: priced.capped,
    key_env: "W6_REGULAR_SEED",
  };
}

async function readQuote(http, fetchImpl) {
  try {
    const entry = await rpcCall(http, "ledger_entry", math.ledgerEntryParams(), fetchImpl || globalThis.fetch);
    const price = math.readOraclePrice(entry);
    if (price.account !== anchors.WALLETS.W5.address) {
      return { quote_xrp_per_aeth: null, oracle_id: null, code: "ORACLE_MISSING" };
    }
    return {
      quote_xrp_per_aeth: price.quote_xrp_per_aeth,
      oracle_id: price.oracle_id,
      code: "LEDGER",
      source: "ledger_entry",
    };
  } catch {
    return { quote_xrp_per_aeth: null, oracle_id: null, code: "ORACLE_MISSING", source: null };
  }
}

function failDraft(opened, error) {
  return {
    allow: false,
    code: (error && error.code) || "REFUSED",
    message: error && error.message ? error.message : String(error),
    http: opened && opened.http,
    network_id: opened && opened.server ? opened.server.network_id : null,
    build_version: opened && opened.server ? opened.server.build_version : null,
    amendment: (error && error.amendment) || null,
    asset: null,
    quote: null,
    predicted_sequence: null,
    deliverable: null,
    rebate: null,
    tx: null,
    owner: null,
    offer_sequence: null,
  };
}

async function openLedger(options) {
  const http = resolveLedger(options.env || {}, options.xrplHttp || null);
  let server = null;
  try {
    const info = await rpcCall(http, "server_info", {}, options.fetchImpl || globalThis.fetch);
    server = probe.readServer(info);
    const feature = await rpcCall(http, "feature", {}, options.fetchImpl || globalThis.fetch);
    return { http, server, feature };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return { http, server, feature: null, error };
  }
}

async function planCreate(options) {
  const opened = await openLedger(options);
  if (opened.error) return failDraft(opened, opened.error);
  try {
    const amendment = assertTokenEscrow(opened.feature, "EscrowCreate");
    const filed = metricsIssuanceId(options.root || anchors.repoRoot(), options.io);
    const asset = resolveAsset({ issuanceId: options.issuanceId, filedId: filed });
    if (asset.kind === "mpt") labor.assertMptEnabled(opened.feature, "MPT TokenEscrow");
    const quote = await readQuote(opened.http, options.fetchImpl);
    let predicted = null;
    try {
      const account = await rpcCall(
        opened.http,
        "account_info",
        { account: anchors.WALLETS[PAYER].address, ledger_index: "validated" },
        options.fetchImpl || globalThis.fetch
      );
      const seq = account && account.account_data ? account.account_data.Sequence : null;
      if (Number.isInteger(seq) && seq > 0) predicted = seq;
    } catch (error) {
      if (error && error.code === "MAINNET") throw error;
      predicted = null;
    }
    const built = buildCreate({
      now: options.now,
      asset,
      quote,
      finishAfter: options.finishAfter,
      cancelAfter: options.cancelAfter,
    });
    const noun = asset.kind === "mpt" ? labor.SYMBOL : "AETH";
    return {
      allow: true,
      code: "DRY_RUN",
      message: asset.kind === "mpt"
        ? `unsigned TokenEscrow of ${LOCK_VALUE} ${noun} to W4`
        : `unsigned TokenEscrow of ${LOCK_VALUE} ${noun} to W4; mpt_issuance_id is null`,
      http: opened.http,
      network_id: opened.server.network_id,
      build_version: opened.server.build_version,
      amendment,
      asset,
      quote,
      predicted_sequence: predicted,
      deliverable: built.deliverable,
      rebate: null,
      tx: built.tx,
      owner: anchors.WALLETS[PAYER].address,
      offer_sequence: null,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return failDraft(opened, error);
  }
}

async function planFinish(options) {
  const opened = await openLedger(options);
  if (opened.error) return failDraft(opened, opened.error);
  try {
    const amendment = assertTokenEscrow(opened.feature, "EscrowFinish");
    const built = buildFinish({ owner: options.owner, offerSequence: options.offerSequence });
    let rebate = { tx: null, code: "MISSING_QUOTE", drops: null, quoted: null, current: null, expiration: null, key_env: null };
    if (options.quoted) {
      const live = await readQuote(opened.http, options.fetchImpl);
      if (!live.quote_xrp_per_aeth) {
        rebate = {
          tx: null,
          code: "ORACLE_MISSING",
          drops: null,
          quoted: options.quoted,
          current: null,
          expiration: null,
          key_env: null,
        };
      } else {
        rebate = buildRebate({ quoted: options.quoted, current: live.quote_xrp_per_aeth, now: options.now });
        rebate.oracle_id = live.oracle_id;
      }
    }
    return {
      allow: true,
      code: "DRY_RUN",
      message: `unsigned EscrowFinish of labor TokenEscrow sequence ${built.offerSequence}`,
      http: opened.http,
      network_id: opened.server.network_id,
      build_version: opened.server.build_version,
      amendment,
      asset: null,
      quote: null,
      predicted_sequence: null,
      deliverable: null,
      rebate,
      tx: built.tx,
      owner: built.owner,
      offer_sequence: built.offerSequence,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return failDraft(opened, error);
  }
}

async function planCancel(options) {
  const opened = await openLedger(options);
  if (opened.error) return failDraft(opened, opened.error);
  try {
    const amendment = assertTokenEscrow(opened.feature, "EscrowCancel");
    const built = buildCancel({ owner: options.owner, offerSequence: options.offerSequence });
    return {
      allow: true,
      code: "DRY_RUN",
      message: `unsigned EscrowCancel of labor TokenEscrow sequence ${built.offerSequence}`,
      http: opened.http,
      network_id: opened.server.network_id,
      build_version: opened.server.build_version,
      amendment,
      asset: null,
      quote: null,
      predicted_sequence: null,
      deliverable: null,
      rebate: null,
      tx: built.tx,
      owner: built.owner,
      offer_sequence: built.offerSequence,
    };
  } catch (error) {
    if (error && (error.code === "MAINNET" || error.code === "ARGS")) throw error;
    return failDraft(opened, error);
  }
}

function shellBody(command, mode, draft, seedReads) {
  const keyEnv = command === "finish" ? "W4_REGULAR_SEED" : "W2_REGULAR_SEED";
  const intent = command === "finish" ? INTENT_FINISH : command === "cancel" ? INTENT_CANCEL : INTENT_CREATE;
  const body = {
    mode: mode.live ? "live" : "dry-run",
    signed: false,
    submitted: false,
    key_loaded: seedReads > 0,
    key_env: keyEnv,
    network: "xrpl:1",
    network_id: draft.network_id,
    action: intent,
    intent,
    allow: draft.allow,
    code: draft.code,
    message: draft.message,
    amendment: draft.amendment,
    tx: draft.tx,
  };
  if (command === "create") {
    body.asset = draft.asset;
    body.quote = draft.quote;
    body.mpt_issuance_id = draft.asset ? draft.asset.mpt_issuance_id : null;
    body.predicted_sequence = draft.predicted_sequence;
    body.deliverable = draft.deliverable;
    body.signer = "box RegularKey W2";
  } else if (command === "finish") {
    body.owner = draft.owner;
    body.offer_sequence = draft.offer_sequence;
    body.rebate = draft.rebate;
    body.signer = "box RegularKey W4";
  } else {
    body.owner = draft.owner;
    body.offer_sequence = draft.offer_sequence;
    body.signer = "box RegularKey W2";
  }
  return body;
}

function directorState(root, options) {
  if (options.state) return options.state;
  const daemon = options.daemon || require("../runtime/daemon");
  const loaded = daemon.loadState(root);
  if (!loaded || loaded.missing || !loaded.state) throw coded("refusing --live without director state", "STALE");
  return loaded.state;
}

function escrowIndexFromMeta(meta) {
  const nodes = meta && Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
  for (const row of nodes) {
    const created = row && row.CreatedNode;
    if (!created || created.LedgerEntryType !== "Escrow") continue;
    const index = String(created.LedgerIndex || "").toUpperCase();
    if (anchors.HASH_RE.test(index)) return index;
  }
  return null;
}

async function submitBox(tx, keyEnv, regularAddress, env, loadSeed) {
  policy.assertLiveGate(env);
  assertBoxTx(tx);
  if (!BOX_KEYS.includes(keyEnv)) throw coded(`refusing seed key ${keyEnv}`, "SEED");
  const seed = loadSeed(keyEnv);
  if (!seed) throw coded(`${keyEnv} is not loaded. Refusing to sign.`, "NO_SEED");
  const xrpl = require("xrpl");
  let wallet;
  try {
    wallet = xrpl.Wallet.fromSeed(seed);
  } catch {
    throw coded(`${keyEnv} is not a usable seed`, "NO_SEED");
  }
  const signer = wallet.classicAddress || wallet.address;
  if (signer !== regularAddress) throw coded(`${keyEnv} address is not the regular key`, "SIGNER");
  policy.assertSigningRpc(anchors.XRPL_WS);
  const client = new xrpl.Client(anchors.XRPL_WS);
  await client.connect();
  try {
    if (client.networkID !== anchors.XRPL_NETWORK_ID) {
      throw coded(
        `RPC did not prove XRPL Testnet network id (${client.networkID == null ? "missing" : client.networkID})`,
        "MAINNET"
      );
    }
    const prepared = await client.autofill(tx);
    if (prepared.NetworkID === 0) throw coded("refusing NetworkID 0", "MAINNET");
    assertBoxTx(prepared);
    const signed = wallet.sign(prepared);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const result = (submitted && submitted.result) || submitted || {};
    const meta = result.meta || result.metaData || {};
    if (meta.TransactionResult !== "tesSUCCESS" || !result.hash) {
      throw coded(`result ${meta.TransactionResult || "missing"}`, "SUBMIT");
    }
    return {
      hash: String(result.hash).toUpperCase(),
      result: "tesSUCCESS",
      ledger_index: result.ledger_index == null ? null : result.ledger_index,
      sequence: Number.isInteger(prepared.Sequence) ? prepared.Sequence : null,
      meta,
    };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

function printBody(body) {
  policy.assertNoSeedFields(body);
  const text = JSON.stringify(body, null, 2);
  policy.assertPrintSafe(text);
  return text;
}

function flagGuard(command, mode) {
  if (command !== "finish" && mode.rebate) throw coded("--rebate is only valid on finish", "ARGS");
  if (command !== "finish" && mode.quoted) throw coded("--quoted is only valid on finish", "ARGS");
  if (command !== "create" && (mode.finishAfter != null || mode.cancelAfter != null)) {
    throw coded("FinishAfter and CancelAfter belong on the create command", "ARGS");
  }
  if (command === "create" && (mode.offerSequence != null || mode.owner)) {
    throw coded("create does not take --offer-sequence or --owner", "ARGS");
  }
  if (command !== "create" && mode.issuanceId) throw coded("--issuance-id belongs on the create command", "ARGS");
}

async function runCommand(argv, deps, command) {
  const options = deps || {};
  const mode = parseArgs(argv);
  const write = options.stdout || ((text) => console.log(text));
  if (mode.help) {
    write(HELP[command]);
    return 0;
  }
  flagGuard(command, mode);
  const env = options.env || process.env;
  const now = options.now || new Date();
  const root = options.root || anchors.repoRoot();
  let seedReads = 0;
  const loadSeed = (name) => {
    seedReads += 1;
    if (!mode.live) throw coded("dry-run read a seed", "SEED");
    const reader = options.loadSeed || ((key) => {
      const daemon = require("../runtime/daemon");
      return daemon.readSeed(key, env, options.io, BOX_KEYS);
    });
    return reader(name);
  };
  if (mode.live) {
    policy.assertLiveGate(env);
    policy.assertAltnet({ networkId: anchors.XRPL_NETWORK_ID, url: mode.xrplHttp || anchors.XRPL_HTTP });
  }
  const plan = command === "finish" ? planFinish : command === "cancel" ? planCancel : planCreate;
  const draft = await plan({
    env,
    root,
    io: options.io,
    now,
    xrplHttp: mode.xrplHttp,
    fetchImpl: options.fetchImpl,
    issuanceId: mode.issuanceId,
    finishAfter: mode.finishAfter,
    cancelAfter: mode.cancelAfter,
    offerSequence: mode.offerSequence,
    owner: mode.owner,
    quoted: mode.quoted,
  });
  if (!mode.live) {
    write(printBody(shellBody(command, mode, draft, seedReads)));
    return draft.allow ? 0 : 2;
  }
  if (!draft.allow || !draft.tx) throw coded(draft.message || "TokenEscrow refused", draft.code || "REFUSED");
  const state = directorState(root, options);
  policy.assertFreshForSign(state, now);
  const walletId = command === "finish" ? DESK : PAYER;
  const keyEnv = command === "finish" ? "W4_REGULAR_SEED" : "W2_REGULAR_SEED";
  const regular = policy.regularKey(state, walletId);
  const daemon = options.daemon || require("../runtime/daemon");
  const submit = options.submit
    ? async (tx, envName, regularKey) => {
        loadSeed(envName);
        return options.submit(tx, envName, regularKey);
      }
    : (tx, envName, regularKey) => submitBox(tx, envName, regularKey, env, loadSeed);
  const submitted = await submit(draft.tx, keyEnv, regular);
  if (!submitted || submitted.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(submitted.hash || "").toUpperCase())) {
    throw coded(`${draft.tx.TransactionType} did not succeed`, "SUBMIT");
  }
  const intent = command === "finish" ? INTENT_FINISH : command === "cancel" ? INTENT_CANCEL : INTENT_CREATE;
  const row = {
    ts: now.toISOString(),
    action: intent,
    intent,
    network: "XRPL Testnet",
    network_id: 1,
    account: draft.tx.Account,
    destination: draft.tx.Destination || null,
    owner: draft.tx.Owner || draft.tx.Account,
    hash: String(submitted.hash).toUpperCase(),
    result: "tesSUCCESS",
    ledger_index: Number.isInteger(submitted.ledger_index) ? submitted.ledger_index : null,
    offer_sequence: command === "create"
      ? (Number.isInteger(submitted.sequence) ? submitted.sequence : null)
      : draft.offer_sequence,
    escrow_index: command === "create" ? escrowIndexFromMeta(submitted.meta) : null,
    mpt_issuance_id: draft.asset ? draft.asset.mpt_issuance_id : null,
    asset: draft.asset ? draft.asset.kind : null,
    finish_after: draft.tx.FinishAfter == null ? null : draft.tx.FinishAfter,
    cancel_after: draft.tx.CancelAfter == null ? null : draft.tx.CancelAfter,
  };
  if (options.archive !== false) {
    const archive = options.archive || ((entry) => daemon.archive(root, entry));
    archive(row);
  }
  let rebateBody = draft.rebate;
  let rebateFailed = false;
  if (command === "finish" && mode.rebate && draft.rebate && draft.rebate.tx) {
    try {
      const rebateKey = policy.regularKey(state, REBATE_WALLET);
      const rebated = await submit(draft.rebate.tx, "W6_REGULAR_SEED", rebateKey);
      if (!rebated || rebated.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(rebated.hash || "").toUpperCase())) {
        throw coded("CheckCreate did not succeed", "SUBMIT");
      }
      const rebateRow = {
        ts: now.toISOString(),
        action: INTENT_REBATE,
        intent: INTENT_REBATE,
        network: "XRPL Testnet",
        network_id: 1,
        account: anchors.WALLETS.W6.address,
        destination: anchors.WALLETS.W2.address,
        hash: String(rebated.hash).toUpperCase(),
        result: "tesSUCCESS",
        ledger_index: Number.isInteger(rebated.ledger_index) ? rebated.ledger_index : null,
        drops: draft.rebate.drops,
        offer_sequence: draft.offer_sequence,
      };
      if (options.archive !== false) {
        const archive = options.archive || ((entry) => daemon.archive(root, entry));
        archive(rebateRow);
      }
      rebateBody = Object.assign({}, draft.rebate, {
        submitted: true,
        hash: rebateRow.hash,
        ledger_index: rebateRow.ledger_index,
      });
    } catch (error) {
      rebateFailed = true;
      rebateBody = Object.assign({}, draft.rebate, {
        submitted: false,
        hash: null,
        error: error && error.message ? error.message : String(error),
      });
    }
  }
  const body = shellBody(command, mode, Object.assign({}, draft, { rebate: rebateBody }), seedReads);
  body.mode = "live";
  body.signed = true;
  body.submitted = true;
  body.code = "SUBMITTED";
  body.hash = row.hash;
  body.result = "tesSUCCESS";
  body.ledger_index = row.ledger_index;
  body.offer_sequence = row.offer_sequence;
  body.escrow_index = row.escrow_index;
  write(printBody(body));
  return rebateFailed ? 1 : 0;
}

module.exports = {
  AMENDMENT,
  LOCK_VALUE,
  UNIX_LINE,
  FINISH_DELAY,
  CANCEL_DELAY,
  REBATE_DELAY,
  REBATE_CAP_DROPS,
  SOURCE_TAG,
  INTENT_CREATE,
  INTENT_FINISH,
  INTENT_CANCEL,
  INTENT_REBATE,
  README_URL,
  BOX_KEYS,
  HELP,
  coded,
  parseArgs,
  assertTokenEscrow,
  parseTime,
  assertRippleTime: parseTime,
  resolveAsset,
  rebateDrops,
  assertBoxTx,
  buildDeliverable,
  buildCreate,
  buildFinish,
  buildCancel,
  buildRebate,
  metricsIssuanceId,
  escrowIndexFromMeta,
  submitBox,
  planCreate,
  planFinish,
  planCancel,
  runCommand,
};
