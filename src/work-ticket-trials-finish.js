#!/usr/bin/env node
/**
 * Retry Trials A/B with Ripple Epoch timestamps.
 * NFT already minted & transferred. Reuses BUYER from secrets.
 * Never prints seeds.
 */
const xrpl = require('xrpl');
const hosts = require('./xrpl-hosts');
const fs = require('fs');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const RIPPLE_EPOCH_OFFSET = 946684800; // unix - ripple = this

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function rippleNow() {
  return Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const env = loadEnv(SECRETS);
  if (!env.BUYER_SEED) throw new Error('BUYER_SEED missing');
  const client = await hosts.openClient(hosts.resolveWs(process.env));
  const buyer = xrpl.Wallet.fromSeed(env.BUYER_SEED);
  const w4 = xrpl.Wallet.fromSeed(env.W4_SEED);

  // Top up BUYER if needed (10 XRP stuck in bad escrow)
  let ai = await client.request({ command: 'account_info', account: buyer.address, ledger_index: 'validated' });
  let bal = Number(xrpl.dropsToXrp(ai.result.account_data.Balance));
  console.log('BUYER bal', bal, 'OC', ai.result.account_data.OwnerCount);
  if (bal < 30) {
    console.log('Topping up BUYER via faucet...');
    const funded = await hosts.fundFromRippleFaucet(buyer);
    console.log('Faucet bal≈', funded.balance);
  }

  const log = {
    network: 'XRPL Testnet',
    note: 'Ripple Epoch timestamps (unix - 946684800). Prior Trial A create 6B9528CC... used Unix by mistake → stuck until ~2056; documented in THREAT.',
    stuck_escrow_hash: '6B9528CCE3F90E39A6D6E1A8A1F1E637E1A38B575F0DDB105785D3A66A319462',
    stuck_escrow_seq: 21094052,
    buyer_address: buyer.address,
    trials: {},
  };

  // ---- Trial A ----
  const now = rippleNow();
  const finishAfterA = now + 20;
  const cancelAfterA = now + 180;
  console.log('rippleNow', now, 'finishAfterA', finishAfterA, 'cancelAfterA', cancelAfterA);

  let prep = await client.autofill({
    TransactionType: 'EscrowCreate',
    Account: buyer.address,
    Destination: w4.address,
    Amount: xrpl.xrpToDrops('10'),
    FinishAfter: finishAfterA,
    CancelAfter: cancelAfterA,
  });
  const seqA = prep.Sequence;
  let signed = buyer.sign(prep);
  let res = await client.submitAndWait(signed.tx_blob);
  const escA = extractEscrow(res.result.meta);
  log.trials.A = {
    path: 'happy_finish',
    create_hash: res.result.hash,
    create_result: res.result.meta.TransactionResult,
    create_seq: seqA,
    escrow_index: escA?.index || null,
    amount_xrp: 10,
    destination: w4.address,
    finish_after_ripple: finishAfterA,
    cancel_after_ripple: cancelAfterA,
    finish_after_unix: finishAfterA + RIPPLE_EPOCH_OFFSET,
    finish_after_iso: new Date((finishAfterA + RIPPLE_EPOCH_OFFSET) * 1000).toISOString(),
  };
  console.log('TRIAL_A_CREATE', JSON.stringify(log.trials.A));
  if (log.trials.A.create_result !== 'tesSUCCESS') throw new Error('Trial A create failed');

  const waitA = Math.max(0, (finishAfterA - rippleNow()) + 6);
  console.log('Waiting', waitA, 's...');
  await sleep(waitA * 1000);

  // Finish as destination W4 (also allowed: any account after FinishAfter for unconditional)
  prep = await client.autofill({
    TransactionType: 'EscrowFinish',
    Account: w4.address,
    Owner: buyer.address,
    OfferSequence: seqA,
  });
  signed = w4.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.trials.A.finish_hash = res.result.hash;
  log.trials.A.finish_result = res.result.meta.TransactionResult;
  log.trials.A.finished_by = w4.address;
  console.log('TRIAL_A_FINISH', log.trials.A.finish_hash, log.trials.A.finish_result);

  if (log.trials.A.finish_result !== 'tesSUCCESS') {
    // retry as buyer after another few seconds
    await sleep(8000);
    prep = await client.autofill({
      TransactionType: 'EscrowFinish',
      Account: buyer.address,
      Owner: buyer.address,
      OfferSequence: seqA,
    });
    signed = buyer.sign(prep);
    res = await client.submitAndWait(signed.tx_blob);
    log.trials.A.finish_hash = res.result.hash;
    log.trials.A.finish_result = res.result.meta.TransactionResult;
    log.trials.A.finished_by = buyer.address;
    console.log('TRIAL_A_FINISH_RETRY', log.trials.A.finish_hash, log.trials.A.finish_result);
  }

  // ---- Trial B: CancelAfter soon, FinishAfter after CancelAfter ----
  // For cancel path: set FinishAfter in future AND CancelAfter after FinishAfter,
  // then wait past CancelAfter and EscrowCancel.
  // Spec: if both set, CancelAfter must be > FinishAfter.
  // Cancel path: create with FinishAfter=+30s, CancelAfter=+45s, wait past CancelAfter, cancel.
  // (Cannot finish after CancelAfter; must cancel.)
  const nowB = rippleNow();
  const finishAfterB = nowB + 25;
  const cancelAfterB = nowB + 40;
  prep = await client.autofill({
    TransactionType: 'EscrowCreate',
    Account: buyer.address,
    Destination: w4.address,
    Amount: xrpl.xrpToDrops('2'),
    FinishAfter: finishAfterB,
    CancelAfter: cancelAfterB,
  });
  const seqB = prep.Sequence;
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  const escB = extractEscrow(res.result.meta);
  log.trials.B = {
    path: 'cancel',
    create_hash: res.result.hash,
    create_result: res.result.meta.TransactionResult,
    create_seq: seqB,
    escrow_index: escB?.index || null,
    amount_xrp: 2,
    destination: w4.address,
    finish_after_ripple: finishAfterB,
    cancel_after_ripple: cancelAfterB,
    cancel_after_unix: cancelAfterB + RIPPLE_EPOCH_OFFSET,
    cancel_after_iso: new Date((cancelAfterB + RIPPLE_EPOCH_OFFSET) * 1000).toISOString(),
  };
  console.log('TRIAL_B_CREATE', JSON.stringify(log.trials.B));
  if (log.trials.B.create_result !== 'tesSUCCESS') throw new Error('Trial B create failed');

  const waitB = Math.max(0, (cancelAfterB - rippleNow()) + 6);
  console.log('Waiting', waitB, 's for CancelAfter...');
  await sleep(waitB * 1000);

  prep = await client.autofill({
    TransactionType: 'EscrowCancel',
    Account: buyer.address,
    Owner: buyer.address,
    OfferSequence: seqB,
  });
  signed = buyer.sign(prep);
  res = await client.submitAndWait(signed.tx_blob);
  log.trials.B.cancel_hash = res.result.hash;
  log.trials.B.cancel_result = res.result.meta.TransactionResult;
  log.trials.B.cancelled_by = buyer.address;
  console.log('TRIAL_B_CANCEL', log.trials.B.cancel_hash, log.trials.B.cancel_result);

  // balances
  for (const [label, addr] of [['BUYER', buyer.address], ['W4', w4.address]]) {
    ai = await client.request({ command: 'account_info', account: addr, ledger_index: 'validated' });
    console.log(label, 'XRP', xrpl.dropsToXrp(ai.result.account_data.Balance), 'OC', ai.result.account_data.OwnerCount);
  }

  fs.writeFileSync('/tmp/trials-result.json', JSON.stringify(log, null, 2));
  console.log('WROTE /tmp/trials-result.json');
  await client.disconnect();

  if (log.trials.A.finish_result !== 'tesSUCCESS' || log.trials.B.cancel_result !== 'tesSUCCESS') {
    process.exit(2);
  }
})().catch(e => { console.error(e); process.exit(1); });
