#!/usr/bin/env node
'use strict';

/**
 * Founder one-click: remint and relist Walk-In Window on XRPL Testnet.
 * Loads W2_SEED from outside the repo. Never prints the seed.
 * Refuses in CI / GitHub Actions. Does not accept the sell offer.
 *
 *   npm run remint:walk-in
 *   AETHER_SECRETS=/path/outside/repo/.env node src/walk-in-storefront-v2.js
 */

const fs = require('fs');
const path = require('path');
const xrpl = require('xrpl');
const pub = require('./walk-in-public');

function die(message) {
  console.error(message);
  process.exit(1);
}

function envIsCi(env) {
  if (env.GITHUB_ACTIONS === 'true') return true;
  const ci = env.CI;
  return ci === 'true' || ci === '1';
}

function loadEnv(file, readFile) {
  const out = {};
  for (const line of readFile(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function appendText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur.length && !cur.endsWith('\n')) prefix = '\n';
  }
  fs.appendFileSync(file, prefix + text);
}

function extractNFTokenID(meta) {
  const nodes = (meta && meta.AffectedNodes) || [];
  const ids = [];
  for (const n of nodes) {
    const mod = n.CreatedNode || n.ModifiedNode;
    if (!mod || mod.LedgerEntryType !== 'NFTokenPage') continue;
    const final = mod.NewFields || mod.FinalFields;
    const prev = mod.PreviousFields;
    const finalIDs = ((final && final.NFTokens) || []).map((t) => t.NFToken.NFTokenID);
    const prevIDs = ((prev && prev.NFTokens) || []).map((t) => t.NFToken.NFTokenID);
    for (const id of finalIDs) {
      if (!prevIDs.includes(id)) ids.push(id);
    }
    if (n.CreatedNode) {
      for (const id of finalIDs) if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length) return ids[ids.length - 1];
  if (meta && meta.nftoken_id) return meta.nftoken_id;
  return null;
}

function extractOfferID(meta) {
  for (const n of (meta && meta.AffectedNodes) || []) {
    const created = n.CreatedNode;
    if (created && created.LedgerEntryType === 'NFTokenOffer') return created.LedgerIndex;
  }
  return null;
}

function txResult(res) {
  const result = res.result || {};
  const meta = result.meta || {};
  return {
    hash: result.hash,
    result: meta.TransactionResult,
    ledger_index: result.ledger_index,
    meta,
  };
}

async function remint(io = {}) {
  const envVars = io.env || process.env;
  const poll = io.pollSellOffers || pub.pollSellOffers;
  const exists = io.existsSync || fs.existsSync;
  const readFile = io.readFileSync || fs.readFileSync;
  if (envIsCi(envVars)) {
    throw new Error('refusing to load seeds or sign in CI');
  }

  const ws = pub.assertTestnetUrl(envVars.XRPL_WS_URL || pub.XRPL_WS);
  const http = pub.assertTestnetUrl(envVars.XRPL_HTTP || pub.XRPL_HTTP);

  const before = await poll({ rpc: http });
  if (!before.ok) {
    throw new Error(before.error || 'could not read W2 sell offers');
  }
  if (before.offers.length > 0) {
    const first = before.offers[0];
    throw new Error(
      `standing sell offer still open (${first.offerId}); refusing to mint. Leave it open.`
    );
  }

  const secretsFile = envVars.AETHER_SECRETS || pub.SECRETS_PATH;
  if (!exists(secretsFile)) {
    throw new Error(
      `missing secrets file (set AETHER_SECRETS outside the repo; expected W2_SEED). Not found: ${secretsFile}`
    );
  }

  const env = loadEnv(secretsFile, readFile);
  if (!env.W2_SEED) {
    throw new Error('W2_SEED is missing from the secrets file (value not printed)');
  }

  let w2;
  try {
    w2 = xrpl.Wallet.fromSeed(env.W2_SEED);
  } catch {
    throw new Error('W2_SEED could not be loaded (value not printed)');
  }
  const address = w2.classicAddress || w2.address;
  if (address !== pub.W2) {
    throw new Error('W2_SEED does not match the W2 public anchor; refusing');
  }

  const root = io.root || path.resolve(__dirname, '..');
  const client = new xrpl.Client(ws);
  await client.connect();
  let nftokenId = null;
  let mintHash = null;
  try {
    const mintTx = {
      TransactionType: 'NFTokenMint',
      Account: address,
      URI: pub.toHexUri(pub.INBOUND_URI),
      Flags: pub.TF_TRANSFERABLE,
      TransferFee: pub.TRANSFER_FEE,
      NFTokenTaxon: pub.TAXON,
    };
    const preparedMint = await client.autofill(mintTx);
    const signedMint = w2.sign(preparedMint);
    const mintRes = txResult(await client.submitAndWait(signedMint.tx_blob));
    mintHash = mintRes.hash;
    if (mintRes.result !== 'tesSUCCESS') {
      throw new Error(`NFTokenMint ${mintRes.result || 'failed'} ${mintHash || ''}`.trim());
    }
    nftokenId = extractNFTokenID(mintRes.meta);
    if (!nftokenId) {
      throw new Error(`NFTokenMint succeeded (${mintHash}) but NFTokenID was missing`);
    }
    console.log('Mint', mintRes.result, nftokenId, mintHash);

    const offerTx = {
      TransactionType: 'NFTokenCreateOffer',
      Account: address,
      NFTokenID: nftokenId,
      Amount: pub.AMOUNT_DROPS,
      Flags: pub.TF_SELL_NFTOKEN,
    };
    const preparedOffer = await client.autofill(offerTx);
    const signedOffer = w2.sign(preparedOffer);
    const offerRes = txResult(await client.submitAndWait(signedOffer.tx_blob));
    const offerId = extractOfferID(offerRes.meta);
    if (offerRes.result !== 'tesSUCCESS' || !offerId) {
      const when = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      appendText(
        path.join(root, 'machines', 'walk-in-window', 'RESULTS.md'),
        `
## v2 remint incomplete ${when}

NFTokenMint succeeded and NFTokenCreateOffer did not. Finish the sell offer locally. Do not accept.

| Field | Value |
|-------|-------|
| NFTokenID | \`${nftokenId}\` |
| Mint hash | \`${mintHash}\` |
`
      );
      appendText(
        path.join(root, 'lab', 'ledger-log.jsonl'),
        `${JSON.stringify({
          ts: when,
          event: 'walk_in_remint_mint',
          action: 'walk_in_remint_mint',
          network: 'XRPL Testnet',
          account: pub.W2,
          hash: mintHash,
          nftoken_id: nftokenId,
          result: 'tesSUCCESS',
          note: 'createOffer failed; offer not accepted',
        })}\n`
      );
      throw new Error(
        `NFTokenCreateOffer ${offerRes.result || 'failed'} after mint ${mintHash} nft ${nftokenId}`
      );
    }

    const when = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    console.log('CreateOffer', offerRes.result, offerId, offerRes.hash);
    console.log('OPEN w2=' + pub.W2 + ' offer=' + offerId + ' nft=' + nftokenId);
    console.log('Left open. Do not accept.');

    appendText(
      path.join(root, 'machines', 'walk-in-window', 'RESULTS.md'),
      `
## v2 remint ${when}

Founder one-click \`${pub.ONE_CLICK}\`. Offer left open. Not accepted.

| Field | Value |
|-------|-------|
| Minter / seller | W2 \`${pub.W2}\` |
| NFTokenID | \`${nftokenId}\` |
| Mint hash | \`${mintHash}\` |
| CreateOffer hash | \`${offerRes.hash}\` |
| OfferID | \`${offerId}\` |
| Price | 10 XRP (\`${pub.AMOUNT_DROPS}\` drops) |
| Disposition | OPEN on W2 — do not accept |
`
    );
    appendText(
      path.join(root, 'lab', 'ledger-log.jsonl'),
      `${JSON.stringify({
        ts: when,
        event: 'walk_in_remint_mint',
        action: 'walk_in_remint_mint',
        network: 'XRPL Testnet',
        account: pub.W2,
        hash: mintHash,
        result: 'tesSUCCESS',
        tx_type: 'NFTokenMint',
        nftoken_id: nftokenId,
        taxon: pub.TAXON,
      })}\n${JSON.stringify({
        ts: when,
        event: 'walk_in_remint_offer',
        action: 'walk_in_remint_offer',
        network: 'XRPL Testnet',
        account: pub.W2,
        hash: offerRes.hash,
        result: 'tesSUCCESS',
        tx_type: 'NFTokenCreateOffer',
        nftoken_id: nftokenId,
        offer_id: offerId,
        amount_drops: pub.AMOUNT_DROPS,
        note: 'tfSellNFToken, no Destination, not accepted',
      })}\n`
    );
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

function reportFailure(e) {
  const message = e && e.message ? e.message : String(e);
  const safe =
    /refusing to load seeds or sign in CI/.test(message) ||
    /missing secrets file/.test(message) ||
    /value not printed/.test(message) ||
    /does not match the W2 public anchor/.test(message) ||
    /standing sell offer still open/.test(message) ||
    /NFTokenMint/.test(message) ||
    /NFTokenCreateOffer/.test(message) ||
    /could not read W2/.test(message) ||
    /refusing mainnet/.test(message) ||
    /refusing non-testnet/.test(message) ||
    /refusing unparseable/.test(message);
  if (/seed/i.test(message) && !safe) {
    die('remint failed (details omitted because they mentioned a seed)');
  }
  die(message);
}

module.exports = { remint };

if (require.main === module) {
  remint().catch(reportFailure);
}
