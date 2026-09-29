"use strict";

/**
 * F4 credential domain shop. Pure transaction shapes.
 * Issuer is W5. Type is aether-agent. Open Walk-In is not a domain offer.
 * This module does not sign and does not read a seed.
 */

const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const grants = require("../grants/policy");
const guard = require("../lp-badge-bound-guard");
const labeled = require("../x402-outbound-guard");

const CREDENTIAL_TYPE = "aether-agent";
const LP_DOOR_TYPE = "aether-lp-ok";
const DOMAIN_SPACE = "006d";
const TF_HYBRID = 0x00100000;
const SOURCE_TAG = 202609294;
const CURRENCY = "AGT";
const TRUST_LIMIT = "100";
const FUND_VALUE = "5";
const OFFER_VALUE = "1";
const OFFER_DROPS = "20000";
const INTENT = "credential_domain_shop";
const README_URI =
  "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/credential-domain-shop/README.md";

const AMENDMENTS = {
  Credentials: "1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF",
  PermissionedDomains: "A730EB18A9D4BB52502C898589558B4CCEB4BE10044500EE5581137A2E80E849",
  PermissionedDEX: "677E401A423E3708363A36BA8B3A7D019D21AC5ABD00387BDBEA6BDE4C91247E",
};

const STEP_IDS = [
  "trust_issuer",
  "trust_agent",
  "trust_stranger",
  "fund_issuer",
  "fund_agent",
  "fund_stranger",
  "credential_create",
  "credential_accept",
  "permissioned_domain_set",
  "domain_offer",
  "uncredentialed_offer",
  "credentialed_take",
];

const UNCREDENTIALED_ENGINE = "tecNO_PERMISSION";

function coded(message, code) {
  return Object.assign(new Error(message), { code: code || "REFUSED" });
}

function shapeAddress(fill) {
  return xrpl.encodeAccountID(Buffer.alloc(20, fill));
}

const SHAPE = {
  agent: shapeAddress(0x11),
  stranger: shapeAddress(0x22),
  mint: shapeAddress(0x33),
};

function rowsOf(feature) {
  if (feature && Array.isArray(feature.amendments)) return feature.amendments;
  const raw = feature && feature.features;
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([hash, row]) => Object.assign({ hash }, row || {}));
}

function assertShopAmendments(feature) {
  const rows = rowsOf(feature);
  if (!rows) throw coded("feature response omitted features", "AMENDMENT");
  const out = {};
  const blocked = [];
  for (const name of Object.keys(AMENDMENTS)) {
    const row = rows.find((item) => item && item.name === name);
    if (!row) {
      blocked.push(`${name} omitted`);
      continue;
    }
    const hash = row.hash == null ? "" : String(row.hash).toUpperCase();
    if (hash !== AMENDMENTS[name]) blocked.push(`${name} hash is not the Testnet amendment`);
    if (row.enabled !== true) blocked.push(`${name} is disabled`);
    out[name] = {
      name,
      enabled: row.enabled === true,
      supported: row.supported === true,
      hash: hash || null,
    };
  }
  if (blocked.length) {
    throw coded(`${blocked.join("; ")}; refusing CredentialCreate, PermissionedDomainSet, and domain OfferCreate`, "AMENDMENT");
  }
  return out;
}

function assertClassic(address, role) {
  if (!anchors.ADDRESS_RE.test(address || "") || !xrpl.isValidClassicAddress(address)) {
    throw coded(`${role} is not a classic address`, "ACCOUNT");
  }
}

function assertShopAccounts(accounts) {
  const row = accounts || {};
  assertClassic(row.issuer, "issuer");
  assertClassic(row.agent, "agent");
  assertClassic(row.stranger, "stranger");
  assertClassic(row.mint, "mint");
  if (row.issuer !== anchors.WALLETS.W5.address) {
    throw coded("credential issuer Account is not W5", "ACCOUNT");
  }
  if (row.issuer === anchors.WALLETS.W0.address) throw coded("refusing to issue from W0", "W0");
  const index = labeled.foundryIndex();
  for (const role of ["agent", "stranger", "mint"]) {
    if (row[role] === anchors.WALLETS.W0.address) throw coded(`refusing ${role} as W0`, "W0");
    const id = index.get(row[role]);
    if (id) throw coded(`refusing labeled ${role} ${id}`, "ACCOUNT");
  }
  const ids = [row.issuer, row.agent, row.stranger, row.mint];
  if (new Set(ids).size !== ids.length) throw coded("shop accounts must be distinct", "ACCOUNT");
  return {
    issuer: row.issuer,
    agent: row.agent,
    stranger: row.stranger,
    mint: row.mint,
  };
}

function shapeAccounts() {
  return assertShopAccounts({
    issuer: anchors.WALLETS.W5.address,
    agent: SHAPE.agent,
    stranger: SHAPE.stranger,
    mint: SHAPE.mint,
  });
}

