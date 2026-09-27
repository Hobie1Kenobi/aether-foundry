'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pub = require('./walk-in-public');
const watch = require('./walk-in-remint-watch');
const storefront = require('./walk-in-storefront-v2');

const ROOT = path.resolve(__dirname, '..');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walk-in-watch-'));
}

function writeResults(root, extra = '') {
  const file = path.join(root, 'machines', 'walk-in-window', 'RESULTS.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `# Machine: walk-in-window — RESULTS

| Field | Value |
|-------|-------|
| NFTokenID | \`${pub.KNOWN_NFTOKEN_ID}\` |
| OfferID | \`${pub.KNOWN_OFFER_ID}\` |
${extra}`
  );
}

function jsonResponse(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { result };
    },
  };
}

describe('walk-in public anchors', () => {
  it('URI hex round-trips the INBOUND raw URL', () => {
    const hex = pub.toHexUri(pub.INBOUND_URI);
    assert.equal(Buffer.from(hex, 'hex').toString('utf8'), pub.INBOUND_URI);
    assert.equal(hex, hex.toUpperCase());
    assert.match(hex, /^68747470733A2F2F/);
  });

  it('refuses mainnet and non-testnet RPC urls', () => {
    assert.throws(() => pub.assertTestnetUrl('https://s1.ripple.com:51234'));
    assert.throws(() => pub.assertTestnetUrl('https://xrplcluster.com'));
    assert.throws(() => pub.assertTestnetUrl('https://s.altnet.rippletest.net.evil.com'));
    assert.equal(
      pub.assertTestnetUrl('https://s.altnet.rippletest.net:51234'),
      'https://s.altnet.rippletest.net:51234'
    );
  });

  it('keeps only Flags bit 1 sell offers', () => {
    const offers = pub.sellOffersFromObjects([
      { index: 'AA', NFTokenID: 'BB', Flags: 0, Amount: '1' },
      {
        index: pub.KNOWN_OFFER_ID.toLowerCase(),
        NFTokenID: pub.KNOWN_NFTOKEN_ID,
        Flags: 1,
        Amount: '10000000',
        Owner: pub.W2,
      },
    ]);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].offerId, pub.KNOWN_OFFER_ID);
    assert.equal(offers[0].amount, '10000000');
  });
});

