#!/usr/bin/env node
/**
 * Session 2026-09-27-6 — Machine #4 Oracle Mid-Ticket trial
 * amm_info + book_offers → composite quote → W2 mint/sell → BUYER accept + EscrowCreate (Ripple Epoch)
 * Never prints seeds. Testnet only.
 */
'use strict';
const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');
const { rippleNow, rippleToUnix } = require('./time/rippleEpoch');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const WS = 'wss://s.altnet.rippletest.net:51233';
const TAXON = 20260927;
const AETH = '4145544800000000000000000000000000000000';
const AMM_ADDR = 'r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w';
const W0_ADDR = 'rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs';
const README_BASE =
  'https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/oracle-mid-ticket/README.md';
const tfTransferable = 0x00000008;
const tfSellNFToken = 0x00000001;
const OUT = '/workspace/aether-foundry/lab/sessions/2026-09-27-6-raw.json';
const ORACLE_DIR = '/workspace/aether-foundry/lab/oracle';

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function toHexUri(uri) {
  return Buffer.from(uri, 'utf8').toString('hex').toUpperCase();
}

function extractNFTokenID(meta) {
  const nodes = meta.AffectedNodes || [];
  const ids = [];
  for (const n of nodes) {
    const mod = n.CreatedNode || n.ModifiedNode;
    if (!mod || mod.LedgerEntryType !== 'NFTokenPage') continue;
    const final = mod.NewFields || mod.FinalFields;
    const prev = mod.PreviousFields;
    const finalIDs = (final?.NFTokens || []).map((t) => t.NFToken.NFTokenID);
    const prevIDs = (prev?.NFTokens || []).map((t) => t.NFToken.NFTokenID);
    for (const id of finalIDs) {
      if (!prevIDs.includes(id)) ids.push(id);
    }
    if (n.CreatedNode && finalIDs.length) {
      for (const id of finalIDs) if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length) return ids[ids.length - 1];
  if (meta.nftoken_id) return meta.nftoken_id;
  return null;
}

function extractOfferID(meta) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === 'NFTokenOffer') return c.LedgerIndex;
  }
  return null;
}

