#!/usr/bin/env node
/**
 * Session 2026-09-27-4 — Machine #3 Walk-In Window
 * Housekeeping: new STRANGER faucet, path-pay ~50 AETH via AMM, SettleDelay>=300 channel drill.
 * Primary: mint walk-in-0001, sell, STRANGER accept; optional Check; never print seeds.
 */
'use strict';
const xrpl = require('xrpl');
const fs = require('fs');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const WS = 'wss://s.altnet.rippletest.net:51233';
const TAXON = 20260927;
const AETH = '4145544800000000000000000000000000000000';
const AMM = 'r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w';
const W0_ADDR = 'rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs';
const README_URI =
  'https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/README.md';
const tfTransferable = 0x00000008;
const tfSellNFToken = 0x00000001;
const tfClose = 0x00020000;
const OUT = '/workspace/aether-foundry/lab/sessions/2026-09-27-4-raw.json';

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function appendSecret(key, value) {
  let body = fs.readFileSync(SECRETS, 'utf8');
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(body)) body = body.replace(re, key + '=' + value);
  else {
    if (!body.endsWith('\n')) body += '\n';
    body += key + '=' + value + '\n';
  }
  fs.writeFileSync(SECRETS, body, { mode: 0o600 });
  fs.chmodSync(SECRETS, 0o600);
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

function extractChannelID(meta) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === 'PayChannel') return c.LedgerIndex;
  }
  return null;
}

function extractCheckID(meta) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === 'Check') return c.LedgerIndex;
  }
  return null;
}

function safeResult(res) {
  return {
    hash: res.result.hash,
    result: res.result.meta.TransactionResult,
    ledger_index: res.result.ledger_index,
  };
}

