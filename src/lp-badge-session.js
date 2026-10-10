#!/usr/bin/env node
/**
 * Session 2026-09-27-7 — Machine #5 LP Badge trial
 * amm_info + account_lines(W1) → W2 mint/transfer Destination=W1 Amount=0 → W1 accept → verify
 * Never prints seeds. Testnet only. No AMMDeposit/Withdraw. No Batch. No OracleSet.
 */
'use strict';
const xrpl = require('xrpl');
const hosts = require('./xrpl-hosts');
const fs = require('fs');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const TAXON = 20260927;
const AETH = '4145544800000000000000000000000000000000';
const AMM_ADDR = 'r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w';
const LP_CURRENCY = '0330E60FAE706EAD2C7D511D790B07A6F3B89931';
const W0_ADDR = 'rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs';
const W1_ADDR = 'rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS';
const LP_THRESHOLD = 100000;
const README_BASE =
  'https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/lp-badge/README.md';
const tfTransferable = 0x00000008;
const tfSellNFToken = 0x00000001;
const OUT = '/workspace/aether-foundry/lab/sessions/2026-09-27-7-raw.json';

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

(async () => {
  const env = loadEnv(SECRETS);
  const client = await hosts.openClient(hosts.resolveWs(process.env));

  const w1 = xrpl.Wallet.fromSeed(env.W1_SEED);
  const w2 = xrpl.Wallet.fromSeed(env.W2_SEED);
  if (w1.classicAddress !== W1_ADDR) throw new Error('W1 mismatch');
  if (w1.classicAddress !== env.W1_ADDRESS) throw new Error('W1 env mismatch');
  if (w2.classicAddress !== env.W2_ADDRESS) throw new Error('W2 mismatch');

  const log = {
    network: 'XRPL Testnet',
    session: '2026-09-27-7',
    machine: 'lp-badge',
    ws: WS,
    amm: {},
    lp: {},
    nft: {},
    offers: {},
    verifier: {},
    honor_system: true,
    honor_system_note:
      'Ledger does not bind NFTokenID to LP trust line; URI asserts threshold at mint/verify time only',
  };

  // ========== 1. amm_info ==========
  const ammInfo = await client.request({
    command: 'amm_info',
    asset: { currency: AETH, issuer: W0_ADDR },
    asset2: { currency: 'XRP' },
  });
  const amm = ammInfo.result.amm;
  const ledgerAmm =
    ammInfo.result.ledger_index ??
    ammInfo.result.ledger_current_index ??
    null;
  let poolAeth, poolXrp;
  if (typeof amm.amount === 'object' && typeof amm.amount2 === 'string') {
    poolAeth = Number(amm.amount.value);
    poolXrp = Number(xrpl.dropsToXrp(amm.amount2));
  } else if (typeof amm.amount === 'string' && typeof amm.amount2 === 'object') {
    poolXrp = Number(xrpl.dropsToXrp(amm.amount));
    poolAeth = Number(amm.amount2.value);
  } else {
    throw new Error('Unexpected amm amount shapes');
  }
  const lpOutstanding =
    typeof amm.lp_token === 'object' ? Number(amm.lp_token.value) : null;
  const ammAccount = amm.account || AMM_ADDR;
  if (ammAccount !== AMM_ADDR) {
    console.warn('WARN amm account mismatch', ammAccount, 'expected', AMM_ADDR);
  }
  log.amm = {
    account: ammAccount,
    ledger_index: ledgerAmm,
    pool_aeth: poolAeth,
    pool_xrp: poolXrp,
    lp_outstanding: lpOutstanding,
    lp_currency: typeof amm.lp_token === 'object' ? amm.lp_token.currency : LP_CURRENCY,
    trading_fee: amm.trading_fee,
  };
  console.log('AMM', JSON.stringify(log.amm));

  // ========== 2. account_lines W1 — LP balance ==========
  const lines = await client.request({
    command: 'account_lines',
    account: W1_ADDR,
    ledger_index: 'validated',
  });
  const lpLine = (lines.result.lines || []).find(
    (l) =>
      l.currency === LP_CURRENCY ||
      (l.account === ammAccount && l.currency === LP_CURRENCY)
  );
  // LP issuer is AMM account; currency is hex
  const lpLine2 =
    lpLine ||
    (lines.result.lines || []).find(
      (l) => l.currency === LP_CURRENCY || l.currency?.toUpperCase?.() === LP_CURRENCY
    );
  const lpBal = lpLine2 ? Number(lpLine2.balance) : 0;
  log.lp = {
    holder: W1_ADDR,
    currency: LP_CURRENCY,
    issuer: lpLine2?.account || ammAccount,
    balance: lpBal,
    threshold: LP_THRESHOLD,
    passes_threshold: lpBal >= LP_THRESHOLD,
    ledger_index: lines.result.ledger_index ?? null,
  };
  console.log('LP', JSON.stringify(log.lp));
  if (!log.lp.passes_threshold) {
    throw new Error(
      'LP balance ' + lpBal + ' < threshold ' + LP_THRESHOLD + ' — abort mint'
    );
  }

  // ========== 3. W2 NFTokenMint badge ==========
  const uri =
    README_BASE +
    '#lp-threshold=' +
    LP_THRESHOLD +
    '&lp=' +
    lpBal +
    '&holder=W1';
  const uriHex = toHexUri(uri);
  let prep = await client.autofill({
    TransactionType: 'NFTokenMint',
    Account: w2.address,
    URI: uriHex,
    Flags: tfTransferable,
    TransferFee: 1000,
    NFTokenTaxon: TAXON,
  });
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
    flags: 'tfTransferable',
  };
  console.log('MINT', JSON.stringify(log.nft));
  if (mintMeta.TransactionResult !== 'tesSUCCESS' || !nftokenId) {
    throw new Error('Mint failed or no NFTokenID');
  }

  // ========== 4. W2 NFTokenCreateOffer Destination=W1 Amount=0 ==========
  prep = await client.autofill({
    TransactionType: 'NFTokenCreateOffer',
    Account: w2.address,
    NFTokenID: nftokenId,
    Amount: '0',
    Destination: W1_ADDR,
    Flags: tfSellNFToken,
  });
  signed = w2.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const sellOfferId = extractOfferID(res.result.meta);
  log.offers = {
    create_hash: res.result.hash,
    create_result: res.result.meta.TransactionResult,
    create_ledger: res.result.ledger_index,
    offer_id: sellOfferId,
    amount: '0',
    destination: W1_ADDR,
    flags: 'tfSellNFToken',
    note: 'Destination-restricted 0 XRP attestation transfer',
  };
  console.log('CREATE_OFFER', JSON.stringify(log.offers));
  if (log.offers.create_result !== 'tesSUCCESS' || !sellOfferId) {
    throw new Error('CreateOffer failed');
  }

  // ========== 5. W1 NFTokenAcceptOffer ==========
  prep = await client.autofill({
    TransactionType: 'NFTokenAcceptOffer',
    Account: w1.address,
    NFTokenSellOffer: sellOfferId,
  });
  signed = w1.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.offers.accept_hash = res.result.hash;
  log.offers.accept_result = res.result.meta.TransactionResult;
  log.offers.accept_ledger = res.result.ledger_index;
  console.log(
    'ACCEPT',
    log.offers.accept_hash,
    log.offers.accept_result,
    'ledger',
    log.offers.accept_ledger
  );
  if (log.offers.accept_result !== 'tesSUCCESS') {
    throw new Error('Accept failed');
  }

  // ========== 6. Verifier ==========
  const lines2 = await client.request({
    command: 'account_lines',
    account: W1_ADDR,
    ledger_index: 'validated',
  });
  const lpLineV = (lines2.result.lines || []).find(
    (l) => l.currency === LP_CURRENCY
  );
  const lpBalV = lpLineV ? Number(lpLineV.balance) : 0;
  const nfts = await client.request({
    command: 'account_nfts',
    account: W1_ADDR,
    ledger_index: 'validated',
  });
  const holdsBadge = (nfts.result.account_nfts || []).some(
    (n) => n.NFTokenID === nftokenId
  );
  const lpOk = lpBalV >= LP_THRESHOLD;
  const pass = lpOk && holdsBadge;
  log.verifier = {
    lp_balance: lpBalV,
    lp_threshold: LP_THRESHOLD,
    lp_ok: lpOk,
    nftoken_id: nftokenId,
    holds_badge: holdsBadge,
    pass,
    honor_system: true,
    note: 'Pass = LP≥threshold AND badge present at verify time; ledger does not bind NFT↔LP continuously',
  };
  console.log('VERIFIER', JSON.stringify(log.verifier));

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
  console.log('WROTE', OUT);
  await client.disconnect();
  if (!pass) process.exit(2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