function extractEscrow(meta) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === 'Escrow') {
      return { index: c.LedgerIndex, fields: c.NewFields };
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Best ask: sell AETH for XRP → XRP per AETH = drops(TakerPays)/value(TakerGets) */
function askPriceXrpPerAeth(offer) {
  const pays = offer.TakerPays; // XRP drops string
  const gets = offer.TakerGets; // IOU
  if (typeof pays !== 'string' || typeof gets !== 'object') return null;
  const xrp = Number(xrpl.dropsToXrp(pays));
  const aeth = Number(gets.value);
  if (!aeth) return null;
  return xrp / aeth;
}

/** Best bid: buy AETH with XRP → XRP per AETH = drops(TakerGets)/value(TakerPays) */
function bidPriceXrpPerAeth(offer) {
  const gets = offer.TakerGets; // XRP drops
  const pays = offer.TakerPays; // IOU
  if (typeof gets !== 'string' || typeof pays !== 'object') return null;
  const xrp = Number(xrpl.dropsToXrp(gets));
  const aeth = Number(pays.value);
  if (!aeth) return null;
  return xrp / aeth;
}

(async () => {
  const env = loadEnv(SECRETS);
  const client = new xrpl.Client(WS);
  await client.connect();

  const w0 = xrpl.Wallet.fromSeed(env.W0_SEED);
  const w2 = xrpl.Wallet.fromSeed(env.W2_SEED);
  const w4 = xrpl.Wallet.fromSeed(env.W4_SEED);
  if (w0.classicAddress !== W0_ADDR) throw new Error('W0 mismatch');
  if (w2.classicAddress !== env.W2_ADDRESS) throw new Error('W2 mismatch');
  if (w4.classicAddress !== env.W4_ADDRESS) throw new Error('W4 mismatch');
  if (!env.BUYER_SEED) throw new Error('BUYER_SEED missing');
  const buyer = xrpl.Wallet.fromSeed(env.BUYER_SEED);
  if (buyer.classicAddress !== env.BUYER_ADDRESS) throw new Error('BUYER mismatch');

  const log = {
    network: 'XRPL Testnet',
    session: '2026-09-27-6',
    machine: 'oracle-mid-ticket',
    quote: {},
    nft: {},
    offers: {},
    escrow: {},
  };

  // ========== 1. amm_info ==========
  const ammInfo = await client.request({
    command: 'amm_info',
    asset: { currency: AETH, issuer: W0_ADDR },
    asset2: { currency: 'XRP' },
  });
  const amm = ammInfo.result.amm;
  // amm_info on this rippled returns ledger_current_index (not ledger_index)
  const ledgerAmm =
    ammInfo.result.ledger_index ??
    ammInfo.result.ledger_current_index ??
    null;
  // amount = AETH IOU, amount2 = XRP drops (when asset2 is XRP)
  let poolAeth, poolXrp;
  if (typeof amm.amount === 'object' && typeof amm.amount2 === 'string') {
    poolAeth = Number(amm.amount.value);
    poolXrp = Number(xrpl.dropsToXrp(amm.amount2));
  } else if (typeof amm.amount2 === 'object' && typeof amm.amount === 'string') {
    poolAeth = Number(amm.amount2.value);
    poolXrp = Number(xrpl.dropsToXrp(amm.amount));
  } else {
    throw new Error('Unexpected amm amount shapes');
  }
  const spot_amm = poolXrp / poolAeth;
  console.log('spot_amm', spot_amm, 'ledger', ledgerAmm, 'poolAeth', poolAeth, 'poolXrp', poolXrp);

  // ========== 2. book_offers both sides ==========
  const aethIou = { currency: AETH, issuer: W0_ADDR };
  // Asks: sell AETH for XRP
  const asksRes = await client.request({
    command: 'book_offers',
    taker_gets: aethIou,
    taker_pays: { currency: 'XRP' },
    limit: 10,
  });
  // Bids: buy AETH with XRP
  const bidsRes = await client.request({
    command: 'book_offers',
    taker_gets: { currency: 'XRP' },
    taker_pays: aethIou,
    limit: 10,
  });
  const asks = asksRes.result.offers || [];
  const bids = bidsRes.result.offers || [];
  const askPrices = asks.map(askPriceXrpPerAeth).filter((p) => p != null);
  const bidPrices = bids.map(bidPriceXrpPerAeth).filter((p) => p != null);
  const best_ask = askPrices.length ? Math.min(...askPrices) : null;
  const best_bid = bidPrices.length ? Math.max(...bidPrices) : null;

  let mid_clob = null;
  let clob_thin = false;
  let w_amm = 0.7;
  let w_clob = 0.3;
  if (best_bid == null || best_ask == null) {
    clob_thin = true;
    w_amm = 1.0;
    w_clob = 0.0;
    mid_clob = null;
  } else {
    mid_clob = (best_bid + best_ask) / 2;
  }

  const quote =
    w_amm * spot_amm + (mid_clob != null ? w_clob * mid_clob : 0);
  const labor_units_aeth = 1;
  const labor_xrp_raw = quote * labor_units_aeth;
  // Use formula result; if below 0.01 XRP, round up to clear minimum and flag
  const MIN_LABOR_XRP = 0.01;
  let labor_xrp = labor_xrp_raw;
  let labor_floor_applied = false;
  if (labor_xrp_raw < MIN_LABOR_XRP) {
    labor_xrp = MIN_LABOR_XRP;
    labor_floor_applied = true;
  }
  // Round to drops precision
  const labor_drops = xrpl.xrpToDrops(labor_xrp.toFixed(6));
  labor_xrp = Number(xrpl.dropsToXrp(labor_drops));

  const now = new Date();
  const tsIso = now.toISOString();
  const hhmm =
    pad2(now.getHours()) + pad2(now.getMinutes());
  const quoteFile = path.join(
    ORACLE_DIR,
    `2026-09-27-${hhmm}.json`
  );

  const quotePublic = {
    network: 'XRPL Testnet',
    session: '2026-09-27-6',
    machine: 'oracle-mid-ticket',
    ts: tsIso,
    ledger_index: ledgerAmm,
    amm_account: AMM_ADDR,
    pool_aeth: poolAeth,
    pool_xrp: poolXrp,
    spot_amm,
    best_bid,
    best_ask,
    mid_clob,
    clob_thin,
    weights: { amm: w_amm, clob: w_clob },
    formula: clob_thin
      ? 'quote = 1.0 * spot_amm (clob_thin)'
      : 'quote = 0.7 * spot_amm + 0.3 * mid_clob',
    quote_xrp_per_aeth: quote,
    labor_units_aeth,
    labor_xrp_raw,
    labor_xrp,
    labor_drops,
    labor_floor_applied,
    ask_count: asks.length,
    bid_count: bids.length,
  };
  fs.mkdirSync(ORACLE_DIR, { recursive: true });
  fs.writeFileSync(quoteFile, JSON.stringify(quotePublic, null, 2) + '\n');
  console.log('QUOTE_FILE', quoteFile);
  console.log('QUOTE', JSON.stringify(quotePublic));

  log.quote = { ...quotePublic, quote_file: quoteFile.replace('/workspace/aether-foundry/', '') };

  // Top up BUYER if low
  let ai = await client.request({
    command: 'account_info',
    account: buyer.address,
    ledger_index: 'validated',
  });
  let bal = Number(xrpl.dropsToXrp(ai.result.account_data.Balance));
  console.log('BUYER_BAL', bal, 'OC', ai.result.account_data.OwnerCount);
  if (bal < 25) {
    console.log('Topping up BUYER via faucet...');
    const funded = await client.fundWallet(buyer);
    console.log('BUYER_FAUCET_BAL', funded.balance);
  }

  // ========== 5. NFTokenMint quote-ticket ==========
  const uri =
    README_BASE +
    '#quote=' +
    quote.toFixed(8) +
    '&ledger=' +
    ledgerAmm +
    '&ts=' +
    encodeURIComponent(tsIso);
  const uriHex = toHexUri(uri);
  let prep = await client.autofill({
    TransactionType: 'NFTokenMint',
    Account: w2.address,
    URI: uriHex,
    Flags: tfTransferable,
    TransferFee: 1000, // 1% to issuer (W2); royalty path — TransferFee goes to issuer
    NFTokenTaxon: TAXON,
  });
  // Note: XRPL TransferFee is paid to the NFToken issuer (W2), not W0.
  // Spec asked "1% royalty to W0" — issuer is W2 ATELIER; document as TransferFee 1% to issuer W2 (Foundry pattern).
  let signed = w2.sign(prep);
  let res = await client.submitAndWait(signed.tx_blob);
  const mintMeta = res.result.meta;
  const nftokenId = extractNFTokenID(mintMeta);
  log.nft = {
    mint_hash: res.result.hash,
    result: mintMeta.TransactionResult,
    ledger_index: res.result.ledger_index,
    nftoken_id: nftokenId,
    taxon: TAXON,
    uri,
    transfer_fee: 1000,
    issuer: w2.address,
    note: 'TransferFee 1% to NFToken issuer W2 (XRPL model); W0 is AETH treasury not NFT issuer',
  };
  console.log('MINT', JSON.stringify(log.nft));
  if (mintMeta.TransactionResult !== 'tesSUCCESS' || !nftokenId) {
    throw new Error('Mint failed or no NFTokenID');
  }

  // ========== 6. Sell offer at labor_xrp ==========
  prep = await client.autofill({
    TransactionType: 'NFTokenCreateOffer',
    Account: w2.address,
    NFTokenID: nftokenId,
    Amount: labor_drops,
    Flags: tfSellNFToken,
  });
  signed = w2.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const sellOfferId = extractOfferID(res.result.meta);
  log.offers.sell_hash = res.result.hash;
  log.offers.sell_result = res.result.meta.TransactionResult;
  log.offers.sell_ledger = res.result.ledger_index;
  log.offers.sell_offer_id = sellOfferId;
  log.offers.amount_drops = labor_drops;
  log.offers.amount_xrp = labor_xrp;
  console.log('SELL_OFFER', JSON.stringify(log.offers));
  if (log.offers.sell_result !== 'tesSUCCESS' || !sellOfferId) {
    throw new Error('Sell offer failed');
  }

  // BUYER accept
  prep = await client.autofill({
    TransactionType: 'NFTokenAcceptOffer',
    Account: buyer.address,
    NFTokenSellOffer: sellOfferId,
  });
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.offers.accept_hash = res.result.hash;
  log.offers.accept_result = res.result.meta.TransactionResult;
  log.offers.accept_ledger = res.result.ledger_index;
  console.log('ACCEPT', log.offers.accept_hash, log.offers.accept_result);
  if (log.offers.accept_result !== 'tesSUCCESS') {
    throw new Error('Accept failed');
  }

  // EscrowCreate labor bond to W4 — Ripple Epoch ONLY
  const rNow = rippleNow();
  const finishAfter = rNow + 25;
  const cancelAfter = rNow + 300;
  prep = await client.autofill({
    TransactionType: 'EscrowCreate',
    Account: buyer.address,
    Destination: w4.address,
    Amount: labor_drops,
    FinishAfter: finishAfter,
    CancelAfter: cancelAfter,
  });
  const createSeq = prep.Sequence;
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const escObj = extractEscrow(res.result.meta);
  log.escrow = {
    create_hash: res.result.hash,
    create_result: res.result.meta.TransactionResult,
    create_ledger: res.result.ledger_index,
    create_seq: createSeq,
    escrow_index: escObj?.index || null,
    amount_drops: labor_drops,
    amount_xrp: labor_xrp,
    destination: w4.address,
    finish_after_ripple: finishAfter,
    cancel_after_ripple: cancelAfter,
    finish_after_unix: rippleToUnix(finishAfter),
    finish_after_iso: new Date(rippleToUnix(finishAfter) * 1000).toISOString(),
    epoch_note: 'Ripple Epoch via src/time/rippleEpoch — NEVER Unix',
  };
  console.log('ESCROW_CREATE', JSON.stringify(log.escrow));
  if (log.escrow.create_result !== 'tesSUCCESS') {
    throw new Error('EscrowCreate failed');
  }

  // Wait for FinishAfter + buffer
  const waitSec = Math.max(0, finishAfter - rippleNow()) + 8;
  console.log('Waiting', waitSec, 's for FinishAfter...');
  await sleep(waitSec * 1000);

  prep = await client.autofill({
    TransactionType: 'EscrowFinish',
    Account: w4.address,
    Owner: buyer.address,
    OfferSequence: createSeq,
  });
  signed = w4.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.escrow.finish_hash = res.result.hash;
  log.escrow.finish_result = res.result.meta.TransactionResult;
  log.escrow.finish_ledger = res.result.ledger_index;
  log.escrow.finished_by = w4.address;
  console.log('ESCROW_FINISH', log.escrow.finish_hash, log.escrow.finish_result);

  if (log.escrow.finish_result !== 'tesSUCCESS') {
    // one retry after short wait
    await sleep(10000);
    prep = await client.autofill({
      TransactionType: 'EscrowFinish',
      Account: buyer.address,
      Owner: buyer.address,
      OfferSequence: createSeq,
    });
    signed = buyer.sign(prep);
    res = await client.submitAndWait(signed.tx_blob);
    log.escrow.finish_hash = res.result.hash;
    log.escrow.finish_result = res.result.meta.TransactionResult;
    log.escrow.finish_ledger = res.result.ledger_index;
    log.escrow.finished_by = buyer.address;
    console.log('ESCROW_FINISH_RETRY', log.escrow.finish_hash, log.escrow.finish_result);
  }

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
  console.log('WROTE', OUT);
  await client.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
