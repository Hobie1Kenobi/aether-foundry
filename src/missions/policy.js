"use strict";

const crypto = require("crypto");
const anchors = require("../director/anchors");
const config = require("./config");
const { chicagoDay } = require("./clock");
const { coded } = require("./ledger");

const HOUSE = new Set(anchors.WALLET_IDS.map((id) => anchors.WALLETS[id].address));

function drops(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) throw coded(`${label} is negative`, "CAP");
    return value;
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw coded(`${label} must be an integer drop string`, "CAP");
  return BigInt(value);
}

function isHouse(address) {
  return HOUSE.has(address);
}

function isSynthetic(account) {
  return Boolean(account && (account.synthetic === true || account.source === "synthetic"));
}

function discover(observation) {
  const accounts = observation && Array.isArray(observation.accounts) ? observation.accounts : [];
  const foreign = [];
  const house = [];
  const synthetic = [];
  for (const account of accounts) {
    const address = account && account.address;
    if (!anchors.ADDRESS_RE.test(String(address || ""))) continue;
    if (isSynthetic(account)) {
      synthetic.push(address);
      continue;
    }
    if (isHouse(address)) house.push(address);
    else foreign.push(address);
  }
  return {
    foreign: [...new Set(foreign)],
    house: [...new Set(house)],
    synthetic: [...new Set(synthetic)],
  };
}

function assertNetwork(observation) {
  const network = observation && observation.network != null ? observation.network : config.NETWORK;
  const id = observation && observation.network_id != null ? Number(observation.network_id) : config.NETWORK_ID;
  if (network === "xrpl:0" || network === "mainnet" || id === 0) throw coded("refusing mainnet", "MAINNET");
  if (network !== config.NETWORK || id !== config.NETWORK_ID) throw coded(`refusing network ${network}`, "MAINNET");
}

function quote(input) {
  const body = input || {};
  if (body.gas_value_wei != null || body.evm_gas_wei != null || body.asset != null && body.asset !== "XRP") {
    throw coded(
      "Destination-chain gas and non-XRP assets are not authorized. Non-XRP spending is unconfigured. A return leg on XRPL EVM would need a separate explicit testnet gas authorization before any value can be set.",
      "NON_XRP"
    );
  }
  if (body.account_reserve_as_fee === true) throw coded("account reserve is not a fee and is not spend", "RESERVE");
  const payment = drops(body.payment_drops == null ? "0" : body.payment_drops, "payment_drops");
  const fee = drops(body.network_fee_drops == null ? "0" : body.network_fee_drops, "network_fee_drops");
  const bridgeGas = drops(body.bridge_gas_drops == null ? "0" : body.bridge_gas_drops, "bridge_gas_drops");
  const custody = drops(body.bridge_custody_drops == null ? "0" : body.bridge_custody_drops, "bridge_custody_drops");
  const reserve = drops(body.account_reserve_drops == null ? "0" : body.account_reserve_drops, "account_reserve_drops");
  const budget = payment + fee + bridgeGas + custody;
  if (payment === 0n && custody === 0n) throw coded("purchase or bridge custody amount is missing", "CAP");
  if (budget <= 0n) throw coded("mission budget must be positive", "CAP");
  if (budget > config.PER_MISSION_DROPS) throw coded("mission exceeds 1000000 drops", "CAP");
  return {
    payment_drops: payment.toString(),
    network_fee_drops: fee.toString(),
    bridge_gas_drops: bridgeGas.toString(),
    bridge_custody_drops: custody.toString(),
    account_reserve_drops: reserve.toString(),
    budget_drops: budget.toString(),
  };
}

function tokenOk(got, expected) {
  const left = Buffer.from(String(got || ""));
  const right = Buffer.from(String(expected || ""));
  if (right.length < 16 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function dayUsed(state, day) {
  const row = state.days[day];
  if (!row) return 0n;
  return BigInt(row.reserved) + BigInt(row.spent) + BigInt(row.uncertain);
}

module.exports = {
  HOUSE,
  drops,
  isHouse,
  isSynthetic,
  discover,
  assertNetwork,
  quote,
  tokenOk,
  dayUsed,
  chicagoDay,
};
