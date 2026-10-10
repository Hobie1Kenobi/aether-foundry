#!/usr/bin/env node
/**
 * M1 v0.1 housekeeping: probe TokenEscrow on XRPL Testnet.
 * Never prints seeds.
 */
'use strict';
const xrpl = require('xrpl');
const hosts = require('./xrpl-hosts');
const fs = require('fs');
const { rippleNow } = require('./time/rippleEpoch.js');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const AETH = '4145544800000000000000000000000000000000';
const TOKEN_ESCROW_ID = '138B968F25822EFBF54C00F97031221C47B1EAB8321D93C7C2AEAF85F04EC5DF';
const asfAllowTrustLineLocking = 17;

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEscrow(meta) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === 'Escrow') {
      return { index: c.LedgerIndex, fields: c.NewFields };
    }
  }
  return null;
}

(async () => {
  const env = loadEnv(SECRETS);
  const client = await hosts.openClient(hosts.resolveWs(process.env));
  const log = { network: 'XRPL Testnet', probed_at: new Date().toISOString() };

  // --- Feature determination ---
  const feat = await client.request({ command: 'feature' });
  const te = feat.result.features[TOKEN_ESCROW_ID];
  log.token_escrow = {
    amendment_id: TOKEN_ESCROW_ID,
    name: te?.name || 'TokenEscrow',
    enabled: !!(te && te.enabled),
    supported: !!(te && te.supported),
  };
  console.log('TOKEN_ESCROW', JSON.stringify(log.token_escrow));

  if (!log.token_escrow.enabled) {
    console.log(JSON.stringify({ status: 'DISABLED', ...log }, null, 2));
    await client.disconnect();
    process.exit(0);
  }

  const w0 = xrpl.Wallet.fromSeed(env.W0_SEED);
  const w4 = xrpl.Wallet.fromSeed(env.W4_SEED);
  const buyer = xrpl.Wallet.fromSeed(env.BUYER_SEED);
  if (buyer.classicAddress !== env.BUYER_ADDRESS) {
    throw new Error('BUYER_SEED/ADDRESS mismatch');
  }

  // --- W0 asfAllowTrustLineLocking ---
  {
    const ai = await client.request({ command: 'account_info', account: w0.address, ledger_index: 'validated' });
    const flags = ai.result.account_data.Flags || 0;
    // lsfAllowTrustLineLocking bit — check via AccountSet if needed
    // Flag value on ledger: we'll just set SetFlag; idempotent if already set
    const tx = {
      TransactionType: 'AccountSet',
      Account: w0.address,
      SetFlag: asfAllowTrustLineLocking,
    };
    const prep = await client.autofill(tx);
    const signed = w0.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.w0_allow_trustline_locking = {
      hash: res.result.hash,
      result: res.result.meta.TransactionResult,
    };
    console.log('W0_ALLOW_LOCKING', JSON.stringify(log.w0_allow_trustline_locking));
  }

  // --- BUYER TrustSet AETH ---
  {
    const tx = {
      TransactionType: 'TrustSet',
      Account: buyer.address,
      LimitAmount: {
        currency: AETH,
        issuer: w0.address,
        value: '1000000',
      },
    };
    const prep = await client.autofill(tx);
    const signed = buyer.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.buyer_trustset = {
      hash: res.result.hash,
      result: res.result.meta.TransactionResult,
    };
    console.log('BUYER_TRUSTSET', JSON.stringify(log.buyer_trustset));
  }

  // --- Fund BUYER 100 AETH from W0 ---
  {
    const tx = {
      TransactionType: 'Payment',
      Account: w0.address,
      Destination: buyer.address,
      Amount: {
        currency: AETH,
        issuer: w0.address,
        value: '100',
      },
    };
    const prep = await client.autofill(tx);
    const signed = w0.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.fund_aeth = {
      hash: res.result.hash,
      result: res.result.meta.TransactionResult,
      amount: '100',
    };
    console.log('FUND_AETH', JSON.stringify(log.fund_aeth));
  }

  // --- EscrowCreate 50 AETH → W4 (CancelAfter mandatory for tokens) ---
  const now = rippleNow();
  const finishAfter = now + 25;
  const cancelAfter = now + 180;
  let createSeq;
  {
    const tx = {
      TransactionType: 'EscrowCreate',
      Account: buyer.address,
      Destination: w4.address,
      Amount: {
        currency: AETH,
        issuer: w0.address,
        value: '50',
      },
      FinishAfter: finishAfter,
      CancelAfter: cancelAfter,
    };
    const prep = await client.autofill(tx);
    createSeq = prep.Sequence;
    const signed = buyer.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    const esc = extractEscrow(res.result.meta);
    log.escrow_create = {
      hash: res.result.hash,
      result: res.result.meta.TransactionResult,
      sequence: createSeq,
      escrow_index: esc?.index,
      finish_after_ripple: finishAfter,
      cancel_after_ripple: cancelAfter,
      amount: '50 AETH',
      destination: w4.address,
    };
    console.log('ESCROW_CREATE', JSON.stringify(log.escrow_create));
    if (res.result.meta.TransactionResult !== 'tesSUCCESS') {
      console.log(JSON.stringify(log, null, 2));
      await client.disconnect();
      process.exit(1);
    }
  }

  // Wait for FinishAfter then finish
  console.log('Waiting for FinishAfter...');
  for (;;) {
    const led = await client.request({ command: 'ledger', ledger_index: 'validated' });
    const close = led.result.ledger.close_time; // Ripple Epoch
    if (close && close > finishAfter + 2) break;
    await sleep(3000);
  }

  {
    const tx = {
      TransactionType: 'EscrowFinish',
      Account: w4.address,
      Owner: buyer.address,
      OfferSequence: createSeq,
    };
    const prep = await client.autofill(tx);
    const signed = w4.sign(prep);
    const res = await client.submitAndWait(signed.tx_blob);
    log.escrow_finish = {
      hash: res.result.hash,
      result: res.result.meta.TransactionResult,
    };
    console.log('ESCROW_FINISH', JSON.stringify(log.escrow_finish));
  }

  const outPath = '/tmp/token-escrow-probe-result.json';
  fs.writeFileSync(outPath, JSON.stringify(log, null, 2));
  console.log('WROTE', outPath);
  await client.disconnect();
})().catch((e) => {
  console.error('FATAL', e.message || e);
  process.exit(1);
});