function domainIndex(owner, sequence) {
  assertClassic(owner, "domain owner");
  const seq = Number(sequence);
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw coded("domain sequence is not a uint32", "SEQUENCE");
  }
  const seqHex = seq.toString(16).padStart(8, "0");
  const ownerHex = Buffer.from(xrpl.decodeAccountID(owner)).toString("hex");
  return guard.sha512Half(DOMAIN_SPACE + ownerHex + seqHex);
}

function domainIdFromMeta(meta) {
  return guard.createdLedgerIndex(meta, "PermissionedDomain");
}

function typeHex() {
  return guard.credentialTypeHex(CREDENTIAL_TYPE);
}

function assertNotHybrid(tx) {
  const flags = tx && tx.Flags ? Number(tx.Flags) : 0;
  if ((flags & TF_HYBRID) !== 0) {
    throw coded("refusing tfHybrid; a domain offer must not rest on the open DEX", "HYBRID");
  }
}

function assertNotWalkIn(tx) {
  if (!tx || typeof tx !== "object") throw coded("refusing empty tx", "TX");
  const banned = ["NFTokenMint", "NFTokenCreateOffer", "NFTokenAcceptOffer", "NFTokenCancelOffer", "Batch", "Sponsor"];
  if (banned.includes(tx.TransactionType)) {
    throw coded(`refusing ${tx.TransactionType} in the domain shop`, "TX");
  }
  if (tx.Account === anchors.WALLETS.W2.address && tx.TransactionType === "OfferCreate") {
    throw coded("refusing to place the domain offer on W2", "WALK_IN");
  }
  if (tx.TransactionType && /vault/i.test(tx.TransactionType)) {
    throw coded(`refusing ${tx.TransactionType}`, "TX");
  }
}

function memos(purpose) {
  return [grants.memo("purpose", purpose), grants.memo("experiment", INTENT)];
}

function iou(mint, value) {
  return { currency: CURRENCY, issuer: mint, value: String(value) };
}

function buildTrustSet(account, mint) {
  const tx = {
    TransactionType: "TrustSet",
    Account: account,
    LimitAmount: iou(mint, TRUST_LIMIT),
    SourceTag: SOURCE_TAG,
    Memos: memos("domain-shop-trust"),
  };
  assertNotWalkIn(tx);
  return tx;
}

function buildMintPayment(mint, destination) {
  const tx = {
    TransactionType: "Payment",
    Account: mint,
    Destination: destination,
    Amount: iou(mint, FUND_VALUE),
    SourceTag: SOURCE_TAG,
    Memos: memos("domain-shop-fund"),
  };
  assertNotWalkIn(tx);
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to pay from W0", "W0");
  return tx;
}

function buildCredentialCreate(issuer, subject) {
  if (issuer === anchors.WALLETS.W0.address) throw coded("refusing CredentialCreate from W0", "W0");
  if (issuer !== anchors.WALLETS.W5.address) throw coded("CredentialCreate Account is not W5", "ACCOUNT");
  const tx = guard.buildCredentialCreate(issuer, subject, typeHex(), guard.credentialUriHex(README_URI));
  tx.SourceTag = SOURCE_TAG;
  tx.Memos = memos("credential-create");
  if (tx.CredentialType === guard.credentialTypeHex(LP_DOOR_TYPE)) {
    throw coded("refusing aether-lp-ok; the LP door checks LP and this shop does not", "TYPE");
  }
  assertNotWalkIn(tx);
  return tx;
}

function buildCredentialAccept(subject, issuer) {
  const tx = guard.buildCredentialAccept(subject, issuer, typeHex());
  tx.SourceTag = SOURCE_TAG;
  tx.Memos = memos("credential-accept");
  assertNotWalkIn(tx);
  return tx;
}

function buildPermissionedDomainSet(owner, issuer) {
  if (owner !== anchors.WALLETS.W5.address) throw coded("PermissionedDomainSet Account is not W5", "ACCOUNT");
  if (owner === anchors.WALLETS.W0.address) throw coded("refusing PermissionedDomainSet from W0", "W0");
  const tx = {
    TransactionType: "PermissionedDomainSet",
    Account: owner,
    AcceptedCredentials: [
      {
        Credential: {
          Issuer: issuer,
          CredentialType: typeHex(),
        },
      },
    ],
    SourceTag: SOURCE_TAG,
    Memos: memos("permissioned-domain-set"),
  };
  assertNotWalkIn(tx);
  return tx;
}

