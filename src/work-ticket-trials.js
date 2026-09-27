#!/usr/bin/env node
/**
 * Machine #1 work-ticket-escrow trials A (finish) + B (cancel).
 * Seeds never printed. BUYER_SEED appended to secrets .env only.
 */
const xrpl = require('xrpl');
const fs = require('fs');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const WS = 'wss://s.altnet.rippletest.net:51233';
const TAXON = 20260927;
const README_URI = 'https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/work-ticket-escrow/README.md';
const tfTransferable = 0x00000008;
const tfSellNFToken = 0x00000001;

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function appendSecret(key, value) {
  let text = fs.readFileSync(SECRETS, 'utf8');
  if (new RegExp(`^${key}=`, 'm').test(text)) {
    text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  } else {
    if (!text.endsWith('\n')) text += '\n';
    text += `${key}=${value}\n`;
  }
  fs.writeFileSync(SECRETS, text, { mode: 0o600 });
  fs.chmodSync(SECRETS, 0o600);
}

function toHexUri(uri) {
  return Buffer.from(uri, 'utf8').toString('hex').toUpperCase();
}

function extractNFTokenID(meta, account) {
  // Prefer modified NFTokenPage nodes
  const nodes = meta.AffectedNodes || [];
  const ids = [];
  for (const n of nodes) {
    const mod = n.CreatedNode || n.ModifiedNode;
    if (!mod || mod.LedgerEntryType !== 'NFTokenPage') continue;
    const final = mod.NewFields || mod.FinalFields;
    const prev = mod.PreviousFields;
    const finalIDs = (final?.NFTokens || []).map(t => t.NFToken.NFTokenID);
    const prevIDs = (prev?.NFTokens || []).map(t => t.NFToken.NFTokenID);
    for (const id of finalIDs) {
      if (!prevIDs.includes(id)) ids.push(id);
    }
    // Created page
    if (n.CreatedNode && finalIDs.length) {
      for (const id of finalIDs) if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length) return ids[ids.length - 1];
  // Fallback: nftoken_id from meta if present
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
      return {
        index: c.LedgerIndex,
        fields: c.NewFields,
      };
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const env = loadEnv(SECRETS);
  const client = new xrpl.Client(WS);
  await client.connect();
  const w2 = xrpl.Wallet.fromSeed(env.W2_SEED);
  const w4 = xrpl.Wallet.fromSeed(env.W4_SEED);
  const log = { network: 'XRPL Testnet', trials: {}, nft: {}, offers: {} };

  // --- BUYER ---
  console.log('Funding BUYER via faucet...');
  const funded = await client.fundWallet();
  const buyer = funded.wallet;
  appendSecret('BUYER_SEED', buyer.seed);
  appendSecret('BUYER_ADDRESS', buyer.classicAddress);
  log.buyer_address = buyer.classicAddress;
  log.buyer_fund_balance = funded.balance;
  console.log('BUYER_ADDRESS', buyer.classicAddress, 'bal≈', funded.balance);

  // --- Mint Artifact #1 ---
  const uriHex = toHexUri(README_URI);
  const mintTx = {
    TransactionType: 'NFTokenMint',
    Account: w2.address,
    URI: uriHex,
    Flags: tfTransferable,
    TransferFee: 1000, // 1%, same as Artifact #0
    NFTokenTaxon: TAXON,
  };
  let prep = await client.autofill(mintTx);
  let signed = w2.sign(prep);
  let res = await client.submitAndWait(signed.tx_blob);
  const mintMeta = res.result.meta;
  const nftokenId = extractNFTokenID(mintMeta, w2.address);
  log.nft = {
    mint_hash: res.result.hash,
    result: mintMeta.TransactionResult,
    nftoken_id: nftokenId,
    taxon: TAXON,
    uri: README_URI,
    transfer_fee: 1000,
    issuer: w2.address,
  };
  console.log('MINT', JSON.stringify(log.nft));
  if (!nftokenId) throw new Error('Could not extract NFTokenID');

  // --- Sell offer from W2 (0 XRP = free transfer for trial acquisition, or small price) ---
  // Use 1 XRP sell so BUYER acquires meaningfully
  const sellTx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: w2.address,
    NFTokenID: nftokenId,
    Amount: xrpl.xrpToDrops('1'),
    Flags: tfSellNFToken,
  };
  prep = await client.autofill(sellTx);
  signed = w2.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const sellOfferId = extractOfferID(res.result.meta);
  log.offers.sell_hash = res.result.hash;
  log.offers.sell_result = res.result.meta.TransactionResult;
  log.offers.sell_offer_id = sellOfferId;
  console.log('SELL_OFFER', JSON.stringify(log.offers));

  // --- BUYER accept ---
  const acceptTx = {
    TransactionType: 'NFTokenAcceptOffer',
    Account: buyer.address,
    NFTokenSellOffer: sellOfferId,
  };
  prep = await client.autofill(acceptTx);
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.offers.accept_hash = res.result.hash;
  log.offers.accept_result = res.result.meta.TransactionResult;
  console.log('ACCEPT', log.offers.accept_hash, log.offers.accept_result);

  // Verify BUYER owns NFT
  const nfts = await client.request({ command: 'account_nfts', account: buyer.address });
  log.buyer_nfts = nfts.result.account_nfts.map(n => n.NFTokenID);
  console.log('BUYER_NFTS', log.buyer_nfts);

  // ========== TRIAL A: happy path EscrowCreate → Finish ==========
  const now = Math.floor(Date.now() / 1000);
  const finishAfterA = now + 15;
  const cancelAfterA = now + 120;
  const amountA = xrpl.xrpToDrops('10');

  const escA = {
    TransactionType: 'EscrowCreate',
    Account: buyer.address,
    Destination: w4.address,
    Amount: amountA,
    FinishAfter: finishAfterA,
    CancelAfter: cancelAfterA,
  };
  prep = await client.autofill(escA);
  const createSeqA = prep.Sequence;
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const escObjA = extractEscrow(res.result.meta);
  log.trials.A = {
    path: 'happy_finish',
    create_hash: res.result.hash,
    create_result: res.result.meta.TransactionResult,
    create_seq: createSeqA,
    escrow_index: escObjA?.index || null,
    amount_xrp: 10,
    destination: w4.address,
    finish_after: finishAfterA,
    cancel_after: cancelAfterA,
    finish_after_iso: new Date(finishAfterA * 1000).toISOString(),
  };
  console.log('TRIAL_A_CREATE', JSON.stringify(log.trials.A));

  // Wait until FinishAfter + buffer for ledger close
  const waitA = Math.max(0, (finishAfterA - Math.floor(Date.now() / 1000)) + 5);
  console.log('Waiting', waitA, 's for FinishAfter...');
  await sleep(waitA * 1000);

  // EscrowFinish — BUYER as owner can finish; also destination can
  const finA = {
    TransactionType: 'EscrowFinish',
    Account: buyer.address,
    Owner: buyer.address,
    OfferSequence: createSeqA,
  };
  prep = await client.autofill(finA);
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.trials.A.finish_hash = res.result.hash;
  log.trials.A.finish_result = res.result.meta.TransactionResult;
  log.trials.A.finished_by = buyer.address;
  console.log('TRIAL_A_FINISH', log.trials.A.finish_hash, log.trials.A.finish_result);

  // ========== TRIAL B: cancel path ==========
  const nowB = Math.floor(Date.now() / 1000);
  // FinishAfter far, CancelAfter soon — after CancelAfter elapses, EscrowCancel
  const finishAfterB = nowB + 600; // far
  const cancelAfterB = nowB + 20;  // soon

  const escB = {
    TransactionType: 'EscrowCreate',
    Account: buyer.address,
    Destination: w4.address,
    Amount: xrpl.xrpToDrops('2'),
    FinishAfter: finishAfterB,
    CancelAfter: cancelAfterB,
  };
  prep = await client.autofill(escB);
  const createSeqB = prep.Sequence;
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const escObjB = extractEscrow(res.result.meta);
  log.trials.B = {
    path: 'cancel',
    create_hash: res.result.hash,
    create_result: res.result.meta.TransactionResult,
    create_seq: createSeqB,
    escrow_index: escObjB?.index || null,
    amount_xrp: 2,
    destination: w4.address,
    finish_after: finishAfterB,
    cancel_after: cancelAfterB,
    cancel_after_iso: new Date(cancelAfterB * 1000).toISOString(),
  };
  console.log('TRIAL_B_CREATE', JSON.stringify(log.trials.B));

  const waitB = Math.max(0, (cancelAfterB - Math.floor(Date.now() / 1000)) + 5);
  console.log('Waiting', waitB, 's for CancelAfter...');
  await sleep(waitB * 1000);

  const canB = {
    TransactionType: 'EscrowCancel',
    Account: buyer.address,
    Owner: buyer.address,
    OfferSequence: createSeqB,
  };
  prep = await client.autofill(canB);
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.trials.B.cancel_hash = res.result.hash;
  log.trials.B.cancel_result = res.result.meta.TransactionResult;
  log.trials.B.cancelled_by = buyer.address;
  console.log('TRIAL_B_CANCEL', log.trials.B.cancel_hash, log.trials.B.cancel_result);

  // Post balances
  for (const [label, addr] of [['BUYER', buyer.address], ['W4', w4.address], ['W2', w2.address]]) {
    const ai = await client.request({ command: 'account_info', account: addr, ledger_index: 'validated' });
    console.log(label, 'XRP', xrpl.dropsToXrp(ai.result.account_data.Balance), 'OC', ai.result.account_data.OwnerCount);
  }

  fs.writeFileSync('/tmp/trials-result.json', JSON.stringify(log, null, 2));
  console.log('WROTE /tmp/trials-result.json');
  await client.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
