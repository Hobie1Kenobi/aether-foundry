"use strict";

/**
 * Guards and transaction shapes for the LP Badge credential door.
 * XRPL Testnet only. Seeds are never printed. Signing entrypoints call assertCanSign first.
 * Hooks are not assembled here: this server is plain rippled, and the feature map is checked live.
 */

const crypto = require("crypto");
const xrpl = require("xrpl");

const XRPL_WS = "wss://s.altnet.rippletest.net:51233";
const XRPL_HTTP = "https://s.altnet.rippletest.net:51234";
const FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";
const NETWORK_ID = 1;
const SECRETS_PATH = "/workspace/aether-foundry-secrets/.env";

const CREDENTIALS_AMENDMENT =
  "1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF";
const CREDENTIAL_LABEL = "aether-lp-ok";
const LP_THRESHOLD = "1000";
const DOOR_PAYMENT_DROPS = "100000";
const AETH_BUY_VALUE = "50";
const AETH_BUY_SEND_MAX_DROPS = "5000000";
const AETH_DEPOSIT_MAX = "40";
const XRP_DEPOSIT_MAX_DROPS = "2000000";
const AETH_TRUST_LIMIT = "1000000";

const ASF_DEPOSIT_AUTH = 9;
const LSF_DEPOSIT_AUTH = 0x01000000;
const LSF_ACCEPTED = 0x00010000;
const CREDENTIAL_SPACE = "0044";

const AETH_HEX = "4145544800000000000000000000000000000000";
const W0 = "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs";
const W1 = "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS";
const W2 = "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw";
const AMM = "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w";
const LP_CURRENCY = "0330E60FAE706EAD2C7D511D790B07A6F3B89931";
const V0_NFTOKEN_ID = "000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C";

const README_URI =
  "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/lp-badge-bound/README.md#lp-threshold=1000";

const ROLES = [
  { id: "ISSUER", seed: "LPB_ISSUER_SEED", role: "credential issuer" },
  { id: "HOLDER", seed: "LPB_HOLDER_SEED", role: "LP holder and credential subject" },
  { id: "DOOR", seed: "LPB_DOOR_SEED", role: "deposit-auth guild door" },
  { id: "STRANGER", seed: "LPB_STRANGER_SEED", role: "account with no credential" },
];

function envIsCi(env) {
  if (!env) return false;
  if (env.GITHUB_ACTIONS === "true") return true;
  return env.CI === "true" || env.CI === "1";
}

function assertCanSign(env) {
  if (envIsCi(env || process.env)) {
    throw Object.assign(new Error("refusing to sign under CI"), { code: "CI" });
  }
}

function isMainnetHost(hostname) {
  const host = hostname.toLowerCase();
  const blocked = [
    "ripple.com",
    "xrplcluster.com",
    "xrpl.ws",
    "xrpl.link",
    "xrpl.org",
    "xahau.network",
    "s1.ripple.com",
    "s2.ripple.com",
  ];
  return blocked.some((item) => host === item || host.endsWith(`.${item}`));
}

function assertXrplTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("refusing unparseable XRPL url"), { code: "HOST" });
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:" && url.protocol !== "https:" && url.protocol !== "http:") {
    throw Object.assign(new Error("refusing XRPL url scheme"), { code: "HOST" });
  }
  const host = url.hostname.toLowerCase();
  if (isMainnetHost(host) || host === "xahau-test.net" || host.endsWith(".xahau-test.net")) {
    throw Object.assign(
      new Error("refusing non-XRPL-Testnet host (no mainnet, no Xahau cosplay)"),
      { code: "HOST" }
    );
  }
  const rippleTest = host === "rippletest.net" || host.endsWith(".rippletest.net");
  const labsTest = host === "testnet.xrpl-labs.com";
  if (!rippleTest && !labsTest) {
    throw Object.assign(new Error("refusing non-testnet XRPL url"), { code: "HOST" });
  }
  return raw;
}