function domainOffer(account, mint, domainId, takerGets, takerPays) {
  if (domainId != null && !anchors.HASH_RE.test(String(domainId).toUpperCase())) {
    throw coded("DomainID is not 64 hex", "DOMAIN");
  }
  const tx = {
    TransactionType: "OfferCreate",
    Account: account,
    TakerGets: takerGets,
    TakerPays: takerPays,
    SourceTag: SOURCE_TAG,
    Memos: memos("domain-offer"),
  };
  if (domainId) tx.DomainID = String(domainId).toUpperCase();
  assertNotHybrid(tx);
  assertNotWalkIn(tx);
  if (Object.prototype.hasOwnProperty.call(tx, "CredentialIDs")) {
    throw coded("domain OfferCreate does not carry CredentialIDs", "TX");
  }
  return tx;
}

function buildDomainOffer(owner, mint, domainId) {
  return domainOffer(owner, mint, domainId, iou(mint, OFFER_VALUE), OFFER_DROPS);
}

function buildTakeOffer(account, mint, domainId) {
  return domainOffer(account, mint, domainId, OFFER_DROPS, iou(mint, OFFER_VALUE));
}

function adversaryCase(accounts, domainId) {
  const row = assertShopAccounts(accounts);
  const tx = buildTakeOffer(row.stranger, row.mint, domainId || null);
  return {
    case: "uncredentialed OfferCreate with DomainID",
    account: row.stranger,
    expected_engine: UNCREDENTIALED_ENGINE,
    live_verified: false,
    hash: null,
    domain_id: domainId ? String(domainId).toUpperCase() : null,
    tx,
    note: "Documented for live verification. An uncredentialed account is refused by the domain, not by this file. Do not invent the hash.",
  };
}

function keyEnv(id) {
  if (id === "trust_issuer" || id === "credential_create" || id === "permissioned_domain_set" || id === "domain_offer") {
    return "W5_REGULAR_SEED";
  }
  if (id === "trust_agent" || id === "credential_accept" || id === "credentialed_take") return "CDS_AGENT_SEED";
  if (id === "trust_stranger" || id === "uncredentialed_offer") return "CDS_STRANGER_SEED";
  if (id === "fund_issuer" || id === "fund_agent" || id === "fund_stranger") return "CDS_MINT_SEED";
  throw coded(`unknown step ${id}`, "TX");
}

function expectEngine(id) {
  if (id === "uncredentialed_offer") return UNCREDENTIALED_ENGINE;
  if (!STEP_IDS.includes(id)) throw coded(`unknown step ${id}`, "TX");
  return "tesSUCCESS";
}

function buildStep(id, accounts, domainId) {
  const row = assertShopAccounts(accounts);
  if (id === "trust_issuer") return buildTrustSet(row.issuer, row.mint);
  if (id === "trust_agent") return buildTrustSet(row.agent, row.mint);
  if (id === "trust_stranger") return buildTrustSet(row.stranger, row.mint);
  if (id === "fund_issuer") return buildMintPayment(row.mint, row.issuer);
  if (id === "fund_agent") return buildMintPayment(row.mint, row.agent);
  if (id === "fund_stranger") return buildMintPayment(row.mint, row.stranger);
  if (id === "credential_create") return buildCredentialCreate(row.issuer, row.agent);
  if (id === "credential_accept") return buildCredentialAccept(row.agent, row.issuer);
  if (id === "permissioned_domain_set") return buildPermissionedDomainSet(row.issuer, row.issuer);
  if (id === "domain_offer") return buildDomainOffer(row.issuer, row.mint, domainId);
  if (id === "uncredentialed_offer") return buildTakeOffer(row.stranger, row.mint, domainId);
  if (id === "credentialed_take") return buildTakeOffer(row.agent, row.mint, domainId);
  throw coded(`unknown step ${id}`, "TX");
}

function planSteps(accounts, domainId) {
  return STEP_IDS.map((id) => {
    const needsDomain = id === "domain_offer" || id === "uncredentialed_offer" || id === "credentialed_take";
    return {
      id,
      key_env: keyEnv(id),
      expect: expectEngine(id),
      tx: buildStep(id, accounts, needsDomain ? domainId : null),
    };
  });
}

module.exports = {
  CREDENTIAL_TYPE,
  LP_DOOR_TYPE,
  DOMAIN_SPACE,
  TF_HYBRID,
  SOURCE_TAG,
  CURRENCY,
  TRUST_LIMIT,
  FUND_VALUE,
  OFFER_VALUE,
  OFFER_DROPS,
  INTENT,
  README_URI,
  AMENDMENTS,
  STEP_IDS,
  UNCREDENTIALED_ENGINE,
  SHAPE,
  coded,
  shapeAddress,
  rowsOf,
  assertShopAmendments,
  assertShopAccounts,
  shapeAccounts,
  domainIndex,
  domainIdFromMeta,
  typeHex,
  assertNotHybrid,
  assertNotWalkIn,
  buildTrustSet,
  buildMintPayment,
  buildCredentialCreate,
  buildCredentialAccept,
  buildPermissionedDomainSet,
  buildDomainOffer,
  buildTakeOffer,
  adversaryCase,
  keyEnv,
  expectEngine,
  buildStep,
  planSteps,
};
