#!/usr/bin/env node
const xrpl = require('xrpl');
const fs = require('fs');
const SECRETS = '/workspace/aether-foundry-secrets/.env';
const WS = 'wss://s.altnet.rippletest.net:51233';
const AETH = '4145544800000000000000000000000000000000';
function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
(async () => {
  const env = loadEnv(SECRETS);
  const client = new xrpl.Client(WS);
  await client.connect();
  const issuer = env.W0_ADDRESS;
  const amm = await client.request({
    command: 'amm_info',
    asset: { currency: 'XRP' },
    asset2: { currency: AETH, issuer },
  });
  const ao = await client.request({ command: 'account_offers', account: env.W1_ADDRESS, ledger_index: 'validated' });
  const bookAsk = await client.request({
    command: 'book_offers',
    taker_gets: { currency: AETH, issuer },
    taker_pays: { currency: 'XRP' },
    limit: 10,
  });
  const bookBid = await client.request({
    command: 'book_offers',
    taker_gets: { currency: 'XRP' },
    taker_pays: { currency: AETH, issuer },
    limit: 10,
  });
  const ss = await client.request({ command: 'server_state' });
  const out = {
    ledger: ss.result.state.validated_ledger.seq,
    amm: amm.result.amm,
    w1_offers: ao.result.offers,
    book_sell_aeth: bookAsk.result.offers,
    book_buy_aeth: bookBid.result.offers,
  };
  fs.writeFileSync('/tmp/books-snap.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await client.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
