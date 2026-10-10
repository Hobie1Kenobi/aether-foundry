#!/usr/bin/env node
/**
 * Read-only NAV / market snapshot for XRPL Testnet.
 * Never loads or prints seeds — addresses only.
 *
 * Usage: npm run report:nav
 */
const xrpl = require('xrpl');
const hosts = require('../xrpl-hosts');
const fs = require('fs');
const path = require('path');

const SECRETS = process.env.AETHER_SECRETS || '/workspace/aether-foundry-secrets/.env';
const AETH = '4145544800000000000000000000000000000000';
const AMM = 'r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w';

function loadEnv(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function addr(env, key, fallback) {
  return env[key] || fallback;
}

(async () => {
  const env = loadEnv(SECRETS);
  const W0 = addr(env, 'W0_ADDRESS', 'rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs');
  const accounts = [
    { id: 'W0', role: 'TREASURY', address: W0 },
    { id: 'W1', role: 'MARKET', address: addr(env, 'W1_ADDRESS', 'rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS') },
    { id: 'W2', role: 'ATELIER', address: addr(env, 'W2_ADDRESS', 'rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw') },
    { id: 'W3', role: 'CHANNELS', address: addr(env, 'W3_ADDRESS', 'rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw') },
    { id: 'W4', role: 'ESCROW', address: addr(env, 'W4_ADDRESS', 'ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN') },
    { id: 'W5', role: 'RD', address: addr(env, 'W5_ADDRESS', 'rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ') },
    { id: 'W6', role: 'GRANTS', address: addr(env, 'W6_ADDRESS', 'rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf') },
    { id: 'BUYER', role: 'affiliate', address: addr(env, 'BUYER_ADDRESS', 'rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth') },
    { id: 'STRANGER', role: 'inbound', address: addr(env, 'STRANGER_ADDRESS', 'rh4c6qMMyafccZrPFCPCN742BNMXfjKYss') },
    { id: 'AMM', role: 'pool', address: AMM },
  ];

  const client = await hosts.openClient(hosts.resolveWs(process.env));

  const feat = await client.request({ command: 'feature' });
  const features = feat.result.features || {};
  const batchKeys = Object.entries(features)
    .filter(([, v]) => /batch/i.test(v.name || ''))
    .map(([hash, v]) => ({ hash, ...v }));

  const ss = await client.request({ command: 'server_state' });
  const validated = ss.result.state.validated_ledger;
  const baseReserve = Number(xrpl.dropsToXrp(validated.reserve_base));
  const ownerReserve = Number(xrpl.dropsToXrp(validated.reserve_inc));

  const rows = [];
  for (const a of accounts) {
    const row = { ...a };
    try {
      const ai = await client.request({
        command: 'account_info', account: a.address, ledger_index: 'validated',
      });
      const bal = Number(xrpl.dropsToXrp(ai.result.account_data.Balance));
      const oc = ai.result.account_data.OwnerCount || 0;
      const reserve = baseReserve + oc * ownerReserve;
      row.balance_xrp = bal;
      row.owner_count = oc;
      row.reserve_xrp = reserve;
      row.spendable_xrp = Math.max(0, bal - reserve);
    } catch (e) {
      row.error = e.data?.error || e.message;
    }
    try {
      const al = await client.request({
        command: 'account_lines', account: a.address, ledger_index: 'validated',
      });
      row.aeth = 0;
      row.lp = 0;
      for (const l of al.result.lines || []) {
        if (l.currency === AETH) row.aeth = Number(l.balance);
        if ((l.currency || '').startsWith('0330E60F')) row.lp = Number(l.balance);
      }
    } catch (_) { /* ignore */ }
    try {
      const an = await client.request({
        command: 'account_nfts', account: a.address, ledger_index: 'validated',
      });
      row.nfts = (an.result.account_nfts || []).length;
    } catch (_) { row.nfts = 0; }
    rows.push(row);
  }

  let amm = null;
  try {
    const r = await client.request({
      command: 'amm_info',
      asset: { currency: AETH, issuer: W0 },
      asset2: { currency: 'XRP' },
      ledger_index: 'validated',
    });
    amm = r.result.amm;
  } catch (e) {
    amm = { error: e.data?.error || e.message };
  }

  let aethOutstanding = null;
  try {
    const gb = await client.request({
      command: 'gateway_balances', account: W0, ledger_index: 'validated',
    });
    aethOutstanding = gb.result.obligations?.[AETH] || null;
  } catch (_) { /* ignore */ }

  const corp = rows.filter((r) => /^W[0-6]$/.test(r.id));
  const testnetNav = corp.reduce((s, r) => s + (r.spendable_xrp || 0), 0);

  const out = {
    as_of: new Date().toISOString(),
    network: 'XRPL Testnet',
    ledger_index: validated.seq,
    base_reserve_xrp: baseReserve,
    owner_reserve_xrp: ownerReserve,
    batch_amendments: batchKeys,
    batch_atomic_enabled: batchKeys.some(
      (b) => /^Batch/i.test(b.name) && b.enabled && !/^TicketBatch$/i.test(b.name),
    ),
    testnet_nav_xrp: Number(testnetNav.toFixed(6)),
    aeth_outstanding: aethOutstanding,
    accounts: rows.map((r) => ({
      id: r.id,
      role: r.role,
      address: r.address,
      balance_xrp: r.balance_xrp,
      spendable_xrp: r.spendable_xrp,
      owner_count: r.owner_count,
      aeth: r.aeth,
      lp: r.lp,
      nfts: r.nfts,
      error: r.error,
    })),
    amm: amm && !amm.error
      ? {
          account: amm.account,
          pool_aeth: amm.amount?.value,
          pool_xrp: amm.amount2 ? Number(xrpl.dropsToXrp(amm.amount2)) : null,
          lp_token: amm.lp_token,
          trading_fee: amm.trading_fee,
          spot_xrp_per_aeth:
            amm.amount2 && amm.amount?.value
              ? Number(xrpl.dropsToXrp(amm.amount2)) / Number(amm.amount.value)
              : null,
        }
      : amm,
  };

  console.log(JSON.stringify(out, null, 2));
  await client.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
