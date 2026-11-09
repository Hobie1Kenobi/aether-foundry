"use strict";

const xrpl = require("xrpl");
const { coded } = require("../../missions/ledger");
const anchors = require("../../director/anchors");
const bounds = require("./bounds");

function same(left, right) {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return left.currency === right.currency && left.issuer === right.issuer && left.value === right.value;
}

function assertFields(tx, expected) {
  if (!tx || typeof tx !== "object") throw coded("refusing an empty transaction", "TX");
  if (tx.Account === anchors.WALLETS.W0.address) throw coded("refusing to sign as W0", "W0");
  if (tx.Account !== bounds.ACCOUNT || expected.account !== bounds.ACCOUNT) throw coded("signer account is not W1", "WALLET");
  if (tx.TransactionType !== expected.type) throw coded("signer type is not the reserved offer action", "TX");
  if (tx.Memos != null || tx.NetworkID != null) throw coded("signer refuses memos and network id", "TX");
  if (tx.Destination != null && !(expected.type === "Payment" && tx.Destination === bounds.ACCOUNT && tx.Account === bounds.ACCOUNT)) {
    throw coded("signer refuses destination, memos, and network id", "TX");
  }
  if (tx.Sequence !== expected.sequence || tx.LastLedgerSequence !== expected.last || tx.Fee !== expected.fee) {
    throw coded("signer refuses a changed sequence, ledger window, or fee", "TX");
  }
  if (expected.type === "OfferCreate") {
    if (tx.Flags !== bounds.TF_PASSIVE || (tx.Flags & bounds.TF_TAKING) !== 0) throw coded("signer refuses a taking offer", "TX");
    if (!same(tx.TakerPays, expected.taker_pays) || !same(tx.TakerGets, expected.taker_gets)) {
      throw coded("signer refuses changed amounts", "TX");
    }
  }
  if (expected.type === "OfferCancel" && tx.OfferSequence !== expected.offer_sequence) {
    throw coded("signer refuses a changed offer sequence", "TX");
  }
  if (expected.type === "TrustSet") {
    if (tx.Flags !== 0x00020000) throw coded("signer refuses a trust line without NoRipple", "TX");
    if (!tx.LimitAmount || tx.LimitAmount.issuer !== "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" || tx.LimitAmount.value !== expected.limit) {
      throw coded("signer refuses a trust line that is not the RLUSD limit", "TX");
    }
  }
  if (expected.type === "Payment") {
    if (tx.SendMax !== expected.send_max || !tx.Amount || tx.Amount.value !== expected.deliver) {
      throw coded("signer refuses a changed RLUSD swap", "TX");
    }
    if (tx.Amount.issuer !== "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV") throw coded("signer refuses a lookalike RLUSD issuer", "TX");
  }
  if (expected.type === "AMMDeposit" || expected.type === "AMMWithdraw") {
    if (tx.Flags !== expected.flags || tx.Fee !== expected.fee) throw coded("signer refuses a changed AMM flag or fee", "TX");
    if (expected.amount != null && tx.Amount !== expected.amount) throw coded("signer refuses a changed AMM amount", "TX");
    if (expected.amount2 != null && !same(tx.Amount2, expected.amount2)) throw coded("signer refuses a changed AMM amount", "TX");
    if (expected.lp != null && !same(tx.LPTokenIn, expected.lp)) throw coded("signer refuses a changed LP balance", "TX");
    if (!tx.Asset || tx.Asset.currency !== "XRP" || !tx.Asset2 || tx.Asset2.issuer !== bounds.ISSUER) {
      throw coded("signer refuses an AMM asset that is not XRP and AETH", "TX");
    }
  }
}

async function sign(tx, expected, signer) {
  assertFields(tx, expected);
  if (typeof signer !== "function") throw coded("dex signer is not configured", "SIGNER");
  const signed = await signer(tx);
  if (!signed || typeof signed.tx_blob !== "string" || !/^[0-9A-F]+$/i.test(signed.tx_blob)) {
    throw coded("signer did not return a transaction blob", "SIGNER");
  }
  let decoded;
  try {
    decoded = xrpl.decode(signed.tx_blob);
  } catch (error) {
    throw coded("signer blob does not decode", "SIGNER");
  }
  assertFields(decoded, expected);
  const hash = xrpl.hashes.hashSignedTx(signed.tx_blob).toUpperCase();
  if (signed.hash != null && String(signed.hash).toUpperCase() !== hash) throw coded("signer hash does not match the blob", "SIGNER");
  return { tx_blob: signed.tx_blob.toUpperCase(), hash };
}

module.exports = {
  assertFields,
  sign,
};
