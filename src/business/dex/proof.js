"use strict";

/**
 * Offer proof from validated metadata.
 * A missing offer node is not a fill. A remainder that is not XRP for AETH
 * issued by W0 is not zero. Absence delegates to the sanctioned account-history
 * guard; a covered complete_ledgers span alone does not release a hold.
 */

const { coded } = require("../../missions/ledger");
const { proveSignedAbsence } = require("../../missions/absence-proof");
const { LABS } = require("../../missions/reconcile-endpoint");
const bounds = require("./bounds");
const live = require("./live");

function uncertain(message) {
  throw coded(message, "UNCERTAIN");
}

function scaled(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,15})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * (10n ** 15n) + BigInt((frac + "0".repeat(15)).slice(0, 15));
}

function signedScaled(value) {
  if (typeof value !== "string") return null;
  const negative = value.startsWith("-");
  const absolute = scaled(negative ? value.slice(1) : value);
  if (absolute == null) return null;
  return negative ? -absolute : absolute;
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

function aethAmount(value) {
  if (!value || typeof value !== "object") return null;
  if (value.currency !== bounds.AETH || value.issuer !== bounds.ISSUER) return null;
  return scaled(value.value);
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
  const ledgerIndex = Number(result.ledger_index);
  if (!Number.isSafeInteger(ledgerIndex) || ledgerIndex <= 0) uncertain("validated transaction ledger is missing");
  return { hash, ledgerIndex, tx, meta };
}

function nodes(meta, type) {
  const found = [];
  for (const entry of meta.AffectedNodes || []) {
    const body = entry && entry[type];
    if (body) found.push(body);
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

function storedSides(offer) {
  const xrp = dropsOf(offer.taker_gets);
  const aeth = aethAmount(offer.taker_pays);
  if (xrp == null || aeth == null || xrp <= 0n || aeth <= 0n) {
    uncertain("stored offer is not XRP TakerGets for AETH issued by W0");
  }
  return { xrp, aeth };
}

function createdRemainder(node) {
  const xrp = dropsOf(node && node.TakerGets);
  const aeth = aethAmount(node && node.TakerPays);
  if (xrp == null || aeth == null) uncertain("created offer remainder is not XRP for AETH issued by W0");
  return {
    xrp,
    aeth,
    takerGets: node.TakerGets,
    takerPays: { currency: node.TakerPays.currency, issuer: node.TakerPays.issuer, value: node.TakerPays.value },
  };
}

function lineBalance(fields) {
  if (!fields || !fields.HighLimit || !fields.LowLimit) return null;
  const high = fields.HighLimit.issuer;
  const low = fields.LowLimit.issuer;
  const currency = fields.HighLimit.currency || fields.LowLimit.currency;
  if (currency !== bounds.AETH) return null;
  const holder = bounds.ACCOUNT;
  const issuer = bounds.ISSUER;
  if (issuer === holder || (high !== issuer && low !== issuer) || (high !== holder && low !== holder)) return null;
  const raw = signedScaled(fields.Balance);
  if (raw == null) return null;
  if (holder === low && issuer === high) return raw;
  if (holder === high && issuer === low) return -raw;
  return null;
}

function aethDelta(meta) {
  let delta = 0n;
  let seen = false;
  for (const entry of meta.AffectedNodes) {
    const created = entry.CreatedNode;
    const modified = entry.ModifiedNode;
    const deleted = entry.DeletedNode;
    const body = created || modified || deleted;
    if (!body || body.LedgerEntryType !== "RippleState") continue;
    const finalFields = created ? body.NewFields : body.FinalFields;
    const previousFields = created ? null : body.PreviousFields;
    if (created) {
      const balance = lineBalance(finalFields);
      if (balance == null) {
        if (finalFields && (finalFields.HighLimit || finalFields.LowLimit)) uncertain("AETH balance delta is malformed");
        continue;
      }
      delta += balance;
      seen = true;
      continue;
    }
    const after = lineBalance(finalFields);
    const before = lineBalance(previousFields);
    if (after == null && before == null) continue;
    if (after == null || before == null) uncertain("AETH balance delta is malformed");
    delta += deleted ? -before : after - before;
    seen = true;
  }
  return seen ? delta : 0n;
}

function xrpSpent(meta) {
  const roots = [];
  for (const entry of meta.AffectedNodes) {
    const body = entry.ModifiedNode;
    if (!body || body.LedgerEntryType !== "AccountRoot") continue;
    const finalFields = body.FinalFields || {};
    const previous = body.PreviousFields || {};
    if (finalFields.Account !== bounds.ACCOUNT && previous.Account !== bounds.ACCOUNT) continue;
    roots.push(body);
  }
  if (roots.length !== 1) uncertain("W1 balance delta is missing");
  const finalFields = roots[0].FinalFields || {};
  const previous = roots[0].PreviousFields || {};
  const before = dropsOf(previous.Balance);
  const after = dropsOf(finalFields.Balance);
  const ownersBefore = previous.OwnerCount;
  const ownersAfter = finalFields.OwnerCount;
  if (before == null || after == null || !Number.isInteger(ownersBefore) || !Number.isInteger(ownersAfter)) {
    uncertain("W1 balance delta is malformed");
  }
  return { spent: before - after, ownersBefore, ownersAfter };
}

function withinLimit(filledXrp, filledAeth, limitXrp, limitAeth) {
  if (filledXrp === 0n && filledAeth === 0n) return;
  if (filledXrp <= 0n || filledAeth <= 0n) uncertain("fill delivered only one side");
  if (filledXrp * limitAeth > limitXrp * filledAeth) uncertain("effective price is worse than the offer limit");
}

function createOutcome(response, offer) {
  const parsed = validatedTx(response);
  if (parsed.hash !== offer.signed_hash) throw coded("create proof hash does not match the signed offer", "PROOF");
  assertCreate(parsed.tx, offer);
  const limit = storedSides(offer);
  const own = nodes(parsed.meta, "CreatedNode").filter((body) => body.LedgerEntryType === "Offer");
  const matched = own.filter((body) => {
    const fields = body.NewFields || {};
    return fields.Account === bounds.ACCOUNT && fields.Sequence === offer.sequence;
  });
  if (matched.length > 1) uncertain("metadata contains more than one remainder for this offer");
  let open = false;
  let filledXrp = limit.xrp;
  let filledAeth = limit.aeth;
  let remainingXrp = 0n;
  let remainder = null;
  if (matched.length === 1) {
    const left = createdRemainder(matched[0].NewFields || {});
    if (left.xrp > limit.xrp || left.aeth > limit.aeth) uncertain("created offer remainder exceeds the signed offer");
    open = true;
    remainingXrp = left.xrp;
    filledXrp = limit.xrp - left.xrp;
    filledAeth = limit.aeth - left.aeth;
    remainder = { takerGets: left.takerGets, takerPays: left.takerPays };
  }
  const root = xrpSpent(parsed.meta);
  const expectedSpend = BigInt(offer.fee_drops) + filledXrp;
  if (root.spent !== expectedSpend) uncertain("XRP balance delta does not match the fee and delivered XRP");
  if (aethDelta(parsed.meta) !== filledAeth) uncertain("AETH balance delta does not match the delivered AETH");
  if (open && root.ownersAfter !== root.ownersBefore + 1) uncertain("owner count does not show the created offer");
  if (!open && root.ownersAfter !== root.ownersBefore) uncertain("owner count changed without a remainder offer");
  withinLimit(filledXrp, filledAeth, limit.xrp, limit.aeth);
  return {
    hash: parsed.hash,
    ledgerIndex: parsed.ledgerIndex,
    open,
    filled: filledXrp,
    filled_aeth: filledAeth.toString(),
    remaining: remainingXrp,
    remainder,
  };
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
  const deleted = nodes(parsed.meta, "DeletedNode").some((body) => {
    if (body.LedgerEntryType !== "Offer") return false;
    const fields = body.FinalFields || {};
    return fields.Account === bounds.ACCOUNT && fields.Sequence === offer.sequence;
  });
  const root = xrpSpent(parsed.meta);
  if (root.spent !== BigInt(tx.Fee)) uncertain("cancel fee does not match the XRP balance delta");
  return { hash: parsed.hash, ledgerIndex: parsed.ledgerIndex, deleted };
}

function listedOffers(response, expectedLedger) {
  const result = response && (response.result || response);
  if (!result || result.validated !== true || result.account !== bounds.ACCOUNT || !Array.isArray(result.offers)) {
    uncertain("validated account offers are missing");
  }
  if (result.marker != null) uncertain("account offers page is incomplete");
  const ledger = Number(result.ledger_index);
  if (!Number.isSafeInteger(ledger) || ledger <= 0 || ledger !== expectedLedger) {
    uncertain("account offers ledger does not match the transaction");
  }
  return result.offers;
}

function containsOffer(offers, sequence, remainder) {
  const rows = offers.filter((row) => row && (row.seq === sequence || row.Sequence === sequence));
  if (rows.length === 0) return false;
  if (!remainder) return true;
  if (rows.length !== 1) uncertain("account offers list the sequence more than once");
  const gets = rows[0].taker_gets != null ? rows[0].taker_gets : rows[0].TakerGets;
  const pays = rows[0].taker_pays != null ? rows[0].taker_pays : rows[0].TakerPays;
  if (!sameAmount(gets, remainder.takerGets) || !sameAmount(pays, remainder.takerPays)) {
    uncertain("listed offer amounts do not match the created remainder");
  }
  return true;
}

async function proveAbsence(clients, offer) {
  let firstTx = true;
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "testnet.xrpl-labs.com" || endpoint.port) {
      throw coded("absence lookup left the sanctioned endpoint", "HOST");
    }
    const body = JSON.parse(init.body);
    if (body.method === "tx") {
      const wanted = String((body.params[0] || {}).transaction || "").toUpperCase();
      if (firstTx && wanted !== String(offer.signed_hash || "").toUpperCase()) {
        throw coded("absence lookup was not bound to the signed hash", "PROOF");
      }
      firstTx = false;
    }
    const params = (body.params && body.params[0]) || {};
    const response = await live.settledRequest((payload) => clients.ledger.request(payload), Object.assign({ command: body.method }, params));
    return { ok: true, json: async () => response };
  };
  return proveSignedAbsence(fetchImpl, {
    account: bounds.ACCOUNT,
    hash: offer.signed_hash,
    lastLedgerSequence: offer.last_ledger_sequence,
    sequence: offer.sequence,
  }, LABS);
}

function rowValidated(entry) {
  const tx = entry && entry.tx && typeof entry.tx === "object" ? entry.tx : entry;
  return validatedTx({
    result: {
      validated: entry && entry.validated === true,
      hash: (entry && entry.hash) || (tx && tx.hash),
      ledger_index: (entry && entry.ledger_index) || (tx && tx.ledger_index),
      meta: entry && (entry.meta || entry.metaData || (entry.tx && (entry.tx.meta || entry.tx.metaData))),
      tx_json: tx,
    },
  });
}

function consumeOutcome(entry, offer) {
  const parsed = rowValidated(entry);
  if (parsed.hash === offer.signed_hash || parsed.hash === offer.cancel_hash) return null;
  if (parsed.tx && parsed.tx.Account === bounds.ACCOUNT && parsed.tx.TransactionType === "OfferCreate") return null;
  const hits = [];
  for (const node of parsed.meta.AffectedNodes) {
    const deleted = node.DeletedNode;
    const modified = node.ModifiedNode;
    const body = deleted || modified;
    if (!body || body.LedgerEntryType !== "Offer") continue;
    const finalFields = body.FinalFields || {};
    const previous = body.PreviousFields || {};
    const account = finalFields.Account || previous.Account;
    const sequence = finalFields.Sequence || previous.Sequence;
    if (account !== bounds.ACCOUNT || sequence !== offer.sequence) continue;
    hits.push({ deleted: Boolean(deleted), finalFields, previous });
  }
  if (hits.length === 0) return null;
  if (hits.length !== 1) uncertain("more than one metadata node touches this offer");
  const hit = hits[0];
  const beforeXrp = dropsOf(hit.previous.TakerGets != null ? hit.previous.TakerGets : hit.finalFields.TakerGets);
  const beforeAeth = aethAmount(hit.previous.TakerPays != null ? hit.previous.TakerPays : hit.finalFields.TakerPays);
  if (beforeXrp == null || beforeAeth == null) uncertain("consumed offer is not XRP for AETH issued by W0");
  let filledXrp = beforeXrp;
  let filledAeth = beforeAeth;
  let remainingXrp = 0n;
  let open = false;
  if (!hit.deleted) {
    const afterXrp = dropsOf(hit.finalFields.TakerGets);
    const afterAeth = aethAmount(hit.finalFields.TakerPays);
    if (afterXrp == null || afterAeth == null || afterXrp > beforeXrp || afterAeth > beforeAeth) {
      uncertain("consumed remainder is not XRP for AETH issued by W0");
    }
    filledXrp = beforeXrp - afterXrp;
    filledAeth = beforeAeth - afterAeth;
    remainingXrp = afterXrp;
    open = true;
  }
  const limit = storedSides(offer);
  const root = xrpSpent(parsed.meta);
  if (root.spent !== filledXrp) uncertain("consuming trade XRP delta does not match the offer");
  if (aethDelta(parsed.meta) !== filledAeth) uncertain("consuming trade AETH delta does not match the offer");
  if (!open && root.ownersAfter !== root.ownersBefore - 1) uncertain("owner count did not release the consumed offer");
  if (open && root.ownersAfter !== root.ownersBefore) uncertain("owner count changed during a partial consume");
  withinLimit(filledXrp, filledAeth, limit.xrp, limit.aeth);
  return { hash: parsed.hash, open, filled: filledXrp, remaining: remainingXrp };
}

module.exports = {
  createOutcome,
  cancelOutcome,
  consumeOutcome,
  listedOffers,
  containsOffer,
  proveAbsence,
};
