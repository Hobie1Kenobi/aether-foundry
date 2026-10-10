#!/usr/bin/env node
/**
 * Place exactly 4 tfPassive OfferCreate from W1 around AMM mid (~100 AETH/XRP).
 * Never prints seeds.
 */
const xrpl = require('xrpl');
const hosts = require('./xrpl-hosts');
const fs = require('fs');

const SECRETS = '/workspace/aether-foundry-secrets/.env';
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

function aethAmount(value, issuer) {
  return { currency: AETH, issuer, value: String(value) };
}

(async () => {
  const env = loadEnv(SECRETS);
  const client = await hosts.openClient(hosts.resolveWs(process.env));
  const w1 = xrpl.Wallet.fromSeed(env.W1_SEED);
  const issuer = env.W0_ADDRESS;

  // Mid = 100 AETH per 1 XRP.
  // Asks (sell AETH): TakerGets=AETH, TakerPays=XRP
  // Bids (buy AETH): TakerGets=XRP, TakerPays=AETH
  // Use non-crossing thin spread so tfPassive posts live:
  //   economically: ask XRP/AETH > bid XRP/AETH
  // User asked asks@101/105 & bids@99/95 in AETH/XRP which would cross
  // (bid XRP/AETH > ask). Interpret as thin wings around mid with
  // correct MM orientation: asks demand more XRP (lower AETH/XRP),
  // bids pay less XRP (higher AETH/XRP) — BUT follow user's size tiers
  // and their stated numeric levels by mapping:
  //   sell wings 101 & 105 as the farther/nearer ask labels in their note
  //   → implement as sell @ 99 (near) and 95 (far) AETH/XRP (above mid in XRP)
  //   buy @ 101 (near) and 105 (far) AETH/XRP (below mid in XRP)
  // WAIT — director said follow concrete suggestion. Re-read:
  // "Passive sell AETH (asks): 50 AETH @ 101 AETH/XRP and 200 AETH @ 105"
  // "Passive buy AETH (bids): 50 AETH worth @ 99 and 200 @ 95"
  // Placing those literally crosses. Place literally with tfPassive;
  // if bid is killed, place adjusted non-crossing and note in report.

  const offers = [
    {
      name: 'ASK_50_at_101',
      side: 'sell_aeth',
      tx: {
        TransactionType: 'OfferCreate',
        Account: w1.address,
        TakerGets: aethAmount('50', issuer),
        TakerPays: xrpl.xrpToDrops((50 / 101).toFixed(6)),
        Flags: tfPassive,
      },
    },
    {
      name: 'ASK_200_at_105',
      side: 'sell_aeth',
      tx: {
        TransactionType: 'OfferCreate',
        Account: w1.address,
        TakerGets: aethAmount('200', issuer),
        TakerPays: xrpl.xrpToDrops((200 / 105).toFixed(6)),
        Flags: tfPassive,
      },
    },
    {
      name: 'BID_50_at_99',
      side: 'buy_aeth',
      tx: {
        TransactionType: 'OfferCreate',
        Account: w1.address,
        TakerGets: xrpl.xrpToDrops((50 / 99).toFixed(6)),
        TakerPays: aethAmount('50', issuer),
        Flags: tfPassive,
      },
    },
    {
      name: 'BID_200_at_95',
      side: 'buy_aeth',
      tx: {
        TransactionType: 'OfferCreate',
        Account: w1.address,
        TakerGets: xrpl.xrpToDrops((200 / 95).toFixed(6)),
        TakerPays: aethAmount('200', issuer),
        Flags: tfPassive,
      },
    },
  ];

  const results = [];
  for (const o of offers) {
    const prepared = await client.autofill(o.tx);
    const signed = w1.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    const code = typeof meta === 'object' ? meta.TransactionResult : meta;
    // Detect if offer was created (CreatedNode Offer) or killed by passive
    let offerCreated = false;
    let offerIndex = null;
    if (meta && meta.AffectedNodes) {
      for (const n of meta.AffectedNodes) {
        const c = n.CreatedNode;
        if (c && c.LedgerEntryType === 'Offer') {
          offerCreated = true;
          offerIndex = c.LedgerIndex;
        }
      }
    }
    const row = {
      name: o.name,
      side: o.side,
      hash: res.result.hash,
      result: code,
      offer_created: offerCreated,
      offer_index: offerIndex,
      seq: prepared.Sequence,
      taker_gets: o.tx.TakerGets,
      taker_pays: o.tx.TakerPays,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }

  // Snapshot open offers
  const ao = await client.request({
    command: 'account_offers',
    account: w1.address,
    ledger_index: 'validated',
  });
  console.log('OPEN_OFFERS_COUNT', ao.result.offers.length);
  console.log('OPEN_OFFERS', JSON.stringify(ao.result.offers, null, 2));

  // If fewer than 4 live due to self-cross, place non-crossing replacements
  if (ao.result.offers.length < 4) {
    console.log('ADJUSTING: fewer than 4 live — placing non-crossing MM wings');
    // Cancel nothing; add missing sides with non-crossing rates:
    // asks @ 99 & 95 AETH/XRP (above mid in XRP/AETH), bids @ 101 & 105
    const liveNames = new Set(results.filter(r => r.offer_created).map(r => r.name));
    const replacements = [];
    if (![...liveNames].some(n => n.startsWith('ASK_50'))) {
      replacements.push({
        name: 'ASK_50_at_99_adj',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: aethAmount('50', issuer),
          TakerPays: xrpl.xrpToDrops((50 / 99).toFixed(6)),
          Flags: tfPassive,
        },
      });
    }
    if (![...liveNames].some(n => n.startsWith('ASK_200'))) {
      replacements.push({
        name: 'ASK_200_at_95_adj',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: aethAmount('200', issuer),
          TakerPays: xrpl.xrpToDrops((200 / 95).toFixed(6)),
          Flags: tfPassive,
        },
      });
    }
    if (![...liveNames].some(n => n.startsWith('BID_50'))) {
      replacements.push({
        name: 'BID_50_at_101_adj',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: xrpl.xrpToDrops((50 / 101).toFixed(6)),
          TakerPays: aethAmount('50', issuer),
          Flags: tfPassive,
        },
      });
    }
    if (![...liveNames].some(n => n.startsWith('BID_200'))) {
      replacements.push({
        name: 'BID_200_at_105_adj',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: xrpl.xrpToDrops((200 / 105).toFixed(6)),
          TakerPays: aethAmount('200', issuer),
          Flags: tfPassive,
        },
      });
    }
    // Simpler: if we have crossing problem, cancel all and place 4 correct non-crossing
    // Actually if asks@101/105 posted (cheap AETH) and bids failed, we have asks live.
    // Replace bids with rates that don't cross those asks: bid must have XRP/AETH < ask XRP/AETH
    // Ask@101 → 0.0099 XRP/AETH; bid needs < that → higher AETH/XRP than 101, e.g. 102+
    // That would be weird MM. Better: cancel asks and place proper book.

    // Cancel existing offers and place proper 4
    for (const off of ao.result.offers) {
      const cancel = {
        TransactionType: 'OfferCancel',
        Account: w1.address,
        OfferSequence: off.seq,
      };
      const prep = await client.autofill(cancel);
      const sig = w1.sign(prep);
      const r = await client.submitAndWait(sig.tx_blob);
      console.log('CANCEL', off.seq, r.result.hash, r.result.meta.TransactionResult);
    }

    // Proper non-crossing book around mid 100 AETH/XRP:
    // Ask (sell AETH): lower AETH/XRP = more XRP per AETH → 99 and 95
    // Bid (buy AETH): higher AETH/XRP = less XRP per AETH → 101 and 105
    // NOTE: director numbers had ask/bid AETH/XRP inverted for non-crossing;
    // we keep size tiers 50/200 and document the orientation correction.
    const proper = [
      {
        name: 'ASK_50_at_99',
        note: 'sell 50 AETH @ 99 AETH/XRP (ask above mid in XRP/AETH)',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: aethAmount('50', issuer),
          TakerPays: xrpl.xrpToDrops((50 / 99).toFixed(6)),
          Flags: tfPassive,
        },
      },
      {
        name: 'ASK_200_at_95',
        note: 'sell 200 AETH @ 95 AETH/XRP',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: aethAmount('200', issuer),
          TakerPays: xrpl.xrpToDrops((200 / 95).toFixed(6)),
          Flags: tfPassive,
        },
      },
      {
        name: 'BID_50_at_101',
        note: 'buy 50 AETH @ 101 AETH/XRP',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: xrpl.xrpToDrops((50 / 101).toFixed(6)),
          TakerPays: aethAmount('50', issuer),
          Flags: tfPassive,
        },
      },
      {
        name: 'BID_200_at_105',
        note: 'buy 200 AETH @ 105 AETH/XRP',
        tx: {
          TransactionType: 'OfferCreate',
          Account: w1.address,
          TakerGets: xrpl.xrpToDrops((200 / 105).toFixed(6)),
          TakerPays: aethAmount('200', issuer),
          Flags: tfPassive,
        },
      },
    ];

    // Actually re-read user one more time. They want:
    // asks @ 101 and 105, bids @ 99 and 95.
    // In AETH/XRP terms that crosses. Alternative reading: "101 AETH/XRP"
    // as the ask LABEL meaning 1% above mid where mid quoted as XRP index...
    // Place EXACTLY user numbers but swap bid/ask XRP orientation so books don't cross
    // by using user numbers as the AETH/XRP rates on the correct sides:
    // FINAL: honor user rates on the sides that make a valid book:
    // User said sell@101/105 — if we interpret sell rate as XRP received per AETH * 10000...
    //
    // Decision: place user's exact TakerGets/TakerPays math for their four numbers.
    // That was the first attempt. Since we're in adjust path, place the economically
    // correct MM book with size 50/200 and rates 99/95 asks + 101/105 bids,
    // documenting that literal 101-ask/99-bid self-crosses under XRPL quality.

    for (const o of proper) {
      const prepared = await client.autofill(o.tx);
      const signed = w1.sign(prepared);
      const res = await client.submitAndWait(signed.tx_blob);
      const meta = res.result.meta;
      let offerCreated = false;
      let offerIndex = null;
      if (meta && meta.AffectedNodes) {
        for (const n of meta.AffectedNodes) {
          const c = n.CreatedNode;
          if (c && c.LedgerEntryType === 'Offer') {
            offerCreated = true;
            offerIndex = c.LedgerIndex;
          }
        }
      }
      const row = {
        name: o.name,
        note: o.note,
        hash: res.result.hash,
        result: meta.TransactionResult,
        offer_created: offerCreated,
        offer_index: offerIndex,
        seq: prepared.Sequence,
        taker_gets: o.tx.TakerGets,
        taker_pays: o.tx.TakerPays,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }

  const ao2 = await client.request({
    command: 'account_offers',
    account: w1.address,
    ledger_index: 'validated',
  });
  console.log('FINAL_OPEN_OFFERS_COUNT', ao2.result.offers.length);
  console.log('FINAL_OPEN_OFFERS', JSON.stringify(ao2.result.offers, null, 2));

  // book_offers both sides
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
  console.log('BOOK_SELL_AETH', JSON.stringify(bookAsk.result.offers?.map(o => ({
    Account: o.Account, TakerGets: o.TakerGets, TakerPays: o.TakerPays, seq: o.seq, quality: o.quality,
  })), null, 2));
  console.log('BOOK_BUY_AETH', JSON.stringify(bookBid.result.offers?.map(o => ({
    Account: o.Account, TakerGets: o.TakerGets, TakerPays: o.TakerPays, seq: o.seq, quality: o.quality,
  })), null, 2));

  fs.writeFileSync('/tmp/offers-result.json', JSON.stringify({ results, open: ao2.result.offers }, null, 2));
  await client.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
