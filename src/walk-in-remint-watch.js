#!/usr/bin/env node
'use strict';

/**
 * Walk-In Window remint watcher. Read-only Testnet poll.
 * Exit 0 when a W2 sell offer is OPEN. On SOLD OUT, write a dry-run
 * remint plan plus ledger-log and RESULTS lines. Never signs.
 *
 *   npm run watch:walk-in
 *   node src/walk-in-remint-watch.js [--quiet] [--simulate-sold-out --root DIR]
 */

const fs = require('fs');
const path = require('path');
const hosts = require('./xrpl-hosts');
const pub = require('./walk-in-public');

const HELP = `Usage: node src/walk-in-remint-watch.js [--quiet] [--rpc URL] [--simulate-sold-out --root DIR]

Polls W2 account_objects type=nft_offer on XRPL Testnet HTTPS.
Exit 0 when OPEN or when a dry-run sold-out plan is written.
Does not sign, accept offers, or read seeds.`;

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function parseArgs(argv) {
  const out = {
    quiet: false,
    simulate: false,
    root: null,
    rpc: null,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--simulate-sold-out') out.simulate = true;
    else if (a === '--root') {
      out.root = args[i + 1];
      i += 1;
      if (!out.root) throw new Error('--root requires a directory');
    } else if (a === '--rpc') {
      out.rpc = args[i + 1];
      i += 1;
      if (!out.rpc) throw new Error('--rpc requires a URL');
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown arg ${a}`);
  }
  return out;
}

function stampUtc(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    String(date.getUTCFullYear()) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    '-' +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds())
  );
}

function lastKnownFromResults(text) {
  const body = text || '';
  const offerIds = [...body.matchAll(/^\| OfferID \| `([A-Fa-f0-9]{64})` \|/gm)].map(
    (m) => m[1].toUpperCase()
  );
  const nftIds = [...body.matchAll(/^\| NFTokenID \| `([A-Fa-f0-9]{64})` \|/gm)].map(
    (m) => m[1].toUpperCase()
  );
  return {
    offerId: offerIds.length ? offerIds[offerIds.length - 1] : pub.KNOWN_OFFER_ID,
    nftokenId: nftIds.length ? nftIds[nftIds.length - 1] : pub.KNOWN_NFTOKEN_ID,
  };
}

function readLastKnown(root) {
  const file = path.join(root, 'machines', 'walk-in-window', 'RESULTS.md');
  if (!fs.existsSync(file)) {
    return lastKnownFromResults('');
  }
  return lastKnownFromResults(fs.readFileSync(file, 'utf8'));
}

function eachJsonl(text, fn) {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      fn(JSON.parse(trimmed));
    } catch {
      /* skip malformed history */
    }
  }
}

function alreadyRecorded(jsonlText, offerId, simulated) {
  if (!offerId) return false;
  let found = false;
  eachJsonl(jsonlText, (row) => {
    if (found) return;
    if (row.event !== 'walk_in_sold_out' && row.action !== 'walk_in_sold_out') return;
    if (String(row.offer_id || '').toUpperCase() !== offerId.toUpperCase()) return;
    const rowSim = Boolean(row.simulated);
    if (simulated ? rowSim : !rowSim) found = true;
  });
  return found;
}

function buildPlan(info) {
  const uriHex = pub.toHexUri(pub.INBOUND_URI);
  return {
    machine: 'walk-in-window',
    network: 'XRPL Testnet',
    mode: 'dry-run',
    signed: false,
    simulated: Boolean(info.simulated),
    detected_at: info.detectedAt,
    rpc: info.rpc,
    ledger_index: info.ledgerIndex == null ? null : info.ledgerIndex,
    w2: pub.W2,
    last_known: {
      nftoken_id: info.nftokenId,
      offer_id: info.offerId,
      amount_drops: pub.AMOUNT_DROPS,
    },
    uri: {
      text: pub.INBOUND_URI,
      hex: uriHex,
    },
    mint: {
      TransactionType: 'NFTokenMint',
      Account: pub.W2,
      NFTokenTaxon: pub.TAXON,
      Flags: pub.TF_TRANSFERABLE,
      TransferFee: pub.TRANSFER_FEE,
      URI: uriHex,
    },
    createOffer: {
      TransactionType: 'NFTokenCreateOffer',
      Account: pub.W2,
      NFTokenID: '<NFTokenID from NFTokenMint>',
      Amount: pub.AMOUNT_DROPS,
      Flags: pub.TF_SELL_NFTOKEN,
    },
    one_click: pub.ONE_CLICK,
    local_script: pub.LOCAL_SCRIPT,
    secrets: `AETHER_SECRETS or ${pub.SECRETS_PATH}`,
    notes: [
      'Dry-run only. This file is not a signed transaction.',
      'Do not set Destination on NFTokenCreateOffer.',
      'Do not submit NFTokenAcceptOffer from any Foundry wallet.',
      'Run the one-click locally. GitHub Actions must not load seeds or sign.',
      'Leave the new sell offer open. The desk reads account_objects and shows OPEN.',
    ],
  };
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

function planFileName(root, stamp) {
  const dir = path.join(root, 'lab', 'remint-plans');
  fs.mkdirSync(dir, { recursive: true });
  let name = `walk-in-${stamp}.json`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = `walk-in-${stamp}-${n}.json`;
    n += 1;
  }
  return `lab/remint-plans/${name}`;
}

function recordSoldOut(root, info) {
  const when = info.now || new Date();
  const detectedAt = when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const rel = planFileName(root, stampUtc(when));
  const plan = buildPlan({
    simulated: info.simulated,
    detectedAt,
    rpc: info.rpc,
    ledgerIndex: info.ledgerIndex,
    nftokenId: info.nftokenId,
    offerId: info.offerId,
  });
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, `${JSON.stringify(plan, null, 2)}\n`);

  const event = {
    ts: detectedAt,
    event: 'walk_in_sold_out',
    action: 'walk_in_sold_out',
    network: 'XRPL Testnet',
    w2: pub.W2,
    offer_id: info.offerId,
    nftoken_id: info.nftokenId,
    plan: rel,
    rpc: info.rpc,
    ledger_index: info.ledgerIndex == null ? null : info.ledgerIndex,
    signed: false,
  };
  if (info.simulated) event.simulated = true;
  appendText(path.join(root, 'lab', 'ledger-log.jsonl'), `${JSON.stringify(event)}\n`);

  const results = path.join(root, 'machines', 'walk-in-window', 'RESULTS.md');
  const simNote = info.simulated ? ' Simulated detection (not a live sale).' : '';
  const section = `
## Sold-out detection ${detectedAt}

Standing W2 sell offer is gone (\`account_objects\` \`type: nft_offer\`, no Flags bit 1). Last known OfferID \`${info.offerId}\`, NFTokenID \`${info.nftokenId}\`. Dry-run plan: \`${rel}\`. Not a remint.${simNote} Founder: \`${pub.ONE_CLICK}\`.
`;
  if (!fs.existsSync(results)) {
    appendText(
      results,
      `# Machine: walk-in-window — RESULTS\n\n**Network:** XRPL Testnet\n${section}`
    );
  } else {
    appendText(results, section);
  }
  return rel;
}

async function run(argv, io = {}) {
  const log = io.log || console.log;
  const error = io.error || console.error;
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    error(e.message || String(e));
    return 1;
  }
  if (args.help) {
    log(HELP);
    return 0;
  }
  if (args.simulate && !args.root) {
    error('--simulate-sold-out requires --root so a live OPEN listing is not marked sold');
    return 1;
  }

  const root = path.resolve(args.root || repoRoot());
  const env = io.env || process.env;
  let rpc = pub.XRPL_HTTP;
  try {
    const selected = args.rpc || hosts.resolveHttp(env);
    rpc = pub.assertTestnetUrl(selected);
  } catch (e) {
    error(e.message || String(e));
    return 1;
  }

  let ledgerIndex = null;
  if (!args.simulate) {
    const snap = await pub.pollSellOffers({
      rpc,
      fetchImpl: io.fetchImpl,
    });
    if (!snap.ok) {
      error(snap.error || 'account_objects failed');
      return 1;
    }
    if (snap.offers.length > 0) {
      if (!args.quiet) {
        const first = snap.offers[0];
        log(
          `OPEN w2=${pub.W2} offers=${snap.offers.length} offer=${first.offerId} nft=${first.nftokenId}`
        );
      }
      return 0;
    }
    ledgerIndex = snap.ledgerIndex;
    rpc = snap.rpc;
  }

  const known = readLastKnown(root);
  const jsonlPath = path.join(root, 'lab', 'ledger-log.jsonl');
  const jsonlText = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, 'utf8') : '';
  if (alreadyRecorded(jsonlText, known.offerId, args.simulate)) {
    if (!args.quiet) {
      log(`SOLD OUT already recorded offer=${known.offerId}`);
    }
    return 0;
  }

  const rel = recordSoldOut(root, {
    simulated: args.simulate,
    now: io.now ? io.now() : new Date(),
    rpc,
    ledgerIndex,
    nftokenId: known.nftokenId,
    offerId: known.offerId,
  });
  log(`SOLD OUT plan=${rel}`);
  return 0;
}

module.exports = {
  HELP,
  parseArgs,
  stampUtc,
  lastKnownFromResults,
  alreadyRecorded,
  buildPlan,
  recordSoldOut,
  run,
};

if (require.main === module) {
  run(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      console.error(e.message || e);
      process.exit(1);
    });
}