function assertNetworkId(id) {
  const n = Number(id);
  if (n === 0 || n === 21337) {
    throw Object.assign(new Error(`refusing network id ${n}`), { code: "MAINNET" });
  }
  if (n !== NETWORK_ID) {
    throw Object.assign(new Error(`refusing unexpected network id ${n}`), { code: "HOST" });
  }
  return n;
}

function sha512Half(hex) {
  const clean = String(hex).toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw Object.assign(new Error("sha512Half expects even-length hex"), { code: "HEX" });
  }
  return crypto.createHash("sha512").update(Buffer.from(clean, "hex")).digest("hex").slice(0, 64).toUpperCase();
}

function accountHex(address) {
  if (!xrpl.isValidClassicAddress(address)) {
    throw Object.assign(new Error("invalid classic address"), { code: "ADDR" });
  }
  return Buffer.from(xrpl.decodeAccountID(address)).toString("hex");
}

function credentialTypeHex(label) {
  const text = label == null ? CREDENTIAL_LABEL : String(label);
  const buf = Buffer.from(text, "utf8");
  if (buf.length < 1 || buf.length > 64) {
    throw Object.assign(new Error("credential type must be 1-64 bytes"), { code: "TYPE" });
  }
  return buf.toString("hex").toUpperCase();
}

function credentialUriHex(uri) {
  const buf = Buffer.from(String(uri), "utf8");
  if (buf.length < 1 || buf.length > 256) {
    throw Object.assign(new Error("credential URI must be 1-256 bytes"), { code: "URI" });
  }
  return buf.toString("hex").toUpperCase();
}

function credentialIndex(subject, issuer, typeHex) {
  const type = String(typeHex).toLowerCase();
  if (!/^[0-9a-f]+$/.test(type) || type.length % 2 !== 0 || type.length < 2 || type.length > 128) {
    throw Object.assign(new Error("credential type hex must be 1-64 bytes"), { code: "TYPE" });
  }
  return sha512Half(CREDENTIAL_SPACE + accountHex(subject) + accountHex(issuer) + type);
}

function parseDecimal(raw) {
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw Object.assign(new Error("bad decimal"), { code: "DECIMAL" });
  }
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const parts = body.split(".");
  const w = parts[0].replace(/^0+/, "") || "0";
  const f = (parts[1] || "").replace(/0+$/, "");
  return { neg, w, f };
}

function decimalCmp(a, b) {
  const A = parseDecimal(a);
  const B = parseDecimal(b);
  if (A.neg !== B.neg) return A.neg ? -1 : 1;
  let abs = 0;
  if (A.w.length !== B.w.length) abs = A.w.length > B.w.length ? 1 : -1;
  else if (A.w !== B.w) abs = A.w > B.w ? 1 : -1;
  else {
    const n = Math.max(A.f.length, B.f.length);
    const af = A.f.padEnd(n, "0");
    const bf = B.f.padEnd(n, "0");
    if (af !== bf) abs = af > bf ? 1 : -1;
  }
  if (abs === 0) return 0;
  return A.neg ? -abs : abs;
}

function lpMeetsThreshold(balance, threshold) {
  return decimalCmp(balance, threshold == null ? LP_THRESHOLD : threshold) >= 0;
}

function lpBelowThreshold(balance, threshold) {
  return !lpMeetsThreshold(balance, threshold);
}

function lpBalanceFromLines(lines, currency, issuer) {
  const want = String(currency).toUpperCase();
  for (const line of lines || []) {
    if (!line || String(line.currency).toUpperCase() !== want) continue;
    if (issuer && line.account !== issuer) continue;
    return String(line.balance);
  }
  return "0";
}

function iouBalanceFromLines(lines, currency, issuer) {
  return lpBalanceFromLines(lines, currency, issuer);
}

