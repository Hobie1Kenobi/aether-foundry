#!/usr/bin/env node
/** Cancel W1 offers and place exactly 4 non-crossing tfPassive offers. */
const xrpl = require('xrpl');
const fs = require('fs');
const SECRETS = '/workspace/aether-foundry-secrets/.env';
const WS = 'wss://s.altnet.rippletest.net:51233';
const AETH = '4145544800000000000000000000000000000000';
const tfPassive = 0x00010000;

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
  const w1 = xrpl.Wallet.fromSeed(env.W1_SEED);
  const issuer = env.W0_ADDRESS;

  // Cancel all open
  const ao = await client.request({ command: 'account_offers', account: w1.address, ledger_index: 'validated' });
  for (const off of ao.result.offers) {
    const cancel = { TransactionType: 'OfferCancel', Account: w1.address, OfferSequence: off.seq };
    const prep = await client.autofill(cancel);
    const sig = w1.sign(prep);
    const r = await client.submitAndWait(sig.tx_blob);
    console.log('CANCEL', off.seq, r.result.hash, r.result.meta.TransactionResult);
  }

  // Non-crossing book around mid 100 AETH/XRP (= 0.01 XRP/AETH):
  // Asks (sell AETH): demand MORE XRP → fewer AETH per XRP: 99 and 95
  // Bids (buy AETH): pay LESS XRP → more AETH per XRP: 101 and 105
  // Use drop amounts computed carefully; place ASKS first then BIDS.
  // Size tiers 50 and 200 as directed.
  //
  // Director's numeric labels (ask@101/105, bid@99/95) self-cross under
  // XRPL quality; we keep size tiers and use correct MM orientation.

  function aeth(v) { return { currency: AETH, issuer, value: String(v) }; }

  // Exact: XRP drops = floor(aeth_amount / rate * 1e6)
  const specs = [
    // ASK 50 @ 99 AETH/XRP: taker pays 50/99 XRP gets 50 AETH
    { name: 'ASK_50@99', TakerGets: aeth(50), TakerPays: String(Math.floor((50 / 99) * 1e6)) },
    // ASK 200 @ 95
    { name: 'ASK_200@95', TakerGets: aeth(200), TakerPays: String(Math.floor((200 / 95) * 1e6)) },
    // BID 50 @ 101: taker pays 50 AETH gets 50/101 XRP
    { name: 'BID_50@101', TakerGets: String(Math.floor((50 / 101) * 1e6)), TakerPays: aeth(50) },
    // BID 200 @ 105
    { name: 'BID_200@105', TakerGets: String(Math.floor((200 / 105) * 1e6)), TakerPays: aeth(200) },
  ];

  const results = [];
  for (const s of specs) {
    const tx = {
      TransactionType: 'OfferCreate',
      Account: w1.address,
      TakerGets: s.TakerGets,
      TakerPays: s.TakerPays,
      Flags: tfPassive,
    };
    const prepared = await client.autofill(tx);
    const signed = w1.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    let offerCreated = false, offerIndex = null, consumed = false;
    for (const n of meta.AffectedNodes || []) {
      if (n.CreatedNode?.LedgerEntryType === 'Offer') {
        offerCreated = true;
        offerIndex = n.CreatedNode.LedgerIndex;
      }
      if (n.DeletedNode?.LedgerEntryType === 'Offer' || n.ModifiedNode?.LedgerEntryType === 'Offer') {
        consumed = true;
      }
    }
    const row = {
      name: s.name,
      hash: res.result.hash,
      result: meta.TransactionResult,
      offer_created: offerCreated,
      offer_index: offerIndex,
      seq: prepared.Sequence,
      TakerGets: s.TakerGets,
      TakerPays: s.TakerPays,
      consumed_something: consumed,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }

  const ao2 = await client.request({ command: 'account_offers', account: w1.address, ledger_index: 'validated' });
  console.log('LIVE_COUNT', ao2.result.offers.length);
  console.log(JSON.stringify(ao2.result.offers, null, 2));

  // If still < 4, try wider spread
  if (ao2.result.offers.length < 4) {
    console.log('WIDENING spread');
    for (const off of ao2.result.offers) {
      const cancel = { TransactionType: 'OfferCancel', Account: w1.address, OfferSequence: off.seq };
      const prep = await client.autofill(cancel);
      const sig = w1.sign(prep);
      await client.submitAndWait(sig.tx_blob);
    }
    // Mid 0.01 XRP/AETH. Ask at 0.0105 and 0.0110; Bid at 0.0095 and 0.0090
    // = AETH/XRP rates: ask 1/0.0105≈95.24, 1/0.011≈90.91; bid 1/0.0095≈105.26, 1/0.009≈111.11
    const wide = [
      { name: 'ASK_50@0.0105', TakerGets: aeth(50), TakerPays: xrpl.xrpToDrops('0.525') },      // 50*0.0105
      { name: 'ASK_200@0.0110', TakerGets: aeth(200), TakerPays: xrpl.xrpToDrops('2.2') },
      { name: 'BID_50@0.0095', TakerGets: xrpl.xrpToDrops('0.475'), TakerPays: aeth(50) },
      { name: 'BID_200@0.0090', TakerGets: xrpl.xrpToDrops('1.8'), TakerPays: aeth(200) },
    ];
    for (const s of wide) {
      const tx = {
        TransactionType: 'OfferCreate',
        Account: w1.address,
        TakerGets: s.TakerGets,
        TakerPays: s.TakerPays,
        Flags: tfPassive,
      };
      const prepared = await client.autofill(tx);
      const signed = w1.sign(prepared);
      const res = await client.submitAndWait(signed.tx_blob);
      const meta = res.result.meta;
      let offerCreated = false, offerIndex = null;
      for (const n of meta.AffectedNodes || []) {
        if (n.CreatedNode?.LedgerEntryType === 'Offer') {
          offerCreated = true;
          offerIndex = n.CreatedNode.LedgerIndex;
        }
      }
      const row = {
        name: s.name, hash: res.result.hash, result: meta.TransactionResult,
        offer_created: offerCreated, offer_index: offerIndex, seq: prepared.Sequence,
        TakerGets: s.TakerGets, TakerPays: s.TakerPays,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }

  const ao3 = await client.request({ command: 'account_offers', account: w1.address, ledger_index: 'validated' });
  console.log('FINAL_LIVE_COUNT', ao3.result.offers.length);
  console.log(JSON.stringify(ao3.result.offers, null, 2));

  // Check AETH + XRP balances
  const ai = await client.request({ command: 'account_info', account: w1.address, ledger_index: 'validated' });
  const lines = await client.request({ command: 'account_lines', account: w1.address, ledger_index: 'validated' });
  console.log('W1_XRP', xrpl.dropsToXrp(ai.result.account_data.Balance), 'OC', ai.result.account_data.OwnerCount);
  console.log('W1_LINES', JSON.stringify(lines.result.lines.map(l => ({ c: l.currency, b: l.balance, a: l.account }))));

  fs.writeFileSync('/tmp/offers-clean.json', JSON.stringify({ results, open: ao3.result.offers }, null, 2));
  await client.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
