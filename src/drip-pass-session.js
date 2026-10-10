#!/usr/bin/env node
/**
 * Machine #2 drip-pass: NFT mint/sell + PaymentChannelCreate + 3 claims + settle.
 * Never prints seeds.
 */
'use strict';
const xrpl = require('xrpl');
const hosts = require('./xrpl-hosts');
const fs = require('fs');
const crypto = require('crypto');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const TAXON = 20260927;
const README_URI =
  'https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/drip-pass/README.md';
const tfTransferable = 0x00000008;
const tfSellNFToken = 0x00000001;
const tfClose = 0x00020000; // PaymentChannelClaimFlags.tfClose

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

function extractChannelID(meta) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === 'PayChannel') return c.LedgerIndex;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function memoForLab(n, contentHash) {
  const text = `lab/drip/000${n}.md#${contentHash.slice(0, 16)}`;
  return [
    {
      Memo: {
        MemoType: Buffer.from('drip-lab', 'utf8').toString('hex').toUpperCase(),
        MemoData: Buffer.from(text, 'utf8').toString('hex').toUpperCase(),
      },
    },
  ];
}

(async () => {
  const env = loadEnv(SECRETS);
  const client = await hosts.openClient(hosts.resolveWs(process.env));
  const w2 = xrpl.Wallet.fromSeed(env.W2_SEED);
  const w3 = xrpl.Wallet.fromSeed(env.W3_SEED);
  const buyer = xrpl.Wallet.fromSeed(env.BUYER_SEED);
  const log = { network: 'XRPL Testnet', nft: {}, channel: {}, claims: [] };

  // Ensure lab notes exist and hash them
  const labHashes = {};
  for (let n = 1; n <= 3; n++) {
    const path = `/workspace/aether-foundry/lab/drip/000${n}.md`;
    const body = fs.readFileSync(path, 'utf8');
    labHashes[n] = crypto.createHash('sha256').update(body).digest('hex');
  }
  log.lab_hashes = labHashes;

  // --- 1. Mint Drip Pass NFT ---
  {
    const mintTx = {
      TransactionType: 'NFTokenMint',
      Account: w2.address,
      URI: toHexUri(README_URI),
      Flags: tfTransferable,
      TransferFee: 1000,
      NFTokenTaxon: TAXON,
    };
    const prep = await client.autofill(mintTx);
    const signed = w2.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    const nftokenId = extractNFTokenID(res.result.meta);
    log.nft.mint_hash = res.result.hash;
    log.nft.mint_result = res.result.meta.TransactionResult;
    log.nft.nftoken_id = nftokenId;
    log.nft.taxon = TAXON;
    log.nft.uri = README_URI;
    console.log('MINT', JSON.stringify(log.nft));
    if (!nftokenId) throw new Error('No NFTokenID');
  }

  // --- Sell offer 1 XRP ---
  {
    const sellTx = {
      TransactionType: 'NFTokenCreateOffer',
      Account: w2.address,
      NFTokenID: log.nft.nftoken_id,
      Amount: xrpl.xrpToDrops('1'),
      Flags: tfSellNFToken,
    };
    const prep = await client.autofill(sellTx);
    const signed = w2.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.nft.sell_hash = res.result.hash;
    log.nft.sell_result = res.result.meta.TransactionResult;
    log.nft.sell_offer_id = extractOfferID(res.result.meta);
    console.log('SELL', log.nft.sell_hash, log.nft.sell_offer_id);
  }

  // --- BUYER accept ---
  {
    const acceptTx = {
      TransactionType: 'NFTokenAcceptOffer',
      Account: buyer.address,
      NFTokenSellOffer: log.nft.sell_offer_id,
    };
    const prep = await client.autofill(acceptTx);
    const signed = buyer.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.nft.accept_hash = res.result.hash;
    log.nft.accept_result = res.result.meta.TransactionResult;
    console.log('ACCEPT', log.nft.accept_hash, log.nft.accept_result);
  }

  // --- 2. PaymentChannelCreate BUYER → W3 ---
  // 16 XRP covers 3×2 XRP claims + headroom; SettleDelay 30s for testnet
  {
    const createTx = {
      TransactionType: 'PaymentChannelCreate',
      Account: buyer.address,
      Destination: w3.address,
      Amount: xrpl.xrpToDrops('16'),
      SettleDelay: 30,
      PublicKey: buyer.publicKey,
    };
    const prep = await client.autofill(createTx);
    const signed = buyer.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    const channelId = extractChannelID(res.result.meta);
    log.channel.create_hash = res.result.hash;
    log.channel.create_result = res.result.meta.TransactionResult;
    log.channel.channel_id = channelId;
    log.channel.amount_xrp = 16;
    log.channel.settle_delay = 30;
    log.channel.source = buyer.address;
    log.channel.destination = w3.address;
    console.log('CHANNEL_CREATE', JSON.stringify(log.channel));
    if (!channelId) throw new Error('No channel ID');
  }

  // --- 3–5. Three claims of 2 XRP cumulative balances 2, 4, 6 ---
  const channelId = log.channel.channel_id;
  for (let n = 1; n <= 3; n++) {
    const cumulativeXrp = String(n * 2); // "2", "4", "6"
    const signature = xrpl.signPaymentChannelClaim(
      channelId,
      cumulativeXrp,
      buyer.privateKey
    );
    const claimTx = {
      TransactionType: 'PaymentChannelClaim',
      Account: w3.address,
      Channel: channelId,
      Balance: xrpl.xrpToDrops(cumulativeXrp),
      Amount: xrpl.xrpToDrops(cumulativeXrp), // authorized amount (= cumulative)
      Signature: signature,
      PublicKey: buyer.publicKey,
      Memos: memoForLab(n, labHashes[n]),
    };
    const prep = await client.autofill(claimTx);
    const signed = w3.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    const entry = {
      n,
      cumulative_xrp: Number(cumulativeXrp),
      hash: res.result.hash,
      result: res.result.meta.TransactionResult,
      lab: `lab/drip/000${n}.md`,
      lab_sha256: labHashes[n],
    };
    log.claims.push(entry);
    console.log('CLAIM', JSON.stringify(entry));
    if (entry.result !== 'tesSUCCESS') throw new Error('Claim failed ' + n);
  }

  // --- 6. Settle / close ---
  // Destination requests close; after SettleDelay, channel can fully settle.
  // First: W3 claim with tfClose (marks Expiration = now + SettleDelay if funded remaining)
  {
    const closeTx = {
      TransactionType: 'PaymentChannelClaim',
      Account: w3.address,
      Channel: channelId,
      Flags: tfClose,
    };
    const prep = await client.autofill(closeTx);
    const signed = w3.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.channel.close_request_hash = res.result.hash;
    log.channel.close_request_result = res.result.meta.TransactionResult;
    console.log('CLOSE_REQUEST', JSON.stringify({
      hash: log.channel.close_request_hash,
      result: log.channel.close_request_result,
    }));
  }

  // Wait SettleDelay + buffer, then source or dest closes for real (refund remainder)
  console.log('Waiting SettleDelay 30s + buffer...');
  await sleep(35000);

  {
    // BUYER (source) claims with tfClose after expiration to return leftover
    const settleTx = {
      TransactionType: 'PaymentChannelClaim',
      Account: buyer.address,
      Channel: channelId,
      Flags: tfClose,
    };
    const prep = await client.autofill(settleTx);
    const signed = buyer.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.channel.settle_hash = res.result.hash;
    log.channel.settle_result = res.result.meta.TransactionResult;
    if (log.channel.settle_result === 'tecNO_TARGET') {
      log.channel.settle_note = 'Channel already deleted on destination tfClose';
    }
    console.log('SETTLE', JSON.stringify({
      hash: log.channel.settle_hash,
      result: log.channel.settle_result,
      note: log.channel.settle_note,
    }));
  }

  // Optional Epoch Scar handled in session follow-up (mint + Amount-0 offer to W5).
  // NFTokenMint Destination requires Amount — use createOffer Destination instead.

  fs.writeFileSync('/tmp/drip-pass-result.json', JSON.stringify(log, null, 2));
  console.log('WROTE /tmp/drip-pass-result.json');
  await client.disconnect();
})().catch((e) => {
  console.error('FATAL', e.message || e);
  if (e.data) console.error(JSON.stringify(e.data));
  process.exit(1);
});