function featureReport(features) {
  const map = features || {};
  const cred = map[CREDENTIALS_AMENDMENT] || null;
  const hooks = [];
  for (const row of Object.values(map)) {
    const name = row && row.name ? String(row.name) : "";
    if (row && row.enabled && /hook/i.test(name)) hooks.push(name);
  }
  return {
    credentials: {
      amendment_id: CREDENTIALS_AMENDMENT,
      name: cred && cred.name ? String(cred.name) : null,
      enabled: !!(cred && cred.enabled),
      supported: !!(cred && cred.supported),
    },
    hooks_amendments: hooks,
    hooks_on_this_server: hooks.length > 0,
  };
}

function assertCredentialsLive(report) {
  if (!report || !report.credentials || !report.credentials.enabled) {
    throw Object.assign(
      new Error("Credentials amendment is not enabled; refusing to submit a bind"),
      { code: "AMENDMENT" }
    );
  }
  if (report.hooks_on_this_server) {
    throw Object.assign(
      new Error("refusing to treat a Hooks-named amendment as this XRPL Testnet bind"),
      { code: "AMENDMENT" }
    );
  }
}

function buildAccountSetDepositAuth(account) {
  return {
    TransactionType: "AccountSet",
    Account: account,
    SetFlag: ASF_DEPOSIT_AUTH,
  };
}

function buildDepositPreauth(door, issuer, typeHex) {
  return {
    TransactionType: "DepositPreauth",
    Account: door,
    AuthorizeCredentials: [
      {
        Credential: {
          Issuer: issuer,
          CredentialType: String(typeHex).toUpperCase(),
        },
      },
    ],
  };
}

function buildCredentialCreate(issuer, subject, typeHex, uriHex) {
  return {
    TransactionType: "CredentialCreate",
    Account: issuer,
    Subject: subject,
    CredentialType: String(typeHex).toUpperCase(),
    URI: uriHex,
  };
}

function buildCredentialAccept(subject, issuer, typeHex) {
  return {
    TransactionType: "CredentialAccept",
    Account: subject,
    Issuer: issuer,
    CredentialType: String(typeHex).toUpperCase(),
  };
}

function buildCredentialDelete(issuer, subject, typeHex) {
  return {
    TransactionType: "CredentialDelete",
    Account: issuer,
    Subject: subject,
    Issuer: issuer,
    CredentialType: String(typeHex).toUpperCase(),
  };
}

function buildDoorPayment(account, door, drops, credentialId) {
  const tx = {
    TransactionType: "Payment",
    Account: account,
    Destination: door,
    Amount: String(drops),
    SourceTag: 5005,
  };
  if (credentialId) tx.CredentialIDs = [String(credentialId).toUpperCase()];
  return tx;
}

function buildTrustSet(account) {
  return {
    TransactionType: "TrustSet",
    Account: account,
    LimitAmount: {
      currency: AETH_HEX,
      issuer: W0,
      value: AETH_TRUST_LIMIT,
    },
  };
}

function buildAethBuy(account) {
  return {
    TransactionType: "Payment",
    Account: account,
    Destination: account,
    Amount: {
      currency: AETH_HEX,
      issuer: W0,
      value: AETH_BUY_VALUE,
    },
    SendMax: AETH_BUY_SEND_MAX_DROPS,
  };
}

function buildAmmDeposit(account) {
  return {
    TransactionType: "AMMDeposit",
    Account: account,
    Asset: { currency: AETH_HEX, issuer: W0 },
    Asset2: { currency: "XRP" },
    Amount: { currency: AETH_HEX, issuer: W0, value: AETH_DEPOSIT_MAX },
    Amount2: XRP_DEPOSIT_MAX_DROPS,
    Flags: xrpl.AMMDepositFlags.tfTwoAsset,
  };
}

function buildAmmWithdrawAll(account) {
  return {
    TransactionType: "AMMWithdraw",
    Account: account,
    Asset: { currency: AETH_HEX, issuer: W0 },
    Asset2: { currency: "XRP" },
    Flags: xrpl.AMMWithdrawFlags.tfWithdrawAll,
  };
}

