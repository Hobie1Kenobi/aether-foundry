"use strict";

const { coded } = require("../../missions/ledger");
const bounds = require("./bounds");

function xrpToDrops(value) {
  const text = typeof value === "number" ? value.toString() : value;
  if (typeof text !== "string" || !/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const drops = BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
  return drops > 0n ? drops : null;
}

function feeDrops(value) {
  const text = typeof value === "number" ? value.toString() : value;
  if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text)) return null;
  const fee = BigInt(text);
  if (fee <= 0n || fee > bounds.MAX_FEE_DROPS) return null;
  return fee;
}

function parseSnapshot(responses) {
  const info = responses && responses.server && responses.server.result && responses.server.result.info;
  const ledger = info && info.validated_ledger;
  if (!info || Number(info.network_id) !== 1 || !ledger || !Number.isInteger(ledger.seq) || ledger.seq <= 0) {
    throw coded("validated testnet ledger is missing", "LEDGER");
  }
  const reserveBase = xrpToDrops(ledger.reserve_base_xrp);
  const reserveInc = xrpToDrops(ledger.reserve_inc_xrp);
  if (reserveBase == null || reserveInc == null) throw coded("validated reserve is missing", "RESERVE");
  const account = responses.account && responses.account.result;
  const data = account && account.account_data;
  if (!account || account.validated !== true || !data || data.Account !== bounds.ACCOUNT) {
    throw coded("validated W1 account is missing", "LEDGER");
  }
  if (!Number.isInteger(data.Sequence) || data.Sequence <= 0) throw coded("validated sequence is missing", "LEDGER");
  if (!Number.isInteger(data.OwnerCount) || data.OwnerCount < 0) throw coded("validated owner count is missing", "LEDGER");
  if (typeof data.Balance !== "string" || !/^[0-9]+$/.test(data.Balance)) throw coded("validated balance is missing", "LEDGER");
  const quoted = responses.fee && responses.fee.result && responses.fee.result.drops;
  const fee = feeDrops(quoted && quoted.open_ledger_fee);
  if (fee == null) throw coded("open ledger fee is outside the local bound", "FEE_CAP");
  return {
    networkId: 1,
    validatedLedger: ledger.seq,
    completeLedgers: typeof info.complete_ledgers === "string" ? info.complete_ledgers : "",
    reserveBase,
    reserveInc,
    sequence: data.Sequence,
    balance: BigInt(data.Balance),
    ownerCount: data.OwnerCount,
    fee,
  };
}

function assertSpendable(snapshot, locked) {
  const need = snapshot.reserveBase
    + (BigInt(snapshot.ownerCount) + 1n) * snapshot.reserveInc
    + locked
    + snapshot.fee;
  if (snapshot.balance < need) throw coded("W1 cannot fund the locked XRP, fee, and incremental reserve", "SPENDABLE");
}

module.exports = {
  xrpToDrops,
  parseSnapshot,
  assertSpendable,
};
