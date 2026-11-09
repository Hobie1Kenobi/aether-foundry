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
  if (tx.Destination != null || tx.Memos != null || tx.NetworkID != null) throw coded("signer refuses destination, memos, and network id", "TX");
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
