"use strict";

const { coded } = require("./ledger");

const LABS_HTTP = "https://testnet.xrpl-labs.com";
const STALE_MS = 60 * 1000;
const HARD_MAX_DROPS = 10000n;

function drops(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function feeDrops(body) {
  const result = body && (body.result || body);
  const row = result && (result.drops || (result.result && result.result.drops));
  if (!row) return null;
  return drops(row.open_ledger_fee != null ? row.open_ledger_fee : row.base_fee);
}

function networkId(body) {
  const result = body && (body.result || body);
  const info = result && (result.info || (result.result && result.result.info));
  return info ? info.network_id : null;
}

function assertFresh(quote, now) {
  if (!quote || typeof quote.fee_drops !== "string" || !/^[1-9][0-9]*$/.test(quote.fee_drops)) {
    throw coded("network fee quote is missing", "FEE");
  }
  const fee = BigInt(quote.fee_drops);
  if (fee <= 0n || fee > HARD_MAX_DROPS) throw coded("network fee is outside the local bound", "FEE_CAP");
  const age = new Date(now).getTime() - new Date(quote.quoted_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > STALE_MS) throw coded("network fee quote is stale", "FEE_STALE");
  if (quote.source !== LABS_HTTP) throw coded("network fee quote is not from XRPL Labs", "FEE");
  return quote;
}

async function rpc(fetchImpl, method) {
  if (typeof fetchImpl !== "function") throw coded("network fee RPC is not configured", "FEE");
  const response = await fetchImpl(LABS_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [{}] }),
  });
  if (!response || response.ok === false) throw coded("XRPL Labs fee RPC failed", "FEE");
  return response.json();
}

async function quoteNetworkFee(options) {
  const opts = options || {};
  const now = opts.now || new Date().toISOString();
  const info = await rpc(opts.fetch, "server_info");
  const id = networkId(info);
  if (id == null || Number(id) !== 1) throw coded("fee RPC did not prove network id 1", "MAINNET");
  const fee = await rpc(opts.fetch, "fee");
  const open = feeDrops(fee);
  if (!open) throw coded("XRPL Labs fee result has no open_ledger_fee", "FEE");
  const quote = {
    fee_drops: open,
    quoted_at: now,
    source: LABS_HTTP,
    ledger_index: (fee.result && fee.result.ledger_current_index) || null,
  };
  return assertFresh(quote, now);
}

module.exports = {
  LABS_HTTP,
  STALE_MS,
  HARD_MAX_DROPS,
  feeDrops,
  assertFresh,
  quoteNetworkFee,
};