describe('walk-in watcher', () => {
  it('reads the latest OfferID and NFTokenID from RESULTS', () => {
    const laterOffer = 'B'.repeat(64);
    const laterNft = 'C'.repeat(64);
    const known = watch.lastKnownFromResults(`
| NFTokenID | \`${pub.KNOWN_NFTOKEN_ID}\` |
| OfferID | \`${pub.KNOWN_OFFER_ID}\` |
| Sell offer ID | \`6AFBC9E248A4F4178D533AD09EAA309954561ED21E2BD007385108BD4C2CC4D4\` |
| NFTokenID | \`${laterNft}\` |
| OfferID | \`${laterOffer}\` |
`);
    assert.equal(known.offerId, laterOffer);
    assert.equal(known.nftokenId, laterNft);
  });

  it('exits 0 and writes nothing when the sell offer is OPEN', async () => {
    const root = tempRoot();
    writeResults(root);
    let called = 0;
    const code = await watch.run(['node', 'watch', '--root', root, '--quiet'], {
      fetchImpl: async () => {
        called += 1;
        return jsonResponse({
          status: 'success',
          validated: true,
          ledger_index: 21098641,
          account_objects: [
            {
              index: pub.KNOWN_OFFER_ID,
              NFTokenID: pub.KNOWN_NFTOKEN_ID,
              Flags: 1,
              Amount: '10000000',
              Owner: pub.W2,
            },
          ],
        });
      },
    });
    assert.equal(code, 0);
    assert.equal(called, 1);
    assert.equal(fs.existsSync(path.join(root, 'lab', 'remint-plans')), false);
    assert.equal(fs.existsSync(path.join(root, 'lab', 'ledger-log.jsonl')), false);
  });

  it('does not treat an RPC error as sold out', async () => {
    const root = tempRoot();
    writeResults(root);
    const code = await watch.run(['node', 'watch', '--root', root], {
      fetchImpl: async () => jsonResponse({ status: 'error', error: 'actNotFound' }, 200),
      log() {},
      error() {},
    });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(path.join(root, 'lab', 'ledger-log.jsonl')), false);
  });

  it('writes plan, ledger-log, and RESULTS on simulated sold-out, once', async () => {
    const root = tempRoot();
    writeResults(root);
    const now = new Date('2026-09-27T18:58:00Z');
    const logs = [];
    const code = await watch.run(
      ['node', 'watch', '--simulate-sold-out', '--root', root, '--quiet'],
      {
        now: () => now,
        log: (line) => logs.push(line),
        fetchImpl: async () => {
          throw new Error('simulate must not hit RPC');
        },
      }
    );
    assert.equal(code, 0);
    assert.deepEqual(logs, ['SOLD OUT plan=lab/remint-plans/walk-in-20260927-185800.json']);

    const planPath = path.join(root, 'lab', 'remint-plans', 'walk-in-20260927-185800.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.signed, false);
    assert.equal(plan.simulated, true);
    assert.equal(plan.w2, pub.W2);
    assert.equal(plan.mint.TransactionType, 'NFTokenMint');
    assert.equal(plan.mint.Account, pub.W2);
    assert.equal(plan.mint.NFTokenTaxon, 20260927);
    assert.equal(plan.mint.Flags, 8);
    assert.equal(plan.mint.TransferFee, 1000);
    assert.equal(plan.mint.URI, pub.toHexUri(pub.INBOUND_URI));
    assert.equal(plan.uri.text, pub.INBOUND_URI);
    assert.equal(plan.createOffer.TransactionType, 'NFTokenCreateOffer');
    assert.equal(plan.createOffer.Amount, '10000000');
    assert.equal(plan.createOffer.Flags, 1);
    assert.equal(Object.hasOwn(plan.createOffer, 'Destination'), false);
    assert.equal(plan.one_click, 'npm run remint:walk-in');
    assert.equal(plan.last_known.offer_id, pub.KNOWN_OFFER_ID);
    assert.equal(plan.last_known.nftoken_id, pub.KNOWN_NFTOKEN_ID);

    const jsonl = fs.readFileSync(path.join(root, 'lab', 'ledger-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(jsonl.length, 1);
    const event = JSON.parse(jsonl[0]);
    assert.equal(event.event, 'walk_in_sold_out');
    assert.equal(event.w2, pub.W2);
    assert.equal(event.offer_id, pub.KNOWN_OFFER_ID);
    assert.equal(event.nftoken_id, pub.KNOWN_NFTOKEN_ID);
    assert.equal(event.plan, 'lab/remint-plans/walk-in-20260927-185800.json');
    assert.equal(event.signed, false);

    const results = fs.readFileSync(path.join(root, 'machines', 'walk-in-window', 'RESULTS.md'), 'utf8');
    assert.match(results, /## Sold-out detection 2026-09-27T18:58:00Z/);
    assert.match(results, /Not a remint/);
    assert.match(results, /lab\/remint-plans\/walk-in-20260927-185800\.json/);

    const again = await watch.run(
      ['node', 'watch', '--simulate-sold-out', '--root', root, '--quiet'],
      { now: () => now, log: () => logs.push('again') }
    );
    assert.equal(again, 0);
    assert.equal(logs.includes('again'), false);
    const jsonlAfter = fs.readFileSync(path.join(root, 'lab', 'ledger-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(jsonlAfter.length, 1);
  });

  it('a simulated row does not hide a later live sold-out', async () => {
    const root = tempRoot();
    writeResults(root);
    await watch.run(['node', 'watch', '--simulate-sold-out', '--root', root, '--quiet'], {
      now: () => new Date('2026-09-27T18:58:00Z'),
      log() {},
    });
    const code = await watch.run(['node', 'watch', '--root', root, '--quiet'], {
      now: () => new Date('2026-09-27T19:05:00Z'),
      fetchImpl: async () =>
        jsonResponse({
          status: 'success',
          validated: true,
          ledger_index: 42,
          account_objects: [],
        }),
      log() {},
    });
    assert.equal(code, 0);
    const lines = fs
      .readFileSync(path.join(root, 'lab', 'ledger-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].simulated, true);
    assert.equal(lines[1].simulated, undefined);
    assert.equal(lines[1].ledger_index, 42);
    assert.equal(lines[1].plan, 'lab/remint-plans/walk-in-20260927-190500.json');
  });
});

describe('walk-in files stay dry-run in CI', () => {
  it('watcher source and workflow do not sign', () => {
    const watcher = fs.readFileSync(path.join(ROOT, 'src', 'walk-in-remint-watch.js'), 'utf8');
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'walk-in-remint-watch.yml'),
      'utf8'
    );
    const web = fs.readFileSync(path.join(ROOT, 'web', 'lib', 'xrpl-read.ts'), 'utf8');
    assert.doesNotMatch(watcher, /require\(['"]xrpl['"]\)/);
    assert.doesNotMatch(watcher, /fromSeed|Wallet|\.sign\(/);
    assert.doesNotMatch(workflow, /storefront-v2|W2_SEED|fromSeed|Wallet/);
    assert.match(workflow, /walk-in-remint-watch\.js/);
    assert.doesNotMatch(web, /Wallet\.sign|fromSeed/);
  });

  it('one-click script refuses CI before reading a secrets file', () => {
    const script = fs.readFileSync(path.join(ROOT, 'src', 'walk-in-storefront-v2.js'), 'utf8');
    assert.match(script, /fromSeed/);
    assert.doesNotMatch(script, /NFTokenAcceptOffer/);
    const r = spawnSync(process.execPath, ['src/walk-in-storefront-v2.js'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        CI: 'true',
        AETHER_SECRETS: '/tmp/aether-secrets-should-not-be-read.env',
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}`, /refusing to load seeds or sign in CI/);
  });

  it('refuses to mint while a sell offer is open and does not read secrets', async () => {
    let lookedForSecrets = false;
    await assert.rejects(
      () =>
        storefront.remint({
          env: { GITHUB_ACTIONS: '', CI: '', AETHER_SECRETS: '/tmp/should-not-open.env' },
          pollSellOffers: async () => ({
            ok: true,
            offers: [{ offerId: pub.KNOWN_OFFER_ID, nftokenId: pub.KNOWN_NFTOKEN_ID }],
            rpc: pub.XRPL_HTTP,
          }),
          existsSync() {
            lookedForSecrets = true;
            return true;
          },
          readFileSync() {
            throw new Error('secrets file was read');
          },
        }),
      /standing sell offer still open/
    );
    assert.equal(lookedForSecrets, false);
  });

  it('reports a missing secrets file only after the offer is gone', async () => {
    const missing = path.join(os.tmpdir(), `aether-missing-${process.pid}.env`);
    await assert.rejects(
      () =>
        storefront.remint({
          env: { GITHUB_ACTIONS: '', CI: '', AETHER_SECRETS: missing },
          pollSellOffers: async () => ({
            ok: true,
            offers: [],
            ledgerIndex: 1,
            rpc: pub.XRPL_HTTP,
          }),
          existsSync: () => false,
        }),
      /missing secrets file/
    );
  });
});
