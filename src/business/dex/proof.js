"use strict";

const { coded } = require("../../missions/ledger");
const { parseCompleteLedgers, rangesCover } = require("../../missions/absence-proof");
const bounds = require("./bounds");

function scaled(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
}

function dropsOf(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function sameAmount(left, right) {
  const leftDrops = dropsOf(left);
  const rightDrops = dropsOf(right);
  if (leftDrops != null || rightDrops != null) return leftDrops != null && leftDrops === rightDrops;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return left.currency === right.currency
    && left.issuer === right.issuer
    && scaled(left.value) != null
    && scaled(left.value) === scaled(right.value);
}

function validatedTx(response) {
  const result = response && (response.result || response);
  if (!result || result.validated !== true) throw coded("transaction is not validated", "PROOF");
  const meta = result.meta || result.metaData;
  if (!meta || meta.TransactionResult !== "tesSUCCESS" || !Array.isArray(meta.AffectedNodes) || meta.AffectedNodes.length === 0) {
    throw coded("validated metadata does not show success", "PROOF");
  }
  const tx = result.tx_json || result;
  const hash = String(result.hash || tx.hash || "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) throw coded("validated hash is missing", "PROOF");
  return { hash, ledgerIndex: result.ledger_index, tx, meta };
}

function offerNodes(meta) {
  const found = [];
  for (const entry of meta.AffectedNodes) {
    const created = entry && entry.CreatedNode;
    const deleted = entry && entry.DeletedNode;
    const modified = entry && entry.ModifiedNode;
    const body = created || deleted || modified;
    if (!body || body.LedgerEntryType !== "Offer") continue;
    const fields = created ? body.NewFields : (body.FinalFields || body.PreviousFields || {});
    found.push({
      action: created ? "created" : deleted ? "deleted" : "modified",
      account: fields && fields.Account,
      sequence: fields && fields.Sequence,
      takerPays: fields && fields.TakerPays,
      takerGets: fields && fields.TakerGets,
    });
  }
  return found;
}

function assertCreate(tx, offer) {
  if (!tx || tx.TransactionType !== "OfferCreate" || tx.Account !== bounds.ACCOUNT) throw coded("create proof is not the W1 offer", "PROOF");
  if (tx.Sequence !== offer.sequence || tx.Fee !== offer.fee_drops) throw coded("create proof does not match the reserved offer", "PROOF");
  if (tx.LastLedgerSequence !== offer.last_ledger_sequence) throw coded("create proof does not match the reserved offer", "PROOF");
  if (tx.Destination != null || tx.Memos != null || tx.NetworkID != null) throw coded("create proof changed the offer", "PROOF");
  if (tx.Flags !== bounds.TF_PASSIVE) throw coded("create proof is not the passive offer", "PROOF");
  if (!sameAmount(tx.TakerPays, offer.taker_pays) || !sameAmount(tx.TakerGets, offer.taker_gets)) {
    throw coded("create proof changed the amounts", "PROOF");
  }
}

function createOutcome(response, offer) {
  const parsed = validatedTx(response);
  if (parsed.hash !== offer.signed_hash) throw coded("create proof hash does not match the signed offer", "PROOF");
  assertCreate(parsed.tx, offer);
  const created = offerNodes(parsed.meta).find((node) => node.action === "created" && node.account === bounds.ACCOUNT && node.sequence === offer.sequence);
  const original = BigInt(offer.locked_drops);
  if (!created) {
    return { hash: parsed.hash, open: false, filled: original, remaining: 0n };
  }
  const remaining = dropsOf(created.takerGets);
  const left = remaining == null ? 0n : remaining;
  if (left > original) throw coded("created offer locks more XRP than the signed offer", "PROOF");
  const originalIou = dropsOf(offer.taker_gets) == null ? scaled(offer.taker_gets.value) : null;
  const createdIou = dropsOf(created.takerGets) == null && created.takerGets ? scaled(created.takerGets.value) : null;
  if (originalIou != null && (createdIou == null || createdIou > originalIou)) {
    throw coded("created offer changes the AETH amount", "PROOF");
  }
  return { hash: parsed.hash, open: true, filled: original - left, remaining: left };
}

function cancelOutcome(response, offer) {
  const parsed = validatedTx(response);
  if (parsed.hash !== offer.cancel_hash) throw coded("cancel proof hash does not match the signed cancel", "PROOF");
  const tx = parsed.tx;
  if (!tx || tx.TransactionType !== "OfferCancel" || tx.Account !== bounds.ACCOUNT) throw coded("cancel proof is not the W1 cancel", "PROOF");
  if (tx.OfferSequence !== offer.sequence || tx.Sequence !== offer.cancel_sequence || tx.Fee !== offer.cancel_fee_drops || tx.LastLedgerSequence !== offer.cancel_tx.LastLedgerSequence) {
    throw coded("cancel proof does not match the reserved cancel", "PROOF");
  }
  if (tx.Destination != null || tx.Memos != null || tx.NetworkID != null) throw coded("cancel proof changed the cancel", "PROOF");
  const deleted = offerNodes(parsed.meta).some((node) => node.action === "deleted" && node.account === bounds.ACCOUNT && node.sequence === offer.sequence);
  return { hash: parsed.hash, deleted };
}

function listedOffers(response) {
  const result = response && (response.result || response);
  if (!result || result.validated !== true || result.account !== bounds.ACCOUNT || !Array.isArray(result.offers)) {
    throw coded("validated account offers are missing", "PROOF");
  }
  return result.offers;
}

function containsSequence(offers, sequence) {
  return offers.some((row) => row && (row.seq === sequence || row.Sequence === sequence));
}

function absenceProven(serverInfo, lookup, offer) {
  const info = serverInfo && serverInfo.result && serverInfo.result.info;
  const ledger = info && info.validated_ledger;
  const validated = ledger && ledger.seq;
  if (!info || Number(info.network_id) !== 1 || !Number.isInteger(validated)) return { proven: false, reason: "ledger" };
  if (validated <= offer.last_ledger_sequence) return { proven: false, reason: "window_open" };
  const ranges = parseCompleteLedgers(info.complete_ledgers);
  if (!rangesCover(ranges, offer.signed_ledger, offer.last_ledger_sequence)) return { proven: false, reason: "history_incomplete" };
  const result = lookup && (lookup.result || lookup);
  if (!result || result.validated === false || result.error !== "txnNotFound" || result.hash) return { proven: false, reason: "lookup" };
  return { proven: true, reason: "window" };
}

module.exports = {
  createOutcome,
  cancelOutcome,
  listedOffers,
  containsSequence,
  absenceProven,
};