function createdLedgerIndex(meta, ledgerEntryType) {
  const nodes = (meta && meta.AffectedNodes) || [];
  for (const node of nodes) {
    const created = node && node.CreatedNode;
    if (created && created.LedgerEntryType === ledgerEntryType && created.LedgerIndex) {
      return String(created.LedgerIndex).toUpperCase();
    }
  }
  return null;
}

function hasDepositAuth(flags) {
  return (Number(flags) & LSF_DEPOSIT_AUTH) === LSF_DEPOSIT_AUTH;
}

function credentialAccepted(flags) {
  return (Number(flags) & LSF_ACCEPTED) === LSF_ACCEPTED;
}

function assertPublicRecord(value, path) {
  const here = path || "$";
  if (typeof value === "string") {
    if (/^s[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value)) {
      throw Object.assign(new Error(`refusing to record a secret at ${here}`), { code: "SECRET" });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPublicRecord(item, `${here}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/seed|secret/i.test(key)) {
        throw Object.assign(new Error(`refusing key ${key}`), { code: "SECRET" });
      }
      assertPublicRecord(child, `${here}.${key}`);
    }
  }
}

function parseFaucetBody(data) {
  const account = data && data.account ? data.account : {};
  const address = account.classicAddress || account.address || (data && data.address) || null;
  const secret = (data && (data.seed || data.secret)) || account.seed || account.secret || null;
  const hashRaw = data && (data.transactionHash || data.hash);
  let amount = null;
  if (data && data.amount != null) amount = Number(data.amount);
  else if (data && data.balance != null) amount = Number(data.balance);
  if (!address || !secret || String(secret).includes("\n")) return null;
  return {
    address: String(address),
    secret: String(secret),
    hash: hashRaw ? String(hashRaw).toUpperCase() : null,
    amount,
  };
}

function loadEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function walletFromSecret(secret, label) {
  try {
    return xrpl.Wallet.fromSeed(secret);
  } catch {
    throw Object.assign(new Error(`invalid seed for ${label}`), { code: "SEED" });
  }
}

module.exports = {
  XRPL_WS,
  XRPL_HTTP,
  FAUCET_URL,
  NETWORK_ID,
  SECRETS_PATH,
  CREDENTIALS_AMENDMENT,
  CREDENTIAL_LABEL,
  LP_THRESHOLD,
  DOOR_PAYMENT_DROPS,
  AETH_BUY_VALUE,
  AETH_BUY_SEND_MAX_DROPS,
  AETH_DEPOSIT_MAX,
  XRP_DEPOSIT_MAX_DROPS,
  AETH_HEX,
  W0,
  W1,
  W2,
  AMM,
  LP_CURRENCY,
  V0_NFTOKEN_ID,
  README_URI,
  ROLES,
  ASF_DEPOSIT_AUTH,
  LSF_DEPOSIT_AUTH,
  LSF_ACCEPTED,
  envIsCi,
  assertCanSign,
  isMainnetHost,
  assertXrplTestnetUrl,
  assertNetworkId,
  sha512Half,
  credentialTypeHex,
  credentialUriHex,
  credentialIndex,
  decimalCmp,
  lpMeetsThreshold,
  lpBelowThreshold,
  lpBalanceFromLines,
  iouBalanceFromLines,
  featureReport,
  assertCredentialsLive,
  buildAccountSetDepositAuth,
  buildDepositPreauth,
  buildCredentialCreate,
  buildCredentialAccept,
  buildCredentialDelete,
  buildDoorPayment,
  buildTrustSet,
  buildAethBuy,
  buildAmmDeposit,
  buildAmmWithdrawAll,
  createdLedgerIndex,
  hasDepositAuth,
  credentialAccepted,
  assertPublicRecord,
  parseFaucetBody,
  loadEnvText,
  walletFromSecret,
};
