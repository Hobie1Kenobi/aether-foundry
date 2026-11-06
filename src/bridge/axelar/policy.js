"use strict";

const xrpl = require("xrpl");
const anchors = require("../../director/anchors");
const hosts = require("../../xrpl-hosts");
const config = require("./config");

const CLIENT_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const IN_FLIGHT = new Set(["planned", "approved_unsigned", "pending", "uncertain", "recovery", "source_included"]);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function assertNoSecretText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (anchors.SECRET_KEY_RE.test(text) && /"(seed|secret|private_?key|passphrase)"\s*:/i.test(text)) {
    throw coded("refusing a secret field", "SEED");
  }
  if (anchors.FAMILY_SEED_RE.test(String(value || "")) || anchors.EMBEDDED_SEED_RE.test(text)) {
    throw coded("refusing seed-shaped value", "SEED");
  }
}

function assertClassic(address, label) {
  if (typeof address !== "string" || !xrpl.isValidClassicAddress(address)) {
    throw coded(`${label} is not a classic XRPL address`, "ADDRESS");
  }
  if (config.isGatewayAddress(address)) throw coded(`${label} is an Axelar gateway`, "GATEWAY");
  for (const id of anchors.WALLET_IDS) {
    if (address === anchors.WALLETS[id].address) {
      throw coded(`${label} is Foundry ${id}; bridge wallets stay isolated`, "WALLET");
    }
  }
  return address;
}

function assertEvm(address, label) {
  if (typeof address !== "string" || !EVM_RE.test(address)) {
    throw coded(`${label} is not an EVM address`, "ADDRESS");
  }
  const lower = address.toLowerCase();
  if (lower === "0x0000000000000000000000000000000000000000") {
    throw coded(`${label} is the zero address`, "ADDRESS");
  }
  const blocked = [config.EVM_GATEWAY, config.EVM_ITS, config.EVM_GAS_SERVICE, config.EVM_ITS_FACTORY, config.EVM_TOKEN_MANAGER];
  if (blocked.includes(lower)) throw coded(`${label} is an Axelar contract`, "GATEWAY");
  return lower;
}

function assertClientId(id) {
  if (typeof id !== "string" || !CLIENT_RE.test(id)) throw coded("client_id must be 8-64 lowercase url characters", "CLIENT");
  if (anchors.FAMILY_SEED_RE.test(id)) throw coded("refusing seed-shaped client_id", "SEED");
  return id;
}

function assertUrlPinned(raw, expected, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coded(`refusing unparseable ${label}`, "MAINNET");
  }
  const host = url.hostname.toLowerCase();
  if (config.REFUSED_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))) {
    throw coded(`refusing mainnet or unapproved host ${host}`, "MAINNET");
  }
  if (anchors.isMainnetHost && anchors.isMainnetHost(host)) {
    throw coded(`refusing mainnet host ${host}`, "MAINNET");
  }
  const got = raw.replace(/\/$/, "");
  const want = expected.replace(/\/$/, "");
  if (got !== want) throw coded(`${label} must be ${want}`, "HOST");
  return want;
}

function assertXrplEndpoint(raw) {
  const pinned = assertUrlPinned(raw, config.XRPL_HTTP, "XRPL http");
  if (!hosts.isLabsTestnetHost(new URL(pinned).hostname)) {
    throw coded("XRPL bridge reads stay on testnet.xrpl-labs.com", "HOST");
  }
  if (Number.isFinite(Number(pinned)) && Number(pinned) === 0) throw coded("refusing network id 0", "MAINNET");
  return pinned;
}

function assertNetwork(input) {
  const network = input.network == null ? config.XRPL_NETWORK : input.network;
  const id = input.network_id == null ? config.XRPL_NETWORK_ID : Number(input.network_id);
  const evm = input.evm_chain_id == null ? config.EVM_CHAIN_ID : String(input.evm_chain_id);
  if (network !== config.XRPL_NETWORK) throw coded(`refusing network ${network}`, "MAINNET");
  if (id === 0 || evm === "0" || evm === "1440000") throw coded("refusing mainnet network id", "MAINNET");
  if (id !== config.XRPL_NETWORK_ID) throw coded(`refusing XRPL network id ${id}`, "MAINNET");
  if (evm !== config.EVM_CHAIN_ID) throw coded(`refusing EVM chain id ${evm}`, "MAINNET");
  if (input.xrpl_http) assertXrplEndpoint(input.xrpl_http);
  if (input.evm_rpc) assertUrlPinned(input.evm_rpc, config.EVM_RPC, "XRPL EVM rpc");
  if (input.gmp_api) assertUrlPinned(input.gmp_api, config.GMP_API, "GMP api");
}

function assertDirection(direction) {
  if (direction === "stellar" || direction === "stellar-2026-q1-2" || direction === "xlm") {
    throw coded("Stellar is unsupported pending a verified official testnet route", "UNSUPPORTED");
  }
  if (direction !== "xrpl-to-evm" && direction !== "evm-to-xrpl") {
    throw coded(`refusing direction ${direction}`, "UNSUPPORTED");
  }
  return direction;
}