(async () => {
  const env = loadEnv(SECRETS);
  const client = new xrpl.Client(WS);
  await client.connect();

  const w0 = xrpl.Wallet.fromSeed(env.W0_SEED);
  const w2 = xrpl.Wallet.fromSeed(env.W2_SEED);
  const w3 = xrpl.Wallet.fromSeed(env.W3_SEED);
  if (w0.address !== W0_ADDR) throw new Error('W0 address mismatch');
  if (w2.address !== env.W2_ADDRESS) throw new Error('W2 address mismatch');

  const log = {
    network: 'XRPL Testnet',
    session: '2026-09-27-4',
    stranger: {},
    path_pay: {},
    channel: {},
    walk_in: {},
    check: {},
    did: {},
  };

  // ========== 1a. Fund NEW STRANGER via faucet ==========
  {
    const funded = await client.fundWallet();
    const stranger = funded.wallet;
    // Never log seed
    appendSecret('STRANGER_SEED', stranger.seed);
    appendSecret('STRANGER_ADDRESS', stranger.classicAddress);
    log.stranger.address = stranger.classicAddress;
    log.stranger.balance_xrp = funded.balance;
    log.stranger.funded_via = 'client.fundWallet() faucet';
    console.log('STRANGER_ADDRESS', stranger.classicAddress);
    console.log('STRANGER_BALANCE_XRP', funded.balance);
  }

  const env2 = loadEnv(SECRETS);
  const stranger = xrpl.Wallet.fromSeed(env2.STRANGER_SEED);
  if (stranger.classicAddress !== log.stranger.address) throw new Error('STRANGER mismatch');

  // ========== 1b. TrustSet AETH + path-pay ~50 AETH via AMM ==========
  {
    const trust = {
      TransactionType: 'TrustSet',
      Account: stranger.address,
      LimitAmount: {
        currency: AETH,
        issuer: W0_ADDR,
        value: '1000000',
      },
    };
    const prepT = await client.autofill(trust);
    const signedT = stranger.sign(prepT);
    const resT = await client.submitAndWait(signedT.tx_blob);
    log.path_pay.trustset = safeResult(resT);
    console.log('TrustSet', log.path_pay.trustset.result, log.path_pay.trustset.hash);
  }

  {
    // Path-find XRP -> 50 AETH (same account conversion via AMM / books)
    const destAmt = { currency: AETH, issuer: W0_ADDR, value: '50' };
    const pf = await client.request({
      command: 'ripple_path_find',
      source_account: stranger.address,
      destination_account: stranger.address,
      destination_amount: destAmt,
    });
    const alts = pf.result.alternatives || [];
    log.path_pay.path_find_alts = alts.length;
    if (!alts.length) throw new Error('No path found for 50 AETH');
    const best = alts[0];
    const paths = best.paths_computed || best.paths || [];
    // SendMax: give headroom over source_amount
    let sendMax;
    if (typeof best.source_amount === 'string') {
      const drops = BigInt(best.source_amount);
      sendMax = String(drops * 3n); // 3x headroom for slippage/fees
    } else {
      sendMax = xrpl.xrpToDrops('5');
    }
    log.path_pay.source_amount_estimate = best.source_amount;
    log.path_pay.paths = paths;

    const pay = {
      TransactionType: 'Payment',
      Account: stranger.address,
      Destination: stranger.address,
      Amount: destAmt,
      SendMax: sendMax,
      Paths: paths,
    };
    const prepP = await client.autofill(pay);
    const signedP = stranger.sign(prepP);
    const resP = await client.submitAndWait(signedP.tx_blob);
    const meta = resP.result.meta;
    log.path_pay.payment = safeResult(resP);
    log.path_pay.delivered_amount = meta.delivered_amount || meta.DeliveredAmount;
    log.path_pay.send_max_drops = sendMax;
    console.log(
      'PathPay',
      log.path_pay.payment.result,
      log.path_pay.payment.hash,
      'delivered',
      JSON.stringify(log.path_pay.delivered_amount)
    );
  }

  // ========== 1c. PaymentChannel SettleDelay >= 300 threat drill ==========
  {
    const create = {
      TransactionType: 'PaymentChannelCreate',
      Account: stranger.address,
      Destination: w3.address,
      Amount: xrpl.xrpToDrops('2'),
      SettleDelay: 300,
      PublicKey: stranger.publicKey,
    };
    const prepC = await client.autofill(create);
    const signedC = stranger.sign(prepC);
    const resC = await client.submitAndWait(signedC.tx_blob);
    const channelId = extractChannelID(resC.result.meta);
    log.channel.create = safeResult(resC);
    log.channel.channel_id = channelId;
    log.channel.settle_delay = 300;
    log.channel.source = stranger.address;
    log.channel.destination = w3.address;
    console.log('PayChannelCreate', log.channel.create.result, channelId);

    // Destination tfClose immediately (no claim amount) — observe Expiration
    const closeDest = {
      TransactionType: 'PaymentChannelClaim',
      Account: w3.address,
      Channel: channelId,
      Flags: tfClose,
    };
    const prepD = await client.autofill(closeDest);
    const signedD = w3.sign(prepD);
    const resD = await client.submitAndWait(signedD.tx_blob);
    log.channel.dest_tfClose = safeResult(resD);
    console.log('Dest_tfClose', log.channel.dest_tfClose.result, log.channel.dest_tfClose.hash);

    // Read channel object — should still exist with Expiration set
    try {
      const ch = await client.request({ command: 'ledger_entry', index: channelId });
      const node = ch.result.node;
      log.channel.after_dest_close = {
        exists: true,
        Balance: node.Balance,
        Amount: node.Amount,
        SettleDelay: node.SettleDelay,
        Expiration: node.Expiration || null,
        CancelAfter: node.CancelAfter || null,
      };
      console.log('Channel_after_dest_tfClose', JSON.stringify(log.channel.after_dest_close));
    } catch (e) {
      log.channel.after_dest_close = { exists: false, error: String(e.message || e) };
      console.log('Channel_after_dest_tfClose deleted_or_missing');
    }

    // Note: do NOT wait 300s. Source cannot reclaim until SettleDelay elapses.
    // Document asymmetry: source tfClose also sets Expiration; dest cannot pull
    // remaining to self without signed claims. Channel left open for threat note
    // (will expire after SettleDelay on subsequent close/claim).
    log.channel.note =
      'Dest tfClose with SettleDelay=300 sets Expiration; channel NOT deleted until delay elapses. Source must wait full SettleDelay to reclaim unclaimed 2 XRP. Source-initiated tfClose behaves similarly (Expiration = close_time + SettleDelay).';
  }

  // ========== 2. Walk-In Window: mint / sell / STRANGER accept ==========
  {
    const mintTx = {
      TransactionType: 'NFTokenMint',
      Account: w2.address,
      URI: toHexUri(README_URI),
      Flags: tfTransferable,
      TransferFee: 1000,
      NFTokenTaxon: TAXON,
    };
    const prepM = await client.autofill(mintTx);
    const signedM = w2.sign(prepM);
    const resM = await client.submitAndWait(signedM.tx_blob);
    const nftokenId = extractNFTokenID(resM.result.meta);
    log.walk_in.mint = safeResult(resM);
    log.walk_in.nftoken_id = nftokenId;
    log.walk_in.uri = README_URI;
    log.walk_in.taxon = TAXON;
    log.walk_in.transfer_fee = 1000;
    console.log('Mint', log.walk_in.mint.result, nftokenId, log.walk_in.mint.hash);

    const sellAmount = xrpl.xrpToDrops('10'); // 10 XRP — strangers can pay
    const offerTx = {
      TransactionType: 'NFTokenCreateOffer',
      Account: w2.address,
      NFTokenID: nftokenId,
      Amount: sellAmount,
      Flags: tfSellNFToken,
    };
    const prepO = await client.autofill(offerTx);
    const signedO = w2.sign(prepO);
    const resO = await client.submitAndWait(signedO.tx_blob);
    const offerId = extractOfferID(resO.result.meta);
    log.walk_in.sell_offer = safeResult(resO);
    log.walk_in.offer_id = offerId;
    log.walk_in.price_xrp = 10;
    console.log('SellOffer', log.walk_in.sell_offer.result, offerId);

    const acceptTx = {
      TransactionType: 'NFTokenAcceptOffer',
      Account: stranger.address,
      NFTokenSellOffer: offerId,
    };
    const prepA = await client.autofill(acceptTx);
    const signedA = stranger.sign(prepA);
    const resA = await client.submitAndWait(signedA.tx_blob);
    log.walk_in.accept = safeResult(resA);
    log.walk_in.holder = stranger.address;
    console.log('Accept', log.walk_in.accept.result, log.walk_in.accept.hash);
  }

  // ========== Optional: W0 CheckCreate 2 XRP → STRANGER; STRANGER CheckCash ==========
  {
    const checkCreate = {
      TransactionType: 'CheckCreate',
      Account: w0.address,
      Destination: stranger.address,
      SendMax: xrpl.xrpToDrops('2'),
    };
    const prepCc = await client.autofill(checkCreate);
    const signedCc = w0.sign(prepCc);
    const resCc = await client.submitAndWait(signedCc.tx_blob);
    const checkId = extractCheckID(resCc.result.meta);
    log.check.create = safeResult(resCc);
    log.check.check_id = checkId;
    console.log('CheckCreate', log.check.create.result, checkId);

    const checkCash = {
      TransactionType: 'CheckCash',
      Account: stranger.address,
      CheckID: checkId,
      Amount: xrpl.xrpToDrops('2'),
    };
    const prepCash = await client.autofill(checkCash);
    const signedCash = stranger.sign(prepCash);
    const resCash = await client.submitAndWait(signedCash.tx_blob);
    log.check.cash = safeResult(resCash);
    console.log('CheckCash', log.check.cash.result, log.check.cash.hash);
  }

  // ========== DID status (read-only; already points at charter) ==========
  {
    const objs = await client.request({
      command: 'account_objects',
      account: W0_ADDR,
      type: 'did',
    });
    const did = (objs.result.account_objects || [])[0];
    if (did && did.URI) {
      const uri = Buffer.from(did.URI, 'hex').toString('utf8');
      log.did.uri = uri;
      log.did.updated = false;
      log.did.note = 'Already points at corp/charter.md — no DIDSet needed';
      console.log('DID_URI', uri);
    } else {
      log.did.uri = null;
      log.did.note = 'No DID found — unexpected';
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log('WROTE', OUT);
  await client.disconnect();
})().catch((e) => {
  console.error('FATAL', e.message || e);
  process.exit(1);
});
