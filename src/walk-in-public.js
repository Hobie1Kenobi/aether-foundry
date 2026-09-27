'use strict';

/**
 * Public Walk-In Window anchors and read-only Testnet helpers.
 * No seeds, no Wallet, no signing.
 */

const W2 = 'rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw';
const XRPL_HTTP = 'https://s.altnet.rippletest.net:51234';
const XRPL_WS = 'wss://s.altnet.rippletest.net:51233';
const TAXON = 20260927;
const TF_TRANSFERABLE = 0x00000008;
const TF_SELL_NFTOKEN = 0x00000001;
const TRANSFER_FEE = 1000;
const AMOUNT_DROPS = '10000000';
const INBOUND_URI =
  'https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/INBOUND.md';
const KNOWN_NFTOKEN_ID =
  '000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D';
const KNOWN_OFFER_ID =
  '08F7769F074C8C80C4DD6A691D2CEE3A3996458D845DA3C15F62BBAF699421B0';
const SECRETS_PATH = '/workspace/aether-foundry-secrets/.env';
const ONE_CLICK = 'npm run remint:walk-in';
const LOCAL_SCRIPT = 'node src/walk-in-storefront-v2.js';

function toHexUri(uri) {
  return Buffer.from(uri, 'utf8').toString('hex').toUpperCase();
}

function isMainnetUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === 'ripple.com' || host.endsWith('.ripple.com')) return true;
    if (host === 'xrplcluster.com' || host.endsWith('.xrplcluster.com')) return true;
    if (host === 'xrpl.ws' || host.endsWith('.xrpl.ws')) return true;
    if (host === 'xrpl.link' || host.endsWith('.xrpl.link')) return true;
    return false;
  } catch {
    return false;
  }
}

function assertTestnetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('refusing unparseable XRPL url');
  }
  if (isMainnetUrl(raw)) {
    throw new Error('refusing mainnet XRPL url');
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.rippletest.net') && host !== 'rippletest.net') {
    throw new Error('refusing non-testnet XRPL url');
  }
  return raw;
}

function sellOffersFromObjects(objects) {
  const offers = [];
  for (const obj of objects || []) {
    const flags = Number(obj.Flags || 0);
    if ((flags & TF_SELL_NFTOKEN) !== TF_SELL_NFTOKEN) continue;
    if (!obj.index || !obj.NFTokenID) continue;
    offers.push({
      offerId: String(obj.index).toUpperCase(),
      nftokenId: String(obj.NFTokenID).toUpperCase(),
      amount: obj.Amount == null ? null : obj.Amount,
      flags,
      owner: obj.Owner || null,
    });
  }
  return offers;
}

async function pollSellOffers(opts = {}) {
  const rpc = assertTestnetUrl(opts.rpc || XRPL_HTTP);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const objects = [];
  let marker;
  let ledgerIndex = null;
  try {
    for (let page = 0; page < 4; page += 1) {
      const params = {
        account: W2,
        type: 'nft_offer',
        ledger_index: 'validated',
        limit: 200,
      };
      if (marker !== undefined) params.marker = marker;
      const res = await fetchImpl(rpc, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ method: 'account_objects', params: [params] }),
        signal: AbortSignal.timeout(opts.timeoutMs || 15000),
      });
      let body;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const result = body && body.result;
      if (!res.ok || !result || result.status === 'error' || result.error) {
        const detail =
          (result && (result.error_message || result.error)) ||
          `HTTP ${res.status}`;
        return {
          ok: false,
          error: `account_objects failed: ${detail}`,
          offers: [],
          ledgerIndex: null,
          rpc,
        };
      }
      if (result.validated !== true) {
        return {
          ok: false,
          error: 'account_objects was not a validated ledger',
          offers: [],
          ledgerIndex: null,
          rpc,
        };
      }
      if (result.ledger_index != null) ledgerIndex = result.ledger_index;
      objects.push(...(result.account_objects || []));
      if (result.marker == null) {
        return {
          ok: true,
          offers: sellOffersFromObjects(objects),
          ledgerIndex,
          rpc,
        };
      }
      marker = result.marker;
    }
    return {
      ok: false,
      error: 'account_objects pagination exceeded 4 pages',
      offers: [],
      ledgerIndex: null,
      rpc,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      offers: [],
      ledgerIndex: null,
      rpc,
    };
  }
}

module.exports = {
  W2,
  XRPL_HTTP,
  XRPL_WS,
  TAXON,
  TF_TRANSFERABLE,
  TF_SELL_NFTOKEN,
  TRANSFER_FEE,
  AMOUNT_DROPS,
  INBOUND_URI,
  KNOWN_NFTOKEN_ID,
  KNOWN_OFFER_ID,
  SECRETS_PATH,
  ONE_CLICK,
  LOCAL_SCRIPT,
  toHexUri,
  isMainnetUrl,
  assertTestnetUrl,
  sellOffersFromObjects,
  pollSellOffers,
};