function assertAsset(asset) {
  if (asset != null && asset !== "XRP") throw coded(`refusing asset ${asset}`, "ASSET");
  return "XRP";
}

function assertDrops(value, label) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw coded(`${label} must be an integer string`, "CAP");
  const n = BigInt(value);
  if (n <= 0n) throw coded(`${label} must be positive`, "CAP");
  return n;
}

function assertForwardAmounts(amountDrops, gasDrops) {
  const amount = assertDrops(amountDrops, "amount_drops");
  const gas = assertDrops(gasDrops, "gas_drops");
  if (gas >= amount) throw coded("gas_drops must be strictly less than amount_drops", "GAS");
  if (amount > config.MAX_AMOUNT_DROPS) throw coded(`amount_drops exceeds ${config.MAX_AMOUNT_DROPS}`, "CAP");
  if (gas > config.MAX_GAS_DROPS) throw coded(`gas_drops exceeds ${config.MAX_GAS_DROPS}`, "CAP");
  return { amount, gas, transfer: amount - gas };
}

function assertReturnAmounts(amountWei, gasWei) {
  const amount = assertDrops(amountWei, "amount_wei");
  const gas = assertDrops(gasWei, "gas_value_wei");
  if (amount > config.MAX_AMOUNT_WEI) throw coded(`amount_wei exceeds ${config.MAX_AMOUNT_WEI}`, "CAP");
  if (gas > config.MAX_GAS_WEI) throw coded(`gas_value_wei exceeds ${config.MAX_GAS_WEI}`, "CAP");
  return { amount, gas };
}

function dayKey(iso) {
  return String(iso || "").slice(0, 10);
}

function assertCapacity(existing, plan) {
  const rows = (existing || []).filter((row) => row.source_account === plan.source_account);
  const inflight = rows.filter((row) => IN_FLIGHT.has(row.status));
  if (inflight.length >= config.MAX_IN_FLIGHT) {
    throw coded("refusing a second in-flight bridge plan for this wallet", "IN_FLIGHT");
  }
  const day = dayKey(plan.created_at);
  let spent = 0n;
  for (const row of rows) {
    if (row.status === "error") continue;
    if (dayKey(row.created_at) !== day) continue;
    const part = row.amount_drops || row.amount_wei || "0";
    if (row.direction !== plan.direction) continue;
    spent += BigInt(part);
  }
  const next = BigInt(plan.amount_drops || plan.amount_wei || "0");
  const cap = plan.direction === "xrpl-to-evm" ? config.MAX_DAY_DROPS : config.MAX_AMOUNT_WEI;
  if (spent + next > cap) throw coded("refusing plan above the UTC-day cap", "CAP");
}

function assertWalletBook(book, direction, from, to) {
  if (!book || book.schema !== "aether.axelar-its.wallets") throw coded("wallet book schema missing", "WALLET");
  if (book.network !== config.XRPL_NETWORK || String(book.evm_chain_id) !== config.EVM_CHAIN_ID) {
    throw coded("wallet book is not the XRPL testnet / chain 1449000 book", "MAINNET");
  }
  const accounts = book.accounts || {};
  const xrpl = accounts.bridge_xrpl_test;
  const evm = accounts.bridge_evm_test;
  if (!xrpl || !evm) throw coded("isolated bridge_xrpl_test and bridge_evm_test are required", "WALLET");
  const xrplOk = assertClassic(xrpl, "bridge_xrpl_test");
  const evmOk = assertEvm(evm, "bridge_evm_test");
  if (direction === "xrpl-to-evm") {
    if (from !== xrplOk) throw coded("source is not the isolated XRPL bridge wallet", "WALLET");
    if (assertEvm(to, "destination") !== evmOk) throw coded("destination is not the isolated EVM bridge wallet", "WALLET");
  } else {
    if (assertEvm(from, "source") !== evmOk) throw coded("source is not the isolated EVM bridge wallet", "WALLET");
    if (to !== xrplOk) throw coded("destination is not the isolated XRPL bridge wallet", "WALLET");
  }
  return { xrpl: xrplOk, evm: evmOk };
}

function memoNeedles(tx) {
  const list = tx && Array.isArray(tx.Memos) ? tx.Memos : [];
  const needles = ["interchain_transfer", "call_contract", "destination_chain", "gas_fee_amount"].map((item) =>
    Buffer.from(item, "utf8").toString("hex")
  );
  for (const wrapper of list) {
    const row = wrapper && wrapper.Memo;
    if (!row) continue;
    const blob = `${row.MemoType || ""}${row.MemoData || ""}`.toLowerCase();
    if (needles.some((needle) => blob.includes(needle))) return true;
  }
  return false;
}

module.exports = {
  CLIENT_RE,
  IN_FLIGHT,
  coded,
  assertNoSecretText,
  assertClassic,
  assertEvm,
  assertClientId,
  assertUrlPinned,
  assertXrplEndpoint,
  assertNetwork,
  assertDirection,
  assertAsset,
  assertForwardAmounts,
  assertReturnAmounts,
  assertCapacity,
  assertWalletBook,
  memoNeedles,
};
