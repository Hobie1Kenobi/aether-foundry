"use strict";

/**
 * Walk-In remint plan. Unsigned unless the daemon is live and the offer is sold out.
 * Account stays W2. Signer is W2_REGULAR_SEED. No Destination on the sell offer.
 */

const anchors = require("../../director/anchors");
const walkIn = require("../../walk-in-public");
const policy = require("../policy");

function buildUnsigned() {
  return {
    mint: {
      TransactionType: "NFTokenMint",
      Account: walkIn.W2,
      NFTokenTaxon: walkIn.TAXON,
      Flags: walkIn.TF_TRANSFERABLE,
      TransferFee: walkIn.TRANSFER_FEE,
      URI: walkIn.toHexUri(walkIn.INBOUND_URI),
    },
    createOffer: {
      TransactionType: "NFTokenCreateOffer",
      Account: walkIn.W2,
      NFTokenID: "<NFTokenID from NFTokenMint>",
      Amount: walkIn.AMOUNT_DROPS,
      Flags: walkIn.TF_SELL_NFTOKEN,
    },
  };
}

function offerOf(state) {
  return state && state.watched && state.watched.walk_in_offer;
}

function plan(opts) {
  const options = opts || {};
  const offer = offerOf(options.state);
  try {
    policy.assertRemint(offer);
    if (!options.state || policy.isStale(options.state, options.now || new Date())) {
      throw policy.coded("refusing to sign on stale director state", "STALE");
    }
    if (options.live) {
      policy.assertLiveGate(options.env);
      policy.assertAltnet({
        networkId: anchors.XRPL_NETWORK_ID,
        url: walkIn.XRPL_HTTP,
      });
    }
    const tx = buildUnsigned();
    policy.assertSigningTx(tx.mint, options.state);
    policy.assertSigningTx(tx.createOffer, options.state);
    return policy.decision("walk_in_remint", {
      allow: true,
      code: "SOLD_OUT",
      message: "unsigned remint; sell offer has no Destination",
      tx,
    });
  } catch (error) {
    return policy.fromError("walk_in_remint", error);
  }
}

function extractNFTokenID(meta) {
  const nodes = (meta && meta.AffectedNodes) || [];
  const ids = [];
  for (const node of nodes) {
    const mod = node.CreatedNode || node.ModifiedNode;
    if (!mod || mod.LedgerEntryType !== "NFTokenPage") continue;
    const final = mod.NewFields || mod.FinalFields;
    const prev = mod.PreviousFields;
    const finalIds = ((final && final.NFTokens) || []).map((row) => row.NFToken.NFTokenID);
    const prevIds = ((prev && prev.NFTokens) || []).map((row) => row.NFToken.NFTokenID);
    for (const id of finalIds) {
      if (!prevIds.includes(id)) ids.push(id);
    }
    if (node.CreatedNode) {
      for (const id of finalIds) if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length) return ids[ids.length - 1];
  if (meta && meta.nftoken_id) return meta.nftoken_id;
  return null;
}

function extractOfferID(meta) {
  for (const node of (meta && meta.AffectedNodes) || []) {
    const created = node.CreatedNode;
    if (created && created.LedgerEntryType === "NFTokenOffer") return created.LedgerIndex;
  }
  return null;
}

async function execute(opts) {
  const options = opts || {};
  policy.assertLiveGate(options.env);
  const poll = options.pollSellOffers || walkIn.pollSellOffers;
  const polled = await poll({ rpc: options.rpc });
  if (!polled || !polled.ok) {
    throw policy.coded((polled && polled.error) || "RPC could not prove W2 offers", "RPC");
  }
  if ((polled.offers || []).length >= 1) {
    throw policy.coded("refusing remint while a sell offer is open", "OFFER_OPEN");
  }
  const draft = plan(Object.assign({}, options, {
    state: Object.assign({}, options.state, {
      watched: Object.assign({}, options.state && options.state.watched, {
        walk_in_offer: { status: "sold_out", offer_count: 0 },
      }),
    }),
  }));
  if (!draft.allow || !draft.tx) throw policy.coded(draft.message || "remint refused", draft.code || "OFFER_OPEN");
  const regular = policy.regularKey(options.state, "W2");
  const minted = await options.submit(draft.tx.mint, "W2_REGULAR_SEED", regular);
  if (!minted || minted.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(minted.hash || "").toUpperCase())) {
    throw policy.coded("refusing to archive a remint without tesSUCCESS", "RECORD");
  }
  if (options.archive) {
    options.archive({
      ts: new Date().toISOString(),
      action: "walk_in_remint",
      tx_type: "NFTokenMint",
      network: "XRPL Testnet",
      network_id: 1,
      account: walkIn.W2,
      hash: minted.hash,
      result: "tesSUCCESS",
      ledger_index: minted.ledger_index == null ? null : minted.ledger_index,
      taxon: walkIn.TAXON,
    });
  }
  const nftokenId = extractNFTokenID(minted.meta);
  if (!nftokenId || !anchors.HASH_RE.test(String(nftokenId).toUpperCase())) {
    throw policy.coded(`NFTokenMint succeeded (${minted.hash}) but NFTokenID was missing`, "SUBMIT");
  }
  const offerTx = Object.assign({}, draft.tx.createOffer, { NFTokenID: String(nftokenId).toUpperCase() });
  delete offerTx.Destination;
  policy.assertSigningTx(offerTx, options.state);
  const created = await options.submit(offerTx, "W2_REGULAR_SEED", regular);
  if (!created || created.result !== "tesSUCCESS" || !anchors.HASH_RE.test(String(created.hash || "").toUpperCase())) {
    throw policy.coded("NFTokenCreateOffer did not succeed", "SUBMIT");
  }
  const offerId = extractOfferID(created.meta);
  if (options.archive) {
    options.archive({
      ts: new Date().toISOString(),
      action: "walk_in_remint",
      tx_type: "NFTokenCreateOffer",
      network: "XRPL Testnet",
      network_id: 1,
      account: walkIn.W2,
      hash: created.hash,
      result: "tesSUCCESS",
      ledger_index: created.ledger_index == null ? null : created.ledger_index,
      nftoken_id: String(nftokenId).toUpperCase(),
      offer_id: offerId,
      amount_drops: walkIn.AMOUNT_DROPS,
    });
  }
  return {
    hash: created.hash,
    mint_hash: minted.hash,
    nftoken_id: String(nftokenId).toUpperCase(),
    offer_id: offerId,
    result: "tesSUCCESS",
  };
}

module.exports = {
  buildUnsigned,
  plan,
  execute,
  extractNFTokenID,
  extractOfferID,
};
