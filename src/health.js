#!/usr/bin/env node
/**
 * Health check W0–W4 on XRPL Testnet. No seeds printed.
 */
const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
const WS = 'wss://s.altnet.rippletest.net:51233';

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv(SECRETS);
const WALLETS = [
  { id: 'W0', role: 'TREASURY', address: env.W0_ADDRESS, seed: env.W0_SEED },
  { id: 'W1', role: 'MARKET', address: env.W1_ADDRESS, seed: env.W1_SEED },
  { id: 'W2', role: 'ATELIER', address: env.W2_ADDRESS, seed: env.W2_SEED },
  { id: 'W3', role: 'CHANNELS', address: env.W3_ADDRESS, seed: env.W3_SEED },
  { id: 'W4', role: 'ESCROW', address: env.W4_ADDRESS, seed: env.W4_SEED },
];

(async () => {
  const client = new xrpl.Client(WS);
  await client.connect();
  const ss = await client.request({ command: 'server_state' });
  const validated = ss.result.state.validated_ledger;
  const baseReserve = Number(xrpl.dropsToXrp(validated.reserve_base));
  const ownerReserve = Number(xrpl.dropsToXrp(validated.reserve_inc));
  console.log(JSON.stringify({
    network: 'XRPL Testnet',
    ledger_index: validated.seq,
    base_reserve_xrp: baseReserve,
    owner_reserve_xrp: ownerReserve,
  }, null, 2));

  const report = [];
  for (const w of WALLETS) {
    try {
      const ai = await client.request({ command: 'account_info', account: w.address, ledger_index: 'validated' });
      const bal = Number(xrpl.dropsToXrp(ai.result.account_data.Balance));
      const oc = ai.result.account_data.OwnerCount || 0;
      const reserve = baseReserve + oc * ownerReserve;
      const spendable = Math.max(0, bal - reserve);
      const row = {
        id: w.id, role: w.role, address: w.address,
        balance_xrp: bal, owner_count: oc, reserve_xrp: reserve,
        spendable_xrp: spendable, sequence: ai.result.account_data.Sequence,
        stranded: spendable < 1,
      };
      report.push(row);
      console.log(`${w.id} ${w.role}: bal=${bal} OC=${oc} reserve=${reserve} spendable=${spendable} stranded=${row.stranded}`);
    } catch (e) {
      console.log(`${w.id} ERROR: ${e.data?.error || e.message}`);
      report.push({ id: w.id, error: e.data?.error || e.message, stranded: true });
    }
  }

  // Fund stranded W2/W4 if needed
  for (const row of report) {
    if (!row.stranded) continue;
    if (row.id !== 'W2' && row.id !== 'W4') continue;
    const w = WALLETS.find(x => x.id === row.id);
    console.log(`Funding stranded ${row.id} via faucet...`);
    try {
      const funded = await client.fundWallet(xrpl.Wallet.fromSeed(w.seed));
      console.log(`Faucet OK ${row.id} address=${funded.wallet.address} balance≈${funded.balance}`);
      // re-check
      const ai = await client.request({ command: 'account_info', account: w.address, ledger_index: 'validated' });
      const bal = Number(xrpl.dropsToXrp(ai.result.account_data.Balance));
      const oc = ai.result.account_data.OwnerCount || 0;
      const reserve = baseReserve + oc * ownerReserve;
      console.log(`Post-fund ${row.id}: bal=${bal} spendable=${Math.max(0, bal - reserve)}`);
    } catch (e) {
      console.log(`Faucet failed for ${row.id}: ${e.message}; trying Payment from W0`);
      const w0 = xrpl.Wallet.fromSeed(env.W0_SEED);
      const tx = {
        TransactionType: 'Payment',
        Account: w0.address,
        Destination: w.address,
        Amount: xrpl.xrpToDrops('25'),
      };
      const prepared = await client.autofill(tx);
      const signed = w0.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      console.log(`Payment W0→${row.id} hash=${result.result.hash} code=${result.result.meta.TransactionResult}`);
    }
  }

  // AMM info
  try {
    const amm = await client.request({
      command: 'amm_info',
      asset: { currency: 'XRP' },
      asset2: { currency: '4145544800000000000000000000000000000000', issuer: env.W0_ADDRESS },
    });
    const a = amm.result.amm;
    console.log('AMM:', JSON.stringify({
      account: a.account,
      amount: a.amount,
      amount2: a.amount2,
      lp_token: a.lp_token,
      trading_fee: a.trading_fee,
    }, null, 2));
  } catch (e) {
    console.log('AMM info error:', e.data?.error || e.message);
  }

  // W1 AETH balance
  try {
    const lines = await client.request({ command: 'account_lines', account: env.W1_ADDRESS, ledger_index: 'validated' });
    console.log('W1 lines:', JSON.stringify(lines.result.lines.map(l => ({ currency: l.currency, balance: l.balance, account: l.account })), null, 2));
  } catch (e) {
    console.log('W1 lines error', e.message);
  }

  await client.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
